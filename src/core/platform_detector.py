"""
平台识别器，根据 URL 识别视频平台。
"""
import re
from typing import Tuple, Optional
from src.core.download_task import Platform


class PlatformDetector:
    """平台识别器类"""

    # 平台 URL 模式
    PATTERNS = {
        Platform.YOUTUBE: [
            r'(?:https?://)?(?:www\.)?youtube\.com/',
            r'(?:https?://)?(?:www\.)?youtu\.be/',
            r'(?:https?://)?(?:m\.)?youtube\.com/',
        ],
        Platform.BILIBILI: [
            r'(?:https?://)?(?:www\.)?bilibili\.com/',
            r'(?:https?://)?(?:www\.)?b23\.tv/',
        ],
        Platform.DOUYIN: [
            r'(?:https?://)?(?:www\.)?douyin\.com/',
            r'(?:https?://)?v\.douyin\.com/',
        ],
        Platform.TIKTOK: [
            r'(?:https?://)?(?:www\.)?tiktok\.com/',
            r'(?:https?://)?(?:vm|vt)\.tiktok\.com/',
        ],
        Platform.TWITTER: [
            r'(?:https?://)?(?:www\.)?twitter\.com/',
            r'(?:https?://)?(?:www\.)?x\.com/',
        ],
        Platform.INSTAGRAM: [
            r'(?:https?://)?(?:www\.)?instagram\.com/',
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
                if re.search(pattern, url, re.IGNORECASE):
                    return platform

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

