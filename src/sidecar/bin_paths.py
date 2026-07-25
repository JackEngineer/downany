"""解析打包/开发态下的 ffmpeg 与内置 yt-dlp 路径。"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Optional


def bin_dir_from_env() -> Optional[Path]:
    raw = os.environ.get("VIDEODL_BIN_DIR", "").strip()
    if not raw:
        return None
    return Path(raw).expanduser().resolve()


def resolve_ffmpeg_path(*, project_root: Optional[Path] = None) -> Optional[Path]:
    """
    优先级：
    1. VIDEODL_BIN_DIR/ffmpeg
    2. project_root/bin/ffmpeg（开发态仓库）
    """
    env_dir = bin_dir_from_env()
    if env_dir is not None:
        candidate = env_dir / "ffmpeg"
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return candidate

    if project_root is not None:
        candidate = project_root / "bin" / "ffmpeg"
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return candidate
    return None


def resolve_bundled_ytdlp_path() -> Optional[Path]:
    """打包保底 yt-dlp（不含用户 Application Support 更新版）。"""
    env_dir = bin_dir_from_env()
    if env_dir is None:
        return None
    candidate = env_dir / "yt-dlp"
    if candidate.is_file() and os.access(candidate, os.X_OK):
        return candidate
    return None
