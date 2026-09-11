"""Portable output-name validation and final-path planning."""
from __future__ import annotations

import hashlib
import os
import re
import tempfile
import unicodedata
from dataclasses import dataclass
from pathlib import Path

from src.core.error_codes import OutputPathInvalid
from src.core.url_normalizer import normalize_download_url

MAX_COMPONENT_UTF16 = 120
MAX_WINDOWS_PATH_UTF16 = 240
MIN_LEAF_BUDGET_UTF16 = 40
WINDOWS_RESERVED = frozenset(
    {"CON", "PRN", "AUX", "NUL"}
    | {f"COM{i}" for i in range(1, 10)}
    | {f"LPT{i}" for i in range(1, 10)}
)
IS_WINDOWS = os.name == "nt"

TEMPLATE_PLACEHOLDER_RE = re.compile(r"%\((\w+)\)s")
ALLOWED_TEMPLATE_FIELDS = frozenset(
    {
        "title",
        "uploader",
        "id",
        "ext",
        "upload_date",
        "resolution",
        "duration_string",
        "height",
        "width",
        "fps",
        "format_id",
        "extractor",
    }
)

_INVALID_COMPONENT_RE = re.compile(r"[\\/:*?\"<>|\x00-\x1f\x7f]")
_WHITESPACE_RE = re.compile(r"\s+")
_DRIVE_PREFIX_RE = re.compile(r"^[A-Za-z]:")
_LEADING_INDEX_RE = re.compile(r"^(\d{3,} - )")
_COLLISION_SUFFIX_RE = re.compile(r"( \([2-9][0-9]*\))$")
_SOURCE_SUFFIX_RE = re.compile(r"( \[[^\[\]]+\])$")
_EXTENSION_RE = re.compile(r"(\.[A-Za-z0-9][A-Za-z0-9_-]{0,15})$")


@dataclass(frozen=True)
class FinalPathPlan:
    root: Path
    directory: Path
    main_file: Path
    subtitle_files: tuple[Path, ...]


def ensure_output_directory_ready(path: str) -> Path:
    """创建并实际探测下载目录，避免任务入队后才发现无法写入。"""
    text = str(path or "").strip()
    if not text:
        raise OutputPathInvalid("下载位置不可用，请选择其他目录")
    target = _resolve_path(Path(text).expanduser(), "下载位置不可用，请选择其他目录")
    try:
        if target.exists() and not target.is_dir():
            raise OutputPathInvalid("下载位置不可用，请选择其他目录")
        target.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            prefix=".downany-write-check-",
            dir=target,
            delete=True,
        ):
            pass
    except OutputPathInvalid:
        raise
    except OSError as exc:
        raise OutputPathInvalid("下载位置不可用，请选择其他目录") from exc
    return target


def utf16_units(value: str) -> int:
    return len(value.encode("utf-16-le")) // 2


def truncate_utf16(value: str, budget: int) -> str:
    kept: list[str] = []
    used = 0
    for char in value:
        width = utf16_units(char)
        if used + width > budget:
            break
        kept.append(char)
        used += width
    return "".join(kept)


def _clean_component(value: str) -> str:
    normalized = unicodedata.normalize("NFC", str(value or ""))
    cleaned = _INVALID_COMPONENT_RE.sub(" ", normalized)
    cleaned = _WHITESPACE_RE.sub(" ", cleaned).strip()
    return cleaned.rstrip(" .")


def _fallback_component(fallback: str) -> str:
    cleaned = _clean_component(fallback)
    if not cleaned or not cleaned.strip("."):
        return "item"
    return cleaned


def _prefix_reserved_stem(value: str) -> str:
    stem = value.split(".", 1)[0].rstrip(" .").upper()
    if stem in WINDOWS_RESERVED:
        return f"_{value}"
    return value


