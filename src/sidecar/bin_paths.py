"""解析打包/开发态下的 ffmpeg 与内置 yt-dlp 路径。"""
from __future__ import annotations

import os
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


@dataclass(frozen=True)
class MediaToolchain:
    ffmpeg: Path
    ffprobe: Path
    ffmpeg_location: Optional[Path]
    source: str


def bin_dir_from_env() -> Optional[Path]:
    raw = (os.environ.get("DOWNANY_BIN_DIR") or "").strip()
    if not raw:
        legacy = (os.environ.get("VIDEODL_BIN_DIR") or "").strip()
        if legacy:
            sys.stderr.write("警告: VIDEODL_BIN_DIR 已弃用，请改用 DOWNANY_BIN_DIR\n")
            raw = legacy
    if not raw:
        return None
    return Path(raw).expanduser().resolve()


def _candidate_names(base: str) -> list[str]:
    if sys.platform == "win32":
        return [f"{base}.exe", base]
    return [base, f"{base}.exe"]


def _first_executable(directory: Path, base: str) -> Optional[Path]:
    for name in _candidate_names(base):
        candidate = directory / name
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return candidate.resolve()
    if sys.platform == "win32":
        exe = directory / f"{base}.exe"
        if exe.is_file():
            return exe.resolve()
    return None


def _candidate_directories(
    project_root: Optional[Path],
) -> list[tuple[Path, str]]:
    candidates: list[tuple[Path, str]] = []
    env_dir = bin_dir_from_env()
    if env_dir is not None:
        candidates.append((env_dir, "environment"))

    if getattr(sys, "frozen", False):
        try:
            resources_dir = Path(sys.executable).resolve().parents[2]
        except (IndexError, OSError, RuntimeError):
            resources_dir = None
        if resources_dir is not None:
            candidates.append((resources_dir / "bin", "packaged"))

    if project_root is not None:
        root = Path(project_root).expanduser().resolve()
        candidates.extend(
            [
                (root / "desktop" / "resources" / "bin", "development_resources"),
                (root / "bin", "development_bin"),
            ]
        )

    unique: list[tuple[Path, str]] = []
    seen: set[str] = set()
    for directory, source in candidates:
        key = os.path.normcase(str(directory.resolve()))
        if key in seen:
            continue
        seen.add(key)
        unique.append((directory.resolve(), source))
    return unique


def _path_executable(base: str) -> Optional[Path]:
    found = shutil.which(base)
    if not found:
        return None
    return Path(found).expanduser().resolve()


def _resolve_single_tool(base: str, project_root: Optional[Path]) -> Optional[Path]:
    for directory, _source in _candidate_directories(project_root):
        candidate = _first_executable(directory, base)
        if candidate is not None:
            return candidate
    return _path_executable(base)


def _pair_from_directory(directory: Path, source: str) -> Optional[MediaToolchain]:
    ffmpeg = _first_executable(directory, "ffmpeg")
    ffprobe = _first_executable(directory, "ffprobe")
    if ffmpeg is None or ffprobe is None:
        return None
    return MediaToolchain(
        ffmpeg=ffmpeg,
        ffprobe=ffprobe,
        ffmpeg_location=directory.resolve(),
        source=source,
    )


def resolve_ffmpeg_path(*, project_root: Optional[Path] = None) -> Optional[Path]:
    """按应用资源优先级解析单独可用的 ffmpeg。"""
    return _resolve_single_tool("ffmpeg", project_root)


def resolve_ffprobe_path(*, project_root: Optional[Path] = None) -> Optional[Path]:
    """按应用资源优先级解析单独可用的 ffprobe。"""
    return _resolve_single_tool("ffprobe", project_root)


def resolve_media_toolchain(
    *,
    project_root: Optional[Path] = None,
) -> Optional[MediaToolchain]:
    """解析下载合同所需的完整 ffmpeg/ffprobe 配对。"""
    for directory, source in _candidate_directories(project_root):
        pair = _pair_from_directory(directory, source)
        if pair is not None:
            return pair

    ffmpeg = _path_executable("ffmpeg")
    ffprobe = _path_executable("ffprobe")
    if ffmpeg is None or ffprobe is None:
        return None
    return MediaToolchain(
        ffmpeg=ffmpeg,
        ffprobe=ffprobe,
        ffmpeg_location=None,
        source="path",
    )


def resolve_bundled_ytdlp_path() -> Optional[Path]:
    """打包保底 yt-dlp（不含用户 Application Support 更新版）。"""
    env_dir = bin_dir_from_env()
    if env_dir is None:
        return None
    return _first_executable(env_dir, "yt-dlp")
