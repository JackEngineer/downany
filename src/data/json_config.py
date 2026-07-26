"""Qt 无关的 JSON 配置读写（Sidecar 使用）。"""
from __future__ import annotations

import json
import os
import tempfile
from typing import Any, Dict, Optional

from src.core.download_task import DownloadOptions
from src.core.quality import normalize_quality


class JsonConfig:
    """基于 JSON 文件的配置，满足 DownloadConfig 协议。"""

    def __init__(self, path: str):
        self.path = path
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        self._data: Dict[str, Any] = {}
        self._load_or_init()

    def _default_download_dir(self) -> str:
        return os.path.join(os.path.expanduser("~"), "Downloads", "VideoDownloader")

    def _sanitize_download_dir(self, path: str) -> str:
        text = str(path or "").strip() or self._default_download_dir()
        if "TraeDownloader" in text:
            text = text.replace("TraeDownloader", "VideoDownloader")
        return text

    def _defaults(self) -> Dict[str, Any]:
        return {
            "download_dir": self._default_download_dir(),
            "concurrent_downloads": 3,
            "speed_limit": 0,
            "proxy_enabled": False,
            "proxy_url": "",
            "default_quality": "best",
            "download_subtitles": False,
            "theme_mode": "system",
        }

    def _load_or_init(self) -> None:
        if os.path.isfile(self.path):
            with open(self.path, "r", encoding="utf-8") as fh:
                loaded = json.load(fh)
            if not isinstance(loaded, dict):
                loaded = {}
            merged = self._defaults()
            merged.update(loaded)
            merged["download_dir"] = self._sanitize_download_dir(
                str(merged.get("download_dir") or "")
            )
            self._data = merged
            # 若从旧 Trae 路径纠正过来，落盘一次
            if loaded.get("download_dir") != self._data["download_dir"]:
                self._save()
        else:
            self._data = self._defaults()
            self._save()

    def _save(self) -> None:
        directory = os.path.dirname(self.path) or "."
        fd, tmp_name = tempfile.mkstemp(prefix="config-", suffix=".json", dir=directory)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(self._data, fh, ensure_ascii=False, indent=2)
                fh.write("\n")
            os.replace(tmp_name, self.path)
        except Exception:
            try:
                os.unlink(tmp_name)
            except OSError:
                pass
            raise

    def to_dict(self) -> Dict[str, Any]:
        return dict(self._data)

    def update_from_dict(self, partial: Dict[str, Any]) -> Dict[str, Any]:
        if not isinstance(partial, dict):
            raise ValueError("设置必须是对象")
        next_data = dict(self._data)
        next_data.update(partial)

        concurrent = int(next_data.get("concurrent_downloads", 3))
        if concurrent < 1 or concurrent > 10:
            raise ValueError("并发数必须在 1–10 之间")
        next_data["concurrent_downloads"] = concurrent

        theme = str(next_data.get("theme_mode", "system")).strip().lower()
        if theme not in {"system", "light", "dark"}:
            raise ValueError("主题必须是 system / light / dark")
        next_data["theme_mode"] = theme

        next_data["default_quality"] = normalize_quality(
            str(next_data.get("default_quality", "best"))
        )
        next_data["speed_limit"] = max(0, int(next_data.get("speed_limit", 0) or 0))
        next_data["proxy_enabled"] = bool(next_data.get("proxy_enabled", False))
        next_data["proxy_url"] = str(next_data.get("proxy_url", "") or "")
        next_data["download_subtitles"] = bool(next_data.get("download_subtitles", False))
        next_data["download_dir"] = str(next_data.get("download_dir") or self._default_download_dir())

        if next_data["proxy_enabled"] and not next_data["proxy_url"].strip():
            raise ValueError("启用代理时地址不能为空")

        self._data = next_data
        self._save()
        return self.to_dict()

    def get_download_dir(self) -> str:
        return str(self._data.get("download_dir") or self._default_download_dir())

    def set_download_dir(self, path: str) -> None:
        self._data["download_dir"] = path
        self._save()

    def get_concurrent_downloads(self) -> int:
        return int(self._data.get("concurrent_downloads", 3))

    def set_concurrent_downloads(self, count: int) -> None:
        self._data["concurrent_downloads"] = max(1, min(int(count), 10))
        self._save()

    def get_speed_limit(self) -> int:
        return int(self._data.get("speed_limit", 0) or 0)

    def set_speed_limit(self, limit: int) -> None:
        self._data["speed_limit"] = max(0, int(limit))
        self._save()

    def is_proxy_enabled(self) -> bool:
        return bool(self._data.get("proxy_enabled", False))

    def set_proxy_enabled(self, enabled: bool) -> None:
        self._data["proxy_enabled"] = bool(enabled)
        self._save()

    def get_proxy_url(self) -> str:
        return str(self._data.get("proxy_url", "") or "")

    def set_proxy_url(self, url: str) -> None:
        self._data["proxy_url"] = str(url or "")
        self._save()

    def get_default_quality(self) -> str:
        return normalize_quality(str(self._data.get("default_quality", "best")))

    def set_default_quality(self, quality: str) -> None:
        self._data["default_quality"] = normalize_quality(quality)
        self._save()

    def is_download_subtitles(self) -> bool:
        return bool(self._data.get("download_subtitles", False))

    def set_download_subtitles(self, enabled: bool) -> None:
        self._data["download_subtitles"] = bool(enabled)
        self._save()

    def get_theme_mode(self) -> str:
        value = str(self._data.get("theme_mode", "system"))
        return value if value in {"system", "light", "dark"} else "system"

    def set_theme_mode(self, mode: str) -> None:
        normalized = (mode or "system").strip().lower()
        if normalized not in {"system", "light", "dark"}:
            normalized = "system"
        self._data["theme_mode"] = normalized
        self._save()

    def get_proxy_for_download(self) -> Optional[str]:
        if not self.is_proxy_enabled():
            return None
        url = (self.get_proxy_url() or "").strip()
        return url or None

    def build_download_options(self, output_path: Optional[str] = None) -> DownloadOptions:
        speed = self.get_speed_limit() or 0
        return DownloadOptions(
            quality=self.get_default_quality(),
            download_subtitles=self.is_download_subtitles(),
            output_path=output_path or self.get_download_dir(),
            speed_limit=speed if speed > 0 else None,
            proxy=self.get_proxy_for_download(),
        )
