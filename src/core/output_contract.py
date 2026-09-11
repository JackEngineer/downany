"""Compile task settings into one immutable, verifiable output contract."""
from __future__ import annotations

import copy
import hashlib
import re
from collections.abc import Mapping
from dataclasses import dataclass
from enum import Enum
from types import MappingProxyType
from typing import Any

from src.core.download_task import DownloadTask, Platform
from src.core.http_headers import DEFAULT_HTTP_HEADERS
from src.core.output_paths import (
    safe_component,
    stable_source_key,
    validate_filename_template,
)
from src.core.quality import build_format_selector


class MediaKind(str, Enum):
    VIDEO = "video"
    AUDIO = "audio"


class SubtitleMode(str, Enum):
    NONE = "none"
    EXTERNAL = "external"
    EMBEDDED = "embedded"
    BOTH = "both"


DEFAULT_REMUX = {
    "key": "FFmpegVideoRemuxer",
    "preferedformat": "mp4>mp4/mkv>mkv/webm>mkv/mov>mp4/m4v>mp4/mkv",
}
MP4_CONVERT = {"key": "FFmpegVideoConvertor", "preferedformat": "mp4"}
MP3_EXTRACT = {
    "key": "FFmpegExtractAudio",
    "preferredcodec": "mp3",
    "preferredquality": "192",
}
EMBED_SUBTITLES = {"key": "FFmpegEmbedSubtitle", "already_have_subtitle": False}
WRITE_METADATA = {
    "key": "FFmpegMetadata",
    "add_metadata": True,
    "add_chapters": True,
    "add_infojson": False,
}
EMBED_THUMBNAIL = {"key": "EmbedThumbnail", "already_have_thumbnail": False}

_DIRECT_MEDIA_RE = re.compile(
    r"\.(m3u8|mpd|mp4|webm|mkv|mov|m4v|mp3|m4a|aac|flac|ogg|wav)(?:[?#]|$)",
    re.IGNORECASE,
)
_HEX_ID_RE = re.compile(r"^[0-9a-fA-F]+$")


def _freeze(value: Any) -> Any:
    if isinstance(value, Mapping):
        return MappingProxyType({key: _freeze(item) for key, item in value.items()})
    if isinstance(value, (list, tuple)):
        return tuple(_freeze(item) for item in value)
    if isinstance(value, (set, frozenset)):
        return frozenset(_freeze(item) for item in value)
    return copy.deepcopy(value)


