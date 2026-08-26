"""Bounded ffprobe validation for staged and committed media outputs."""
from __future__ import annotations

import json
import subprocess
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from src.core.error_codes import OutputVerificationFailed
from src.core.output_contract import MediaKind
from src.utils.logger import setup_logger

logger = setup_logger("MediaVerifier")

MAX_CAPTURE_BYTES = 1024 * 1024
SAFE_FAILURE_MESSAGE = "成品无法验证，请导出诊断后重试"
CONTAINER_ALIASES = {
    "mp4": frozenset({"mp4", "mov", "m4a", "3gp", "3g2", "mj2"}),
    "mkv": frozenset({"matroska", "webm"}),
    "mp3": frozenset({"mp3"}),
}


@dataclass(frozen=True)
class VerificationExpectation:
    media_kind: MediaKind
    allowed_containers: frozenset[str]
    require_title: bool = False
    require_cover: bool = False
    require_chapters: bool = False
    embedded_subtitle_languages: tuple[str, ...] = ()


@dataclass(frozen=True)
class MediaVerification:
    container: str
    stream_types: tuple[str, ...]
    subtitle_languages: tuple[str, ...]
    has_cover: bool
    has_title: bool
    chapter_count: int


def _failure(detail: str) -> OutputVerificationFailed:
    logger.error("成品验证失败: %s", detail)
    return OutputVerificationFailed(SAFE_FAILURE_MESSAGE)


def _captured_bytes(value: object) -> bytes:
    if isinstance(value, bytes):
        return value
    if isinstance(value, str):
        return value.encode("utf-8", errors="replace")
    return b""


def _normalized_container(path: Path, format_name: object) -> str:
    names = {
        item.strip().casefold()
        for item in str(format_name or "").split(",")
        if item.strip()
    }
    suffix = path.suffix.casefold()
    if suffix in {".mp4", ".m4v"} and names & CONTAINER_ALIASES["mp4"]:
        return "mp4"
    if suffix in {".mkv", ".webm"} and names & CONTAINER_ALIASES["mkv"]:
        return "mkv"
    if suffix == ".mp3" and names & CONTAINER_ALIASES["mp3"]:
        return "mp3"
    raise _failure("文件扩展名与媒体容器不一致")


def _tag_value(tags: object, wanted: str) -> str:
    if not isinstance(tags, Mapping):
        return ""
    for key, value in tags.items():
        if str(key).casefold() == wanted.casefold():
            return str(value or "").strip()
    return ""


def _is_cover_stream(stream: Mapping[str, Any]) -> bool:
    disposition = stream.get("disposition")
    attached_pic = disposition.get("attached_pic") if isinstance(disposition, Mapping) else 0
    return (
        attached_pic is True
        or attached_pic == 1
        or str(attached_pic).strip() == "1"
        or str(stream.get("codec_type") or "").casefold() == "attachment"
    )


def _normalized_language(value: object) -> str:
    return str(value or "").strip().replace("_", "-").casefold()


def _canonical_language(value: object) -> str:
    normalized = _normalized_language(value)
    primary = normalized.split("-", 1)[0]
    aliases = {
        "en": "en",
        "eng": "en",
        "zh": "zh",
        "zho": "zh",
        "chi": "zh",
    }
    return aliases.get(primary, primary)


def _language_matches(requested: str, available: str) -> bool:
    requested_primary = _canonical_language(requested)
    available_primary = _canonical_language(available)
    if not requested_primary or not available_primary:
        return False
    if requested_primary == "und" or available_primary == "und":
        return False
    return requested_primary == available_primary