def _protected_component_parts(value: str) -> tuple[str, str, str]:
    """Return a product prefix, truncatable body, and protected suffix."""
    remaining = value
    extension = ""
    match = _EXTENSION_RE.search(remaining)
    if match:
        extension = match.group(1)
        remaining = remaining[: match.start()]

    collision = ""
    match = _COLLISION_SUFFIX_RE.search(remaining)
    if match:
        collision = match.group(1)
        remaining = remaining[: match.start()]

    source = ""
    match = _SOURCE_SUFFIX_RE.search(remaining)
    if match:
        source = match.group(1)
        remaining = remaining[: match.start()]

    prefix = ""
    match = _LEADING_INDEX_RE.match(remaining)
    if match:
        prefix = match.group(1)
        remaining = remaining[match.end() :]

    return prefix, remaining, f"{source}{collision}{extension}"


def safe_component(
    value: str,
    *,
    fallback: str,
    max_units: int = MAX_COMPONENT_UTF16,
) -> str:
    """Return one NFC-normalized component safe to copy between macOS and Windows."""
    budget = int(max_units)
    if budget < 1:
        raise OutputPathInvalid("文件名可用长度不足")

    cleaned = _clean_component(value)
    if not cleaned or not cleaned.strip("."):
        cleaned = _fallback_component(fallback)
    cleaned = _prefix_reserved_stem(cleaned)
    if utf16_units(cleaned) <= budget:
        return cleaned

    prefix, body, suffix = _protected_component_parts(cleaned)
    fixed_units = utf16_units(prefix) + utf16_units(suffix)
    if fixed_units < budget:
        body_budget = budget - fixed_units
        truncated_body = truncate_utf16(body, body_budget).rstrip(" .")
        candidate = f"{prefix}{truncated_body}{suffix}"
        if candidate and utf16_units(candidate) <= budget:
            return candidate

    fallback_value = _prefix_reserved_stem(_fallback_component(fallback))
    candidate = truncate_utf16(fallback_value, budget).rstrip(" .")
    if candidate:
        return candidate
    raise OutputPathInvalid("文件名可用长度不足")


def validate_filename_template(template: str) -> str:
    """Validate that a yt-dlp template can only produce one leaf filename."""
    text = unicodedata.normalize("NFC", str(template or "")).strip()
    if not text:
        return ""
    if (
        "/" in text
        or "\\" in text
        or _DRIVE_PREFIX_RE.match(text)
        or text in {".", ".."}
        or any(ord(char) < 32 or ord(char) == 127 for char in text)
    ):
        raise OutputPathInvalid("文件名模板只能生成一个文件名")

    fields = TEMPLATE_PLACEHOLDER_RE.findall(text)
    unknown = sorted({field for field in fields if field not in ALLOWED_TEMPLATE_FIELDS})
    unmatched = TEMPLATE_PLACEHOLDER_RE.sub("", text)
    if unknown or "%(" in unmatched:
        if unknown:
            names = "、".join(unknown)
            raise OutputPathInvalid(f"文件名模板包含不支持的字段：{names}")
        raise OutputPathInvalid("文件名模板包含不支持的字段")
    if "%(ext)s" not in text:
        raise OutputPathInvalid("文件名模板必须包含扩展名字段 %(ext)s")
    return text


def stable_source_key(url: str, *, extractor: str = "", media_id: str = "") -> str:
    safe_extractor = safe_component(extractor, fallback="unknown", max_units=32)
    safe_media_id = safe_component(media_id, fallback="unknown", max_units=48)
    if safe_extractor != "unknown" and safe_media_id != "unknown":
        return f"{safe_extractor}-{safe_media_id}"
    normalized = normalize_download_url(url)
    digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:8]
    return f"url-{digest}"


def _resolve_path(path: Path, message: str) -> Path:
    try:
        return path.resolve(strict=False)
    except (OSError, RuntimeError, ValueError) as exc:
        raise OutputPathInvalid(message) from exc