def _mutable_copy(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {key: _mutable_copy(item) for key, item in value.items()}
    if isinstance(value, tuple):
        return tuple(_mutable_copy(item) for item in value)
    if isinstance(value, frozenset):
        return set(_mutable_copy(item) for item in value)
    return copy.deepcopy(value)


@dataclass(frozen=True)
class OutputPlan:
    media_kind: MediaKind
    allowed_containers: frozenset[str]
    subtitle_mode: SubtitleMode
    requested_subtitle_languages: tuple[str, ...]
    ydl_options: Mapping[str, object]
    postprocessors: tuple[Mapping[str, object], ...]
    final_leaf_template: str
    source_key_template: str
    playlist_folder: str
    requires_ffmpeg: bool
    requires_ffprobe: bool
    completion_note: str = ""

    def __post_init__(self) -> None:
        object.__setattr__(self, "allowed_containers", frozenset(self.allowed_containers))
        object.__setattr__(
            self,
            "requested_subtitle_languages",
            tuple(self.requested_subtitle_languages),
        )
        object.__setattr__(self, "ydl_options", _freeze(self.ydl_options))
        object.__setattr__(
            self,
            "postprocessors",
            tuple(_freeze(item) for item in self.postprocessors),
        )

    def to_ydl_options(self) -> dict[str, object]:
        copied = {
            key: _mutable_copy(value) for key, value in self.ydl_options.items()
        }
        copied["postprocessors"] = [
            _mutable_copy(item) for item in self.postprocessors
        ]
        return copied


def _requested_subtitle_mode(task: DownloadTask) -> SubtitleMode:
    download = bool(task.options.download_subtitles)
    embed = bool(task.options.embed_subs)
    if download and embed:
        return SubtitleMode.BOTH
    if download:
        return SubtitleMode.EXTERNAL
    if embed:
        return SubtitleMode.EMBEDDED
    return SubtitleMode.NONE


def _normalized_subtitle_languages(raw: str) -> tuple[str, ...]:
    languages: list[str] = []
    seen: set[str] = set()
    for part in str(raw or "").split(","):
        language = part.strip()
        key = language.casefold()
        if not language or key in seen:
            continue
        seen.add(key)
        languages.append(language)
    return tuple(languages)


def _group_key(group_id: str, group_title: str) -> str:
    raw = str(group_id or "").strip()
    if len(raw) >= 8 and _HEX_ID_RE.fullmatch(raw):
        return raw[:8].lower()
    seed = raw or str(group_title or "").strip()
    return hashlib.sha256(seed.encode("utf-8")).hexdigest()[:8]


def _insert_source_key(template: str, source_key_template: str) -> str:
    marker = "%(ext)s"
    marker_index = template.find(marker)
    before = template[:marker_index].rstrip()
    after = template[marker_index + len(marker) :]
    if before.endswith("."):
        before = before[:-1].rstrip()
    separator = " " if before else ""
    return f"{before}{separator}[{source_key_template}].%(ext)s{after}"


def _compile_final_names(task: DownloadTask) -> tuple[str, str, str]:
    options = task.options
    direct_media = bool(_DIRECT_MEDIA_RE.search(task.video_info.url or ""))
    if direct_media:
        source_key_template = stable_source_key(task.video_info.url)
    else:
        source_key_template = "%(extractor)s-%(id)s"

    custom_template = validate_filename_template(options.filename_template)
    if custom_template:
        includes_page_key = (
            "%(extractor)s" in custom_template and "%(id)s" in custom_template
        )
        if direct_media or not includes_page_key:
            final_leaf_template = _insert_source_key(
                custom_template,
                source_key_template,
            )
        else:
            final_leaf_template = custom_template
    else:
        final_leaf_template = f"%(title)s [{source_key_template}].%(ext)s"

    grouped = bool(task.group_id or task.group_title)
    playlist_folder = ""
    if grouped:
        group_key = _group_key(task.group_id, task.group_title)
        playlist_folder = safe_component(
            f"{task.group_title} [{group_key}]",
            fallback=f"playlist [{group_key}]",
        )
        playlist_index = max(int(task.playlist_index or 0), 0)
        final_leaf_template = f"{playlist_index:03d} - {final_leaf_template}"

    return final_leaf_template, source_key_template, playlist_folder


def compile_output_plan(task: DownloadTask) -> OutputPlan:
    """Compile one task without performing network or filesystem operations."""
    options = task.options
    audio_output = bool(options.audio_only or options.postprocessing == "mp3")
    media_kind = MediaKind.AUDIO if audio_output else MediaKind.VIDEO

    requested_mode = _requested_subtitle_mode(task)
    completion_note = ""
    if media_kind is MediaKind.AUDIO and requested_mode in {
        SubtitleMode.EMBEDDED,
        SubtitleMode.BOTH,
    }:
        subtitle_mode = SubtitleMode.EXTERNAL
        completion_note = "音频已下载，字幕已保存为独立文件"
    else:
        subtitle_mode = requested_mode

    requested_languages = (
        _normalized_subtitle_languages(options.subtitle_langs)
        if subtitle_mode is not SubtitleMode.NONE
        else ()
    )

    ydl_options: dict[str, object] = {}
    postprocessors: list[dict[str, object]] = []
    if media_kind is MediaKind.AUDIO:
        ydl_options["format"] = "bestaudio/best"
        postprocessors.append(dict(MP3_EXTRACT))
        allowed_containers = frozenset({"mp3"})
    else:
        format_id = str(options.format_id or "").strip()
        if _DIRECT_MEDIA_RE.search(task.video_info.url or "") and not format_id:
            ydl_options["format"] = "bestvideo+bestaudio/best"
        else:
            ydl_options["format"] = build_format_selector(
                options.quality,
                format_id or None,
            )
        ydl_options["merge_output_format"] = "mp4/mkv"
        if options.postprocessing == "mp4":
            postprocessors.append(dict(MP4_CONVERT))
            allowed_containers = frozenset({"mp4"})
        else:
            postprocessors.append(dict(DEFAULT_REMUX))
            allowed_containers = frozenset({"mp4", "mkv"})

    if subtitle_mode is not SubtitleMode.NONE:
        ydl_options["writesubtitles"] = True
        ydl_options["writeautomaticsub"] = True
        if requested_languages:
            ydl_options["subtitleslangs"] = requested_languages
    if media_kind is MediaKind.VIDEO and subtitle_mode in {
        SubtitleMode.EMBEDDED,
        SubtitleMode.BOTH,
    }:
        embed_subtitles = dict(EMBED_SUBTITLES)
        embed_subtitles["already_have_subtitle"] = subtitle_mode is SubtitleMode.BOTH
        postprocessors.append(embed_subtitles)

    if options.embed_metadata:
        ydl_options["writethumbnail"] = True
        postprocessors.append(dict(WRITE_METADATA))
        postprocessors.append(dict(EMBED_THUMBNAIL))

    if options.concurrent_fragments and options.concurrent_fragments > 0:
        ydl_options["concurrent_fragment_downloads"] = options.concurrent_fragments
    if options.speed_limit and options.speed_limit > 0:
        ydl_options["ratelimit"] = options.speed_limit
    proxy = str(options.proxy or "").strip()
    if proxy:
        ydl_options["proxy"] = proxy
    if options.http_headers:
        ydl_options["http_headers"] = {
            **DEFAULT_HTTP_HEADERS,
            **options.http_headers,
        }
    browser = str(options.cookies_from_browser or "").strip()
    if browser:
        ydl_options["cookiesfrombrowser"] = (browser,)
    cookiefile = str(options.cookiefile or "").strip()
    if cookiefile:
        ydl_options["cookiefile"] = cookiefile

    if (
        task.video_info.platform == Platform.BILIBILI
        and int(task.playlist_index or 0) > 0
        and bool(task.group_id or task.group_title)
    ):
        # Bilibili interactive and multi-P pages ignore noplaylist and return a
        # playlist wrapper even when a client-expanded task represents one row.
        ydl_options["playlist_items"] = str(int(task.playlist_index))

    final_leaf_template, source_key_template, playlist_folder = _compile_final_names(task)
    return OutputPlan(
        media_kind=media_kind,
        allowed_containers=allowed_containers,
        subtitle_mode=subtitle_mode,
        requested_subtitle_languages=requested_languages,
        ydl_options=ydl_options,
        postprocessors=tuple(postprocessors),
        final_leaf_template=final_leaf_template,
        source_key_template=source_key_template,
        playlist_folder=playlist_folder,
        requires_ffmpeg=True,
        requires_ffprobe=True,
        completion_note=completion_note,
    )
