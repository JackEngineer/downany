"""Strict yt-dlp staging downloader with structured output facts."""
from __future__ import annotations

import os
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Any, Dict, Optional

import yt_dlp

from src.core.download_task import VideoInfo
from src.core.error_codes import OutputVerificationFailed
from src.core.http_headers import DEFAULT_HTTP_HEADERS
from src.core.output_contract import OutputPlan, SubtitleMode
from src.core.output_paths import safe_component, stable_source_key
from src.core.twitter_fallback import extract_tweet_id, is_twitter_url, resolve_twitter_media
from src.core.ytdlp_cookies import apply_cookiefile_from_headers, cleanup_cookiefile
from src.core.ytdlp_opts import REMOTE_COMPONENTS, resolve_js_runtimes
from src.sidecar.bin_paths import MediaToolchain
from src.utils.logger import setup_logger

logger = setup_logger("CoreDownloader")

_TRANSIENT_NETWORK_MARKERS = (
    "timed out",
    "transporterror",
    "connection reset",
    "temporarily unavailable",
    "network is unreachable",
    "http error 403",
    "http error 429",
    "http error 5",
)
_PLACEHOLDER_TITLES = frozenset({"", "正在获取信息...", "未命名视频", "unknown"})
_SAFE_OUTPUT_FAILURE = "成品无法验证，请导出诊断后重试"


@dataclass(frozen=True)
class SubtitleArtifact:
    path: Path
    language: str
    extension: str


@dataclass(frozen=True)
class SourceFacts:
    selected_subtitle_languages: tuple[str, ...]
    missing_requested_subtitles: bool
    thumbnail_available: bool
    chapters_available: bool
    title_available: bool


@dataclass(frozen=True)
class DownloadResult:
    main_file: Path
    subtitles: tuple[SubtitleArtifact, ...]
    info: Mapping[str, Any]
    rendered_leaf: str
    source_key: str
    downloaded_this_run: bool
    source_facts: SourceFacts


def _is_retryable_youtube_network_error(url: str, exc: Exception) -> bool:
    """Only rebuild one YouTube session for recognized transient failures."""
    host = (url or "").lower()
    if "youtube.com" not in host and "youtu.be" not in host:
        return False
    message = str(exc).lower()
    return any(marker in message for marker in _TRANSIENT_NETWORK_MARKERS)


def _output_failure(detail: str) -> OutputVerificationFailed:
    logger.error("暂存成品合同失败: %s", detail)
    return OutputVerificationFailed(_SAFE_OUTPUT_FAILURE)


class _YtDlpQuietLogger:
    """Route yt-dlp diagnostics to stderr without polluting Sidecar stdout."""

    def debug(self, msg: str) -> None:
        if msg.startswith("[debug] "):
            return
        logger.debug("%s", msg)

    def info(self, msg: str) -> None:
        logger.info("%s", msg)

    def warning(self, msg: str) -> None:
        logger.warning("%s", msg)

    def error(self, msg: str) -> None:
        logger.error("%s", msg)


class DownloadCancelled(Exception):
    """The user cancelled or paused the active download."""


class DownloadError(Exception):
    """The transfer or extractor failed."""


def _resolved_staging_directory(staging_dir: Path) -> Path:
    try:
        staging = Path(staging_dir).expanduser()
        staging.mkdir(parents=True, exist_ok=True)
        staging = staging.resolve(strict=True)
        if not staging.is_dir():
            raise OSError("staging path is not a directory")
        return staging
    except (OSError, RuntimeError, ValueError) as exc:
        raise _output_failure(f"暂存目录不可用: {exc}") from exc


def _existing_stage_files(staging: Path) -> frozenset[Path]:
    existing: set[Path] = set()
    try:
        for path in staging.rglob("*"):
            try:
                if path.is_file():
                    existing.add(path.resolve(strict=True))
            except (OSError, RuntimeError):
                continue
    except OSError:
        return frozenset()
    return frozenset(existing)


def _inside_staging(path: Path, staging: Path) -> bool:
    try:
        return path.is_relative_to(staging)
    except (AttributeError, ValueError):
        try:
            return os.path.commonpath([str(staging), str(path)]) == str(staging)
        except ValueError:
            return False


def _strict_main_file(raw_path: object, staging: Path) -> Path:
    if not isinstance(raw_path, (str, os.PathLike)) or not str(raw_path).strip():
        raise _output_failure("info.filepath 缺失")
    try:
        path = Path(raw_path).expanduser().resolve(strict=False)
    except (OSError, RuntimeError, ValueError, TypeError) as exc:
        raise _output_failure(f"info.filepath 无法解析: {exc}") from exc
    if not _inside_staging(path, staging):
        raise _output_failure(f"主文件超出暂存目录: {path}")
    try:
        if not path.is_file() or path.stat().st_size <= 0:
            raise _output_failure(f"主文件不存在、不是普通文件或为空: {path}")
    except OutputVerificationFailed:
        raise
    except OSError as exc:
        raise _output_failure(f"主文件无法读取: {path}: {exc}") from exc
    return path