def _require_inside_root(root: Path, candidate: Path) -> Path:
    resolved_candidate = _resolve_path(candidate, "成品路径不可用")
    try:
        inside_root = os.path.commonpath(
            [os.path.normcase(str(root)), os.path.normcase(str(resolved_candidate))]
        ) == os.path.normcase(str(root))
    except ValueError:
        inside_root = False
    if not inside_root:
        raise OutputPathInvalid("成品路径超出下载位置")
    return resolved_candidate


def _split_rendered_leaf(rendered_leaf: str) -> tuple[str, str]:
    cleaned = _clean_component(rendered_leaf)
    if not cleaned or not cleaned.strip("."):
        cleaned = "video.bin"
    match = _EXTENSION_RE.search(cleaned)
    if not match:
        return cleaned, ""
    return cleaned[: match.start()], match.group(1)


def build_final_path_plan(
    download_root: Path,
    playlist_folder: str,
    rendered_leaf: str,
    source_key: str,
    subtitle_specs: tuple[tuple[str, str], ...],
    copy_index: int = 1,
) -> FinalPathPlan:
    """Plan one collision-safe main path and all matching subtitle paths."""
    if int(copy_index) < 1:
        raise OutputPathInvalid("成品副本序号无效")

    root = _resolve_path(Path(download_root).expanduser(), "下载位置不可用")
    if root.exists() and not root.is_dir():
        raise OutputPathInvalid("下载位置不可用，请选择其他目录")

    if str(playlist_folder or "").strip():
        safe_folder = safe_component(playlist_folder, fallback="playlist")
        directory = _require_inside_root(root, root / safe_folder)
    else:
        directory = root
    _require_inside_root(root, directory)
    if directory.exists() and not directory.is_dir():
        raise OutputPathInvalid("成品目录不可用")

    stem, main_extension = _split_rendered_leaf(rendered_leaf)
    safe_key = safe_component(source_key, fallback="unknown", max_units=81)
    if safe_key.casefold() not in stem.casefold():
        stem = f"{stem} [{safe_key}]"
    if int(copy_index) > 1:
        stem = f"{stem} ({int(copy_index)})"

    subtitle_suffixes: list[str] = []
    for language, extension in subtitle_specs:
        safe_language = safe_component(language, fallback="und", max_units=32)
        safe_extension = safe_component(
            str(extension or "").lstrip("."),
            fallback="vtt",
            max_units=16,
        )
        subtitle_suffixes.append(f".{safe_language}.{safe_extension}")

    component_budget = MAX_COMPONENT_UTF16
    if IS_WINDOWS:
        leaf_budget = (
            MAX_WINDOWS_PATH_UTF16
            - utf16_units(str(directory))
            - utf16_units(os.sep)
        )
        if leaf_budget < MIN_LEAF_BUDGET_UTF16:
            raise OutputPathInvalid("下载位置过长，请选择更短的目录")
        component_budget = min(component_budget, leaf_budget)

    suffixes = [main_extension, *subtitle_suffixes]
    longest_suffix = max((utf16_units(suffix) for suffix in suffixes), default=0)
    stem_budget = component_budget - longest_suffix
    if stem_budget < 1:
        raise OutputPathInvalid("下载位置过长，请选择更短的目录")
    common_stem = safe_component(stem, fallback=f"video [{safe_key}]", max_units=stem_budget)
    if safe_key.casefold() not in common_stem.casefold():
        common_stem = safe_component(
            f"{stem} [{safe_key}]",
            fallback=f"video [{safe_key}]",
            max_units=stem_budget,
        )

    candidates = [
        directory / f"{common_stem}{main_extension}",
        *(directory / f"{common_stem}{suffix}" for suffix in subtitle_suffixes),
    ]
    resolved_candidates = tuple(_require_inside_root(root, path) for path in candidates)
    if IS_WINDOWS and any(
        utf16_units(str(path)) > MAX_WINDOWS_PATH_UTF16 for path in resolved_candidates
    ):
        raise OutputPathInvalid("下载位置过长，请选择更短的目录")

    return FinalPathPlan(
        root=root,
        directory=directory,
        main_file=resolved_candidates[0],
        subtitle_files=resolved_candidates[1:],
    )
