"""下载质量字符串解析。"""
import re
from typing import Optional

VALID_QUALITIES = frozenset({"best", "1080p", "720p", "480p", "360p"})
DEFAULT_VIDEO_FORMAT_SELECTOR = (
    "bestvideo[vcodec^=avc][ext=mp4]+bestaudio[ext=m4a]/"
    "best[vcodec^=avc][ext=mp4]/"
    "bestvideo[ext=mp4]+bestaudio[ext=m4a]/"
    "bestvideo+bestaudio/best[ext=mp4]/best"
)


def parse_quality_height(quality: str) -> Optional[int]:
    """
    从质量字符串解析高度，如 ``1080p`` -> 1080。
    ``best`` 或无法解析时返回 None。
    """
    if not quality or quality == "best":
        return None
    match = re.search(r"(\d+)", quality)
    if not match:
        return None
    return int(match.group(1))


def normalize_quality(quality: Optional[str]) -> str:
    """将配置值规范到白名单，非法则回退 best。"""
    value = (quality or "best").strip().lower()
    if value in VALID_QUALITIES:
        return value
    # 允许类似 1080 / 720P
    height = parse_quality_height(value)
    if height is not None:
        candidate = f"{height}p"
        if candidate in VALID_QUALITIES:
            return candidate
    return "best"


def build_format_selector(quality: str, format_id: Optional[str] = None) -> str:
    """生成 MP4 优先且每条回退都遵守画质上限的格式表达式。"""
    if format_id:
        return format_id
    normalized = normalize_quality(quality)
    height = parse_quality_height(normalized)
    if height is None:
        return DEFAULT_VIDEO_FORMAT_SELECTOR
    return "/".join(
        [
            f"bestvideo[height<={height}][vcodec^=avc][ext=mp4]+bestaudio[ext=m4a]",
            f"best[height<={height}][vcodec^=avc][ext=mp4]",
            f"bestvideo[height<={height}][ext=mp4]+bestaudio[ext=m4a]",
            f"bestvideo[height<={height}]+bestaudio",
            f"best[height<={height}][ext=mp4]",
            f"best[height<={height}]",
        ]
    )