def _postprocessed_info(info: dict[str, Any]) -> dict[str, Any]:
    """Normalize yt-dlp's one-item postprocessed result without trusting fragments."""
    raw_path = info.get("filepath")
    if isinstance(raw_path, (str, os.PathLike)) and str(raw_path).strip():
        return info

    requested = info.get("requested_downloads")
    if not isinstance(requested, (list, tuple)) or len(requested) != 1:
        raise _output_failure("yt-dlp 未返回唯一的后处理下载记录")
    record = requested[0]
    if not isinstance(record, Mapping):
        raise _output_failure("yt-dlp 后处理下载记录无效")
    raw_path = record.get("filepath")
    if not isinstance(raw_path, (str, os.PathLike)) or not str(raw_path).strip():
        raise _output_failure("yt-dlp 后处理下载记录缺少 filepath")
    try:
        leaf = Path(raw_path).name
        parsed_leaf = Path(leaf)
    except (OSError, RuntimeError, ValueError, TypeError) as exc:
        raise _output_failure(f"yt-dlp 后处理路径无法解析: {exc}") from exc
    if parsed_leaf.stem != "media" or not parsed_leaf.suffix:
        raise _output_failure("yt-dlp 后处理路径不是最终暂存成品")

    normalized = dict(info)
    normalized["filepath"] = raw_path
    record_ext = str(record.get("ext") or "").strip()
    if record_ext:
        normalized["ext"] = record_ext
    return normalized


def _subtitle_candidate(raw_path: object, staging: Path) -> Optional[Path]:
    if not isinstance(raw_path, (str, os.PathLike)) or not str(raw_path).strip():
        return None
    try:
        path = Path(raw_path).expanduser().resolve(strict=False)
    except (OSError, RuntimeError, ValueError, TypeError) as exc:
        raise _output_failure(f"字幕路径无法解析: {exc}") from exc
    if not _inside_staging(path, staging):
        raise _output_failure(f"字幕文件超出暂存目录: {path}")
    try:
        if not path.exists():
            return None
        if not path.is_file() or path.stat().st_size <= 0:
            raise _output_failure(f"字幕文件不是普通非空文件: {path}")
    except OutputVerificationFailed:
        raise
    except OSError as exc:
        raise _output_failure(f"字幕文件无法读取: {path}: {exc}") from exc
    return path


def _normalized_language(key: object, entry: Mapping[str, Any]) -> str:
    raw = str(key or "").strip() or str(entry.get("name") or "").strip()
    return raw.replace("_", "-")


def _language_key(value: object) -> str:
    primary = str(value or "").strip().replace("_", "-").casefold().split("-", 1)[0]
    return {
        "eng": "en",
        "zho": "zh",
        "chi": "zh",
    }.get(primary, primary)


def _thumbnail_available(info: Mapping[str, Any]) -> bool:
    if str(info.get("thumbnail") or "").strip():
        return True
    thumbnails = info.get("thumbnails")
    if not isinstance(thumbnails, list):
        return False
    for item in thumbnails:
        if isinstance(item, Mapping) and str(item.get("url") or "").strip():
            return True
        if isinstance(item, str) and item.strip():
            return True
    return False


def _subtitle_outputs_and_facts(
    info: Mapping[str, Any],
    plan: OutputPlan,
    staging: Path,
) -> tuple[tuple[SubtitleArtifact, ...], tuple[str, ...], bool]:
    if plan.subtitle_mode is SubtitleMode.NONE:
        return (), (), False

    requested = info.get("requested_subtitles")
    if not isinstance(requested, Mapping):
        return (), (), True

    retain_external = plan.subtitle_mode in {
        SubtitleMode.EXTERNAL,
        SubtitleMode.BOTH,
    }
    embedded_request = plan.subtitle_mode in {
        SubtitleMode.EMBEDDED,
        SubtitleMode.BOTH,
    }
    artifacts: list[SubtitleArtifact] = []
    selected: list[str] = []
    selected_seen: set[str] = set()
    artifact_seen: set[Path] = set()
    for key, raw_entry in requested.items():
        if not isinstance(raw_entry, Mapping):
            continue
        language = _normalized_language(key, raw_entry)
        candidate = (
            _subtitle_candidate(raw_entry.get("filepath"), staging)
            if retain_external
            else None
        )
        if language and (candidate is not None or embedded_request):
            normalized_key = language.casefold()
            if normalized_key not in selected_seen:
                selected_seen.add(normalized_key)
                selected.append(language)
        if candidate is None or candidate in artifact_seen:
            continue
        extension = candidate.suffix.lstrip(".").casefold()
        if not extension:
            raise _output_failure(f"字幕文件缺少扩展名: {candidate}")
        artifact_seen.add(candidate)
        artifacts.append(
            SubtitleArtifact(
                path=candidate,
                language=language or "und",
                extension=extension,
            )
        )

    if plan.requested_subtitle_languages:
        selected_keys = {_language_key(item) for item in selected}
        missing_requested = not any(
            _language_key(item) in selected_keys
            for item in plan.requested_subtitle_languages
        )
    else:
        missing_requested = not selected
    return tuple(artifacts), tuple(selected), missing_requested


