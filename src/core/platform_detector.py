"""
平台识别器，根据 URL 识别视频平台。
"""
from __future__ import annotations

import re
from typing import Any, Dict, Optional, Tuple

from src.core.download_task import Platform


def normalize_thumbnail_url(url: str) -> str:
    """封面地址归一：补全协议、http→https（Electron/浏览器更稳）。"""
    text = (url or "").strip()
    if not text:
        return ""
    if text.startswith("//"):
        text = "https:" + text
    if text.startswith("http://"):
        text = "https://" + text[len("http://") :]
    return text


def pick_thumbnail_from_ydl_info(info: Dict[str, Any]) -> str:
    """从 yt-dlp info 选一张尽量大的封面。"""
    if not isinstance(info, dict):
        return ""
    direct = info.get("thumbnail")
    if isinstance(direct, str) and direct.strip():
        return normalize_thumbnail_url(direct)

    thumbs = info.get("thumbnails")
    if isinstance(thumbs, list) and thumbs:
        best = ""
        best_area = -1
        for entry in thumbs:
            if not isinstance(entry, dict):
                continue
            url = entry.get("url")
            if not isinstance(url, str) or not url.strip():
                continue
            w = entry.get("width") or 0
            h = entry.get("height") or 0
            try:
                area = int(w) * int(h)
            except (TypeError, ValueError):
                area = 0
            # preference / id 作弱排序
            pref = entry.get("preference")
            try:
                score = area + (int(pref) if pref is not None else 0)
            except (TypeError, ValueError):
                score = area
            if score >= best_area:
                best_area = score
                best = url.strip()
        if best:
            return normalize_thumbnail_url(best)
    return ""


class PlatformDetector:
    """平台识别器类"""

    # 平台 URL 模式
    PATTERNS = {
        Platform.YOUTUBE: [
            r"(?:https?://)?(?:www\.)?youtube\.com/",
            r"(?:https?://)?(?:www\.)?youtu\.be/",
            r"(?:https?://)?(?:m\.)?youtube\.com/",
        ],
        Platform.BILIBILI: [
            r"(?:https?://)?(?:www\.)?bilibili\.com/",
            r"(?:https?://)?(?:m\.)?bilibili\.com/",
            r"(?:https?://)?(?:www\.)?b23\.tv/",
        ],
        Platform.DOUYIN: [
            r"(?:https?://)?(?:www\.)?douyin\.com/",
            r"(?:https?://)?v\.douyin\.com/",
        ],
        Platform.TIKTOK: [
            r"(?:https?://)?(?:www\.)?tiktok\.com/",
            r"(?:https?://)?(?:vm|vt)\.tiktok\.com/",
        ],
        Platform.TWITTER: [
            r"(?:https?://)?(?:www\.)?twitter\.com/",
            r"(?:https?://)?(?:www\.)?x\.com/",
        ],
        Platform.INSTAGRAM: [
            r"(?:https?://)?(?:www\.)?instagram\.com/",
        ],
        Platform.PORNHUB: [
            # www / cn / pt 等地区站
            r"(?:https?://)?(?:[\w-]+\.)?pornhub\.com/",
            # 直链 CDN（扩展嗅探常落到这里）
            r"(?:https?://)?(?:[\w.-]+\.)?phncdn\.com/",
        ],
    }

    # 平台图标 (emoji)
    ICONS = {
        Platform.YOUTUBE: "▶️",
        Platform.BILIBILI: "📺",
        Platform.DOUYIN: "🎵",
        Platform.TIKTOK: "🎵",
        Platform.TWITTER: "🐦",
        Platform.INSTAGRAM: "📷",
        Platform.PORNHUB: "🔞",
        Platform.UNKNOWN: "🌐",
    }

    # 平台颜色 (hex)
    COLORS = {
        Platform.YOUTUBE: "#FF0000",
        Platform.BILIBILI: "#00A1D6",
        Platform.DOUYIN: "#000000",
        Platform.TIKTOK: "#000000",
        Platform.TWITTER: "#1DA1F2",
        Platform.INSTAGRAM: "#E4405F",
        Platform.PORNHUB: "#FF9900",
        Platform.UNKNOWN: "#808080",
    }

    @classmethod
    def detect(cls, url: str) -> Platform:
        """
        检测 URL 所属的平台。

        Args:
            url: 视频 URL

        Returns:
            Platform 枚举值
        """
        for platform, patterns in cls.PATTERNS.items():
            for pattern in patterns:
                if re.search(pattern, url or "", re.IGNORECASE):
                    return platform

        return Platform.UNKNOWN

    @classmethod
    def detect_with_context(
        cls,
        url: str,
        *,
        referer: Optional[str] = None,
        page_url: Optional[str] = None,
        title: Optional[str] = None,
    ) -> Platform:
        """优先用媒体 URL，其次 Referer / 页面链接，再弱匹配标题。"""
        platform = cls.detect(url)
        if platform != Platform.UNKNOWN:
            return platform
        for candidate in (referer, page_url):
            if candidate:
                platform = cls.detect(candidate)
                if platform != Platform.UNKNOWN:
                    return platform
        text = (title or "").lower()
        if "pornhub" in text or "phncdn" in text:
            return Platform.PORNHUB
        if "bilibili" in text or "b23.tv" in text:
            return Platform.BILIBILI
        return Platform.UNKNOWN

    @classmethod
    def get_icon(cls, platform: Platform) -> str:
        """获取平台图标"""
        return cls.ICONS.get(platform, cls.ICONS[Platform.UNKNOWN])

    @classmethod
    def get_color(cls, platform: Platform) -> str:
        """获取平台颜色"""
        return cls.COLORS.get(platform, cls.COLORS[Platform.UNKNOWN])

    @classmethod
    def get_info(cls, url: str) -> Tuple[Platform, str, str]:
        """
        获取平台完整信息。

        Args:
            url: 视频 URL

        Returns:
            (Platform, icon, color) 元组
        """
        platform = cls.detect(url)
        icon = cls.get_icon(platform)
        color = cls.get_color(platform)
        return platform, icon, color
