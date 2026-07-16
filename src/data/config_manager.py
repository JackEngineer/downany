"""
配置管理器，使用 QSettings 持久化配置。
"""
import os
from typing import Optional

from PyQt6.QtCore import QSettings

from src.core.quality import normalize_quality


class ConfigManager:
    """配置管理器单例类"""
    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._initialized = False
        return cls._instance

    def __init__(self):
        if self._initialized:
            return

        self._initialized = True
        self.settings = QSettings("Trae", "Downloader")
        self._init_defaults()

    def _init_defaults(self):
        """初始化默认配置"""
        if not self.settings.contains("download_dir"):
            default_dir = os.path.join(os.path.expanduser("~"), "Downloads", "TraeDownloader")
            self.settings.setValue("download_dir", default_dir)

        if not self.settings.contains("concurrent_downloads"):
            self.settings.setValue("concurrent_downloads", 3)

        if not self.settings.contains("speed_limit"):
            self.settings.setValue("speed_limit", 0)  # 0 表示无限制

        if not self.settings.contains("proxy_enabled"):
            self.settings.setValue("proxy_enabled", False)

        if not self.settings.contains("proxy_url"):
            self.settings.setValue("proxy_url", "")

        if not self.settings.contains("default_quality"):
            self.settings.setValue("default_quality", "best")

        if not self.settings.contains("download_subtitles"):
            self.settings.setValue("download_subtitles", False)

        if not self.settings.contains("theme_mode"):
            self.settings.setValue("theme_mode", "system")

    # 下载目录
    def get_download_dir(self) -> str:
        return self.settings.value("download_dir", type=str)

    def set_download_dir(self, path: str):
        self.settings.setValue("download_dir", path)

    # 并发下载数
    def get_concurrent_downloads(self) -> int:
        return self.settings.value("concurrent_downloads", type=int)

    def set_concurrent_downloads(self, count: int):
        self.settings.setValue("concurrent_downloads", max(1, min(count, 10)))

    # 速度限制
    def get_speed_limit(self) -> int:
        return self.settings.value("speed_limit", type=int)

    def set_speed_limit(self, limit: int):
        self.settings.setValue("speed_limit", max(0, limit))

    # 代理设置
    def is_proxy_enabled(self) -> bool:
        return self.settings.value("proxy_enabled", type=bool)

    def set_proxy_enabled(self, enabled: bool):
        self.settings.setValue("proxy_enabled", enabled)

    def get_proxy_url(self) -> str:
        return self.settings.value("proxy_url", type=str)

    def set_proxy_url(self, url: str):
        self.settings.setValue("proxy_url", url)

    # 默认质量
    def get_default_quality(self) -> str:
        return normalize_quality(self.settings.value("default_quality", "best", type=str))

    def set_default_quality(self, quality: str):
        self.settings.setValue("default_quality", normalize_quality(quality))

    def get_proxy_for_download(self) -> Optional[str]:
        """启用且非空时返回代理 URL，否则 None。"""
        if not self.is_proxy_enabled():
            return None
        url = (self.get_proxy_url() or "").strip()
        return url or None

    def build_download_options(self, output_path: Optional[str] = None):
        """统一构造各入口共用的 DownloadOptions。"""
        from src.core.download_task import DownloadOptions

        speed = self.get_speed_limit() or 0
        return DownloadOptions(
            quality=self.get_default_quality(),
            download_subtitles=self.is_download_subtitles(),
            output_path=output_path or self.get_download_dir(),
            speed_limit=speed if speed > 0 else None,
            proxy=self.get_proxy_for_download(),
        )

    # 字幕下载
    def is_download_subtitles(self) -> bool:
        return self.settings.value("download_subtitles", type=bool)

    def set_download_subtitles(self, enabled: bool):
        self.settings.setValue("download_subtitles", enabled)

    # 主题模式
    def get_theme_mode(self) -> str:
        value = self.settings.value("theme_mode", "system", type=str)
        return value if value in {"system", "light", "dark"} else "system"

    def set_theme_mode(self, mode: str):
        normalized = (mode or "system").strip().lower()
        if normalized not in {"system", "light", "dark"}:
            normalized = "system"
        self.settings.setValue("theme_mode", normalized)