def _merge_fallback_info(info: object, fallback: VideoInfo) -> object:
    if not isinstance(info, dict):
        return info
    merged = dict(info)
    if str(fallback.title or "").strip():
        merged["title"] = fallback.title
    if str(fallback.thumbnail_url or "").strip():
        merged["thumbnail"] = fallback.thumbnail_url
    if str(fallback.uploader or "").strip():
        merged["uploader"] = fallback.uploader
    if int(fallback.duration or 0) > 0:
        merged["duration"] = int(fallback.duration)
    if fallback.platform.value != "unknown":
        merged["extractor"] = fallback.platform.value
    source_id = extract_tweet_id(fallback.url)
    if source_id:
        merged["id"] = source_id
    return merged


class Downloader:
    """Run one yt-dlp session inside a task-owned staging directory."""

    def __init__(
        self,
        download_dir: Optional[str] = None,
        *,
        ydl_factory: Callable[[dict[str, Any]], Any] = yt_dlp.YoutubeDL,
    ):
        self.download_dir = download_dir
        self.ydl_factory = ydl_factory
        self.progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None
        self.finished_callback: Optional[Callable[[], None]] = None
        self.error_callback: Optional[Callable[[str], None]] = None
        self.last_filename = ""
        self.last_info: Optional[VideoInfo] = None
        self.last_ydl_info: Optional[Dict[str, Any]] = None
        self._observed_transfer = False

    def set_callbacks(
        self,
        progress: Optional[Callable] = None,
        finished: Optional[Callable] = None,
        error: Optional[Callable] = None,
    ) -> None:
        self.progress_callback = progress
        self.finished_callback = finished
        self.error_callback = error

    def _progress_hook(self, data: Dict[str, Any]) -> None:
        status = data.get("status")
        if status in {"downloading", "finished"}:
            self._observed_transfer = True
        if status == "downloading":
            filename = data.get("filename") or data.get("tmpfilename")
            if filename:
                self.last_filename = str(filename)
            if self.progress_callback:
                self.progress_callback(data)
        elif status == "finished":
            filename = data.get("filename")
            if filename:
                self.last_filename = str(filename)
            logger.info("传输阶段完成: %s", filename)

    def _ydl_options(
        self,
        plan: OutputPlan,
        toolchain: MediaToolchain,
        staging: Path,
    ) -> dict[str, Any]:
        options = plan.to_ydl_options()
        planned_headers = options.get("http_headers")
        options["http_headers"] = {
            **DEFAULT_HTTP_HEADERS,
            **(dict(planned_headers) if isinstance(planned_headers, Mapping) else {}),
        }
        options.update(
            {
                "outtmpl": str(staging / "media.%(ext)s"),
                "paths": {"home": str(staging), "temp": str(staging)},
                "progress_hooks": [self._progress_hook],
                "noplaylist": True,
                "no_color": True,
                "quiet": True,
                "no_warnings": True,
                "noprogress": True,
                "logger": _YtDlpQuietLogger(),
                "socket_timeout": 15,
                "retries": 2,
                "extractor_retries": 2,
                "remote_components": REMOTE_COMPONENTS,
                "js_runtimes": resolve_js_runtimes(),
            }
        )
        options.pop("ffmpeg_location", None)
        if toolchain.ffmpeg_location is not None:
            options["ffmpeg_location"] = str(toolchain.ffmpeg_location.resolve())
        return options

    def _render_source_key(
        self,
        ydl: Any,
        info: Dict[str, Any],
        plan: OutputPlan,
        url: str,
    ) -> str:
        if "%(" in plan.source_key_template:
            rendered = ydl.evaluate_outtmpl(
                plan.source_key_template,
                info,
                sanitize=True,
            )
        else:
            rendered = plan.source_key_template
        return safe_component(
            str(rendered or ""),
            fallback=stable_source_key(url),
            max_units=81,
        )

    def _result_from_info(
        self,
        ydl: Any,
        info: object,
        plan: OutputPlan,
        url: str,
        staging: Path,
        preexisting_files: frozenset[Path],
    ) -> DownloadResult:
        if not isinstance(info, dict):
            raise _output_failure("yt-dlp 未返回单条媒体信息")
        info = _postprocessed_info(info)
        self.last_ydl_info = info
        main_file = _strict_main_file(info.get("filepath"), staging)
        rendered_leaf = str(
            ydl.evaluate_outtmpl(
                plan.final_leaf_template,
                info,
                sanitize=True,
            )
            or ""
        ).strip()
        if not rendered_leaf:
            raise _output_failure("最终文件名无法渲染")
        source_key = self._render_source_key(ydl, info, plan, url)
        subtitles, selected_languages, missing_subtitles = _subtitle_outputs_and_facts(
            info,
            plan,
            staging,
        )
        title = str(info.get("title") or "").strip()
        chapters = info.get("chapters")
        source_facts = SourceFacts(
            selected_subtitle_languages=selected_languages,
            missing_requested_subtitles=missing_subtitles,
            thumbnail_available=_thumbnail_available(info),
            chapters_available=isinstance(chapters, list) and bool(chapters),
            title_available=title.casefold() not in {
                item.casefold() for item in _PLACEHOLDER_TITLES
            },
        )
        return DownloadResult(
            main_file=main_file,
            subtitles=subtitles,
            info=MappingProxyType(dict(info)),
            rendered_leaf=rendered_leaf,
            source_key=source_key,
            downloaded_this_run=(
                self._observed_transfer or main_file not in preexisting_files
            ),
            source_facts=source_facts,
        )

    def _download_with_ydl(
        self,
        url: str,
        ydl_options: dict[str, Any],
        plan: OutputPlan,
        staging: Path,
        preexisting_files: frozenset[Path],
        *,
        source_url: Optional[str] = None,
        metadata_fallback: Optional[VideoInfo] = None,
    ) -> DownloadResult:
        for attempt in range(2):
            try:
                with self.ydl_factory(ydl_options) as ydl:
                    info = ydl.extract_info(url, download=True)
                    if metadata_fallback is not None:
                        info = _merge_fallback_info(info, metadata_fallback)
                    return self._result_from_info(
                        ydl,
                        info,
                        plan,
                        source_url or url,
                        staging,
                        preexisting_files,
                    )
            except Exception as exc:
                if attempt == 0 and _is_retryable_youtube_network_error(url, exc):
                    logger.warning("YouTube 媒体地址暂时失效，正在重新解析并续传一次")
                    continue
                raise
        raise DownloadError("download attempts exhausted")

    def download(
        self,
        url: str,
        plan: OutputPlan,
        *,
        toolchain: MediaToolchain,
        staging_dir: Path,
    ) -> DownloadResult:
        """Download into staging and return only postprocessed output facts."""
        cookie_path: Optional[str] = None
        try:
            staging = _resolved_staging_directory(staging_dir)
            preexisting_files = _existing_stage_files(staging)
            ydl_options = self._ydl_options(plan, toolchain, staging)
            logger.info("开始下载: %s", url)
            self.last_filename = ""
            self.last_info = None
            self.last_ydl_info = None
            self._observed_transfer = False
            cookie_path = apply_cookiefile_from_headers(ydl_options, url)

            try:
                result = self._download_with_ydl(
                    url,
                    ydl_options,
                    plan,
                    staging,
                    preexisting_files,
                )
            except DownloadCancelled:
                raise
            except Exception as primary_exc:
                if not is_twitter_url(url):
                    raise
                try:
                    info, direct_url = resolve_twitter_media(url)
                    self.last_info = info
                    logger.info("Twitter 下载改用 FxTwitter 直链")
                    result = self._download_with_ydl(
                        direct_url,
                        ydl_options,
                        plan,
                        staging,
                        preexisting_files,
                        source_url=url,
                        metadata_fallback=info,
                    )
                except DownloadCancelled:
                    raise
                except Exception as fallback_exc:
                    logger.error("Twitter FxTwitter 下载回退失败: %s", fallback_exc)
                    raise fallback_exc from primary_exc

            if self.finished_callback:
                self.finished_callback()
            return result
        except DownloadCancelled:
            raise
        except OutputVerificationFailed as exc:
            logger.error("下载暂存结果无效: %s", exc)
            if self.error_callback:
                self.error_callback(str(exc))
            raise
        except Exception as exc:
            logger.error("下载出错: %s", exc)
            if self.error_callback:
                self.error_callback(str(exc))
            cause = exc.__cause__ or exc.__context__
            if isinstance(cause, DownloadCancelled):
                raise DownloadCancelled(str(exc)) from exc
            if "任务已取消" in str(exc) or "任务已暂停" in str(exc):
                raise DownloadCancelled(str(exc)) from exc
            raise DownloadError(str(exc)) from exc
        finally:
            cleanup_cookiefile(cookie_path)
