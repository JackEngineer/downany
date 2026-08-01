"""下载完成后从视频文件抽帧，生成本地封面。"""
from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Optional

from src.sidecar.bin_paths import resolve_ffmpeg_path
from src.utils.logger import setup_logger

logger = setup_logger("LocalThumbnail")

THUMB_SCHEME = "downany-thumb"


def thumbnail_url_for_task(task_id: str) -> str:
    tid = (task_id or "").strip()
    if not tid:
        return ""
    return f"{THUMB_SCHEME}://{tid}"


def default_data_dir() -> Path:
    override = (os.environ.get("DOWNANY_DATA_DIR") or "").strip()
    if not override:
        override = (os.environ.get("VIDEODL_DATA_DIR") or "").strip()
    if override:
        return Path(override).expanduser().resolve()
    return Path.home() / "Library" / "Application Support" / "Downany"


def thumbs_dir(data_dir: Optional[Path] = None) -> Path:
    root = data_dir or default_data_dir()
    path = root / "thumbnails"
    path.mkdir(parents=True, exist_ok=True)
    return path


def thumb_path_for_task(task_id: str, data_dir: Optional[Path] = None) -> Path:
    return thumbs_dir(data_dir) / f"{task_id}.jpg"


def find_adjacent_thumbnail(video_path: str) -> str:
    """yt-dlp writethumbnail 可能落在同目录的 .jpg/.webp。"""
    path = Path(video_path or "")
    if not path.is_file():
        return ""
    stem = path.with_suffix("")
    for ext in (".jpg", ".jpeg", ".png", ".webp"):
        candidate = Path(str(stem) + ext)
        if candidate.is_file() and candidate.stat().st_size > 0:
            return str(candidate)
    return ""


def extract_video_thumbnail(
    video_path: str,
    dest_jpg: Path,
    *,
    ffmpeg_bin: Optional[str] = None,
    seek_seconds: float = 0.5,
) -> bool:
    """用 ffmpeg 抽一帧到 dest_jpg。成功返回 True。"""
    src = Path(video_path or "")
    if not src.is_file():
        return False
    ffmpeg = ffmpeg_bin
    if not ffmpeg:
        resolved = resolve_ffmpeg_path(
            project_root=Path(__file__).resolve().parents[2]
        )
        # 打包态：DOWNANY_BIN_DIR / resources/bin
        if resolved is None:
            env_bin = (os.environ.get("DOWNANY_BIN_DIR") or "").strip()
            if env_bin:
                candidate = Path(env_bin) / "ffmpeg"
                if candidate.is_file():
                    resolved = candidate
        ffmpeg = str(resolved) if resolved else "ffmpeg"

    dest_jpg.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest_jpg.with_suffix(".tmp.jpg")
    cmd = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        str(seek_seconds),
        "-i",
        str(src),
        "-frames:v",
        "1",
        "-q:v",
        "4",
        str(tmp),
    ]
    try:
        subprocess.run(cmd, check=True, timeout=60, capture_output=True)
        if not tmp.is_file() or tmp.stat().st_size <= 0:
            return False
        tmp.replace(dest_jpg)
        return True
    except (OSError, subprocess.SubprocessError) as exc:
        logger.warning("抽帧封面失败 %s: %s", src.name, exc)
        try:
            if tmp.exists():
                tmp.unlink()
        except OSError:
            pass
        return False


def ensure_local_thumbnail(
    task_id: str,
    video_path: str,
    *,
    data_dir: Optional[Path] = None,
) -> str:
    """
    确保任务有本地封面文件，返回 downany-thumb://{task_id}；失败返回空串。
    优先复用同目录已有封面图，否则 ffmpeg 抽帧。
    """
    tid = (task_id or "").strip()
    if not tid or not video_path:
        return ""
    dest = thumb_path_for_task(tid, data_dir)
    if dest.is_file() and dest.stat().st_size > 0:
        return thumbnail_url_for_task(tid)

    adjacent = find_adjacent_thumbnail(video_path)
    if adjacent:
        try:
            dest.write_bytes(Path(adjacent).read_bytes())
            if dest.is_file() and dest.stat().st_size > 0:
                return thumbnail_url_for_task(tid)
        except OSError as exc:
            logger.debug("复制相邻封面失败: %s", exc)

    if extract_video_thumbnail(video_path, dest):
        return thumbnail_url_for_task(tid)
    return ""