def _normalize_report(
    path: Path,
    payload: object,
    expectation: VerificationExpectation,
) -> MediaVerification:
    if not isinstance(payload, Mapping):
        raise _failure("ffprobe 未返回对象")
    format_info = payload.get("format")
    if not isinstance(format_info, Mapping):
        format_info = {}
    container = _normalized_container(path, format_info.get("format_name"))
    allowed = {str(item).strip().casefold() for item in expectation.allowed_containers}
    if container not in allowed:
        raise _failure("媒体容器不符合输出选择")

    raw_streams = payload.get("streams")
    streams = (
        [item for item in raw_streams if isinstance(item, Mapping)]
        if isinstance(raw_streams, list)
        else []
    )
    stream_types = tuple(
        str(stream.get("codec_type") or "").strip().casefold()
        for stream in streams
        if str(stream.get("codec_type") or "").strip()
    )
    if expectation.media_kind is MediaKind.VIDEO:
        has_primary_stream = any(
            str(stream.get("codec_type") or "").casefold() == "video"
            and not _is_cover_stream(stream)
            for stream in streams
        )
    else:
        has_primary_stream = any(
            str(stream.get("codec_type") or "").casefold() == "audio"
            for stream in streams
        )
    if not has_primary_stream:
        raise _failure("成品缺少所需媒体流")

    has_cover = any(_is_cover_stream(stream) for stream in streams)
    has_title = bool(_tag_value(format_info.get("tags"), "title")) or any(
        bool(_tag_value(stream.get("tags"), "title")) for stream in streams
    )
    raw_chapters = payload.get("chapters")
    chapter_count = (
        sum(1 for item in raw_chapters if isinstance(item, Mapping))
        if isinstance(raw_chapters, list)
        else 0
    )

    subtitle_languages: list[str] = []
    seen_languages: set[str] = set()
    for stream in streams:
        if str(stream.get("codec_type") or "").casefold() != "subtitle":
            continue
        language = _normalized_language(_tag_value(stream.get("tags"), "language"))
        if not language or language in seen_languages:
            continue
        seen_languages.add(language)
        subtitle_languages.append(language)

    if expectation.require_title and not has_title:
        raise _failure("成品缺少标题元数据")
    if expectation.require_cover and not has_cover:
        raise _failure("成品缺少封面")
    if expectation.require_chapters and chapter_count < 1:
        raise _failure("成品缺少章节")
    for requested in expectation.embedded_subtitle_languages:
        if not any(
            _language_matches(requested, available)
            for available in subtitle_languages
        ):
            raise _failure("成品缺少请求的字幕语言")

    return MediaVerification(
        container=container,
        stream_types=stream_types,
        subtitle_languages=tuple(subtitle_languages),
        has_cover=has_cover,
        has_title=has_title,
        chapter_count=chapter_count,
    )


def verify_media(
    path: Path,
    ffprobe_path: Path,
    expectation: VerificationExpectation,
    *,
    timeout_seconds: float = 15.0,
    run: Callable[..., subprocess.CompletedProcess[bytes]] = subprocess.run,
) -> MediaVerification:
    """Return a normalized report or raise OutputVerificationFailed."""
    media_path = Path(path)
    try:
        if not media_path.is_file() or media_path.stat().st_size <= 0:
            raise _failure("成品文件不存在、不是文件或为空")
    except OutputVerificationFailed:
        raise
    except OSError as exc:
        raise _failure(f"无法读取成品文件: {exc}") from exc

    argv = [
        str(ffprobe_path),
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        "-show_chapters",
        str(media_path),
    ]
    try:
        completed = run(
            argv,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout_seconds,
            check=False,
            shell=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise _failure("ffprobe 执行超时") from exc
    except (OSError, subprocess.SubprocessError) as exc:
        raise _failure(f"ffprobe 无法执行: {exc}") from exc

    stdout = _captured_bytes(completed.stdout)
    stderr = _captured_bytes(completed.stderr)
    if len(stdout) > MAX_CAPTURE_BYTES or len(stderr) > MAX_CAPTURE_BYTES:
        raise _failure("ffprobe 输出超过安全上限")
    if completed.returncode != 0:
        detail = stderr[:MAX_CAPTURE_BYTES].decode("utf-8", errors="replace").strip()
        raise _failure(f"ffprobe 返回失败状态 {completed.returncode}: {detail}")

    try:
        decoded = stdout[:MAX_CAPTURE_BYTES].decode("utf-8")
        payload = json.loads(decoded)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise _failure(f"ffprobe 输出无法解析: {exc}") from exc
    return _normalize_report(media_path, payload, expectation)
