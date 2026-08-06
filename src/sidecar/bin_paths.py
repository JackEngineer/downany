"""解析打包/开发态下的 ffmpeg 与内置 yt-dlp 路径。"""
from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Optional


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
            return candidate
    if sys.platform == "win32":
        exe = directory / f"{base}.exe"
        if exe.is_file():
            return exe
    return None


def resolve_ffmpeg_path(*, project_root: Optional[Path] = None) -> Optional[Path]:
    """
    优先级：
    1. DOWNANY_BIN_DIR/ffmpeg
    2. project_root/bin/ffmpeg（开发态仓库）
    """
    env_dir = bin_dir_from_env()
    if env_dir is not None:
        candidate = _first_executable(env_dir, "ffmpeg")
        if candidate is not None:
            return candidate

    if project_root is not None:
        candidate = _first_executable(project_root / "bin", "ffmpeg")
        if candidate is not None:
            return candidate
    return None


def resolve_bundled_ytdlp_path() -> Optional[Path]:
    """打包保底 yt-dlp（不含用户 Application Support 更新版）。"""
    env_dir = bin_dir_from_env()
    if env_dir is None:
        return None
    return _first_executable(env_dir, "yt-dlp")
