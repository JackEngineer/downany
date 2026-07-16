"""下载质量字符串解析。"""
import re
from typing import Optional

VALID_QUALITIES = frozenset({"best", "1080p", "720p", "480p", "360p"})


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


def build_format_selector(quality: str, format_id: Optional[str] = None) -> Optional[str]:
    """根据质量或 format_id 生成 yt-dlp format 表达式；None 表示用默认。"""
    if format_id:
        return format_id
    normalized = normalize_quality(quality)
    height = parse_quality_height(normalized)
    if height is None:
        return None
    return f"bestvideo[height<={height}]+bestaudio/best"
