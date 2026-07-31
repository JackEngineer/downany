"""Qt 无关的 JSON 配置读写（Sidecar 使用）。"""
from __future__ import annotations

import json
import os
import re
import tempfile
from typing import Any, Dict, Optional

from src.core.download_task import DownloadOptions
from src.core.quality import normalize_quality

VALID_POSTPROCESSING = {"none", "mp4", "mp3", "script"}

# 文件名模板允许的 yt-dlp 占位符白名单
TEMPLATE_PLACEHOLDER_RE = re.compile(r"%\((\w+)\)s")
ALLOWED_TEMPLATE_FIELDS = {
    "title",
    "uploader",
    "id",
    "ext",
    "upload_date",
    "resolution",
    "duration_string",
    "height",
    "width",
    "fps",
    "format_id",
    "extractor",
}


def validate_filename_template(template: str) -> str:
    """校验 outtmpl 模板；非法抛出 ValueError，合法原样返回。"""
    text = str(template or "").strip()
    if not text:
        return ""
    if os.path.isabs(text) or ".." in text.split(os.sep):
        raise ValueError("文件名模板不能是绝对路径或包含 ..")
    fields = TEMPLATE_PLACEHOLDER_RE.findall(text)
    unknown = [f for f in fields if f not in ALLOWED_TEMPLATE_FIELDS]
    if unknown:
        raise ValueError(f"文件名模板包含不支持的占位符: {', '.join(unknown)}")
    if "%(ext)s" not in text:
        raise ValueError("文件名模板必须包含 %(ext)s 占位符")
    return text


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
            "auto_start_downloads": True,
            "clipboard_monitor": False,
            "postprocessing": "none",
            "postprocess_script": "",
            "filename_template": "",
            "menu_bar_mode": False,
            "dock_progress": True,
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
        next_data["auto_start_downloads"] = bool(next_data.get("auto_start_downloads", True))
        next_data["clipboard_monitor"] = bool(next_data.get("clipboard_monitor", False))
        next_data["menu_bar_mode"] = bool(next_data.get("menu_bar_mode", False))
        next_data["dock_progress"] = bool(next_data.get("dock_progress", True))
        postprocessing = str(next_data.get("postprocessing", "none")).strip().lower()
        if postprocessing not in VALID_POSTPROCESSING:
            raise ValueError("后处理必须是 none / mp4 / mp3 / script")
        next_data["postprocessing"] = postprocessing
        next_data["postprocess_script"] = str(next_data.get("postprocess_script", "") or "")
        next_data["filename_template"] = validate_filename_template(
            str(next_data.get("filename_template", "") or "")
        )
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

    def is_auto_start_downloads(self) -> bool:
        return bool(self._data.get("auto_start_downloads", True))

    def is_clipboard_monitor(self) -> bool:
        return bool(self._data.get("clipboard_monitor", False))

    def is_menu_bar_mode(self) -> bool:
        return bool(self._data.get("menu_bar_mode", False))

    def is_dock_progress(self) -> bool:
        return bool(self._data.get("dock_progress", True))

    def get_postprocessing(self) -> str:
        value = str(self._data.get("postprocessing", "none")).strip().lower()
        return value if value in VALID_POSTPROCESSING else "none"

    def get_postprocess_script(self) -> str:
        return str(self._data.get("postprocess_script", "") or "")

    def get_filename_template(self) -> str:
        return str(self._data.get("filename_template", "") or "")

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
            postprocessing=self.get_postprocessing(),
            filename_template=self.get_filename_template(),
            postprocess_script=self.get_postprocess_script(),
        )
