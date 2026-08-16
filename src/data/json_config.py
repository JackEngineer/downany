"""Qt 无关的 JSON 配置读写（Sidecar 使用）。"""
from __future__ import annotations

import json
import os
import re
import tempfile
import threading
import hashlib
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from src.core.download_task import DownloadOptions
from src.core.quality import normalize_quality
from src.core.system_proxy import detect_system_proxy

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
        self._lock = threading.RLock()
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        self._data: Dict[str, Any] = {}
        self._load_or_init()

    def _default_download_dir(self) -> str:
        return os.path.join(os.path.expanduser("~"), "Downloads", "Downany")

    def _sanitize_download_dir(self, path: str) -> str:
        text = str(path or "").strip() or self._default_download_dir()
        for old in ("TraeDownloader", "VideoDownloader"):
            if old in text:
                text = text.replace(old, "Downany")
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
            "theme_mode": "dark",
            "auto_start_downloads": True,
            "clipboard_monitor": False,
            "postprocessing": "none",
            "postprocess_script": "",
            "filename_template": "",
            "menu_bar_mode": False,
            "dock_progress": True,
            "cookies_from_browser": "",
            "embed_metadata": True,
            "subtitle_langs": "",
            "embed_subs": False,
            "concurrent_fragments": 4,
            "download_sections": "",
            "sponsorblock_remove": "",
            "telemetry_enabled": False,
            # Telegram stores routing metadata only.  The Bot Token is owned
            # by Electron's credential vault and must never enter this file.
            "telegram_account_id": "",
            "telegram_bot_username": "",
            "telegram_target_chat_id": "",
            "telegram_target_chat_type": "",
            "telegram_target_chat_title": "",
            "telegram_target_verified_at": None,
            "telegram_auto_send_enabled": False,
            "telegram_enabled_at": None,
            "telegram_discovered_targets": [],
            "telegram_next_update_offset": None,
            "telegram_delivery_recovery_hold": None,
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

    def reload_from_disk(self) -> Dict[str, Any]:
        """Reload the JSON atomically for cross-process callers."""
        with self._lock:
            if not os.path.isfile(self.path):
                return self.to_dict()
            with open(self.path, "r", encoding="utf-8") as fh:
                loaded = json.load(fh)
            if not isinstance(loaded, dict):
                raise ValueError("配置文件必须是对象")
            merged = self._defaults()
            merged.update(loaded)
            merged["download_dir"] = self._sanitize_download_dir(
                str(merged.get("download_dir") or "")
            )
            self._data = merged
            return self.to_dict()

    def to_dict(self) -> Dict[str, Any]:
        with self._lock:
            return dict(self._data)

    def telegram_revision(self) -> str:
        with self._lock:
            payload = {
                key: self._data.get(key)
                for key in (
                    "telegram_account_id",
                    "telegram_bot_username",
                    "telegram_target_chat_id",
                    "telegram_target_chat_type",
                    "telegram_target_chat_title",
                    "telegram_target_verified_at",
                    "telegram_auto_send_enabled",
                    "telegram_enabled_at",
                    "telegram_discovered_targets",
                    "telegram_next_update_offset",
                    "telegram_delivery_recovery_hold",
                )
            }
            raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            return hashlib.sha256(raw.encode("utf-8")).hexdigest()

    @staticmethod
    def _reject_telegram_secrets(patch: Dict[str, Any]) -> None:
        forbidden = {
            "token", "bot_token", "botToken", "telegram_token", "telegramToken",
            "api_id", "api_hash", "apiId", "apiHash", "secret", "password",
        }
        leaked = sorted(key for key in patch if key in forbidden or "token" in key.lower())
        if leaked:
            raise ValueError("Telegram 密钥只能通过安全凭据保险箱传递")

    def telegram_config(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "revision": self.telegram_revision(),
                "accountId": str(self._data.get("telegram_account_id") or ""),
                "botUsername": str(self._data.get("telegram_bot_username") or ""),
                "targetChatId": str(self._data.get("telegram_target_chat_id") or ""),
                "targetChatType": str(self._data.get("telegram_target_chat_type") or ""),
                "targetChatTitle": str(self._data.get("telegram_target_chat_title") or ""),
                "targetVerifiedAt": self._data.get("telegram_target_verified_at"),
                "autoSendEnabled": bool(self._data.get("telegram_auto_send_enabled", False)),
                "enabledAt": self._data.get("telegram_enabled_at"),
                "discoveredTargets": list(self._data.get("telegram_discovered_targets") or [])[-200:],
                "nextUpdateOffset": self._data.get("telegram_next_update_offset"),
                "deliveryRecoveryHold": self._data.get("telegram_delivery_recovery_hold"),
            }

    def configure_telegram(self, patch: Dict[str, Any], *, now: Optional[str] = None) -> Dict[str, Any]:
        if not isinstance(patch, dict):
            raise ValueError("Telegram 配置必须是对象")
        self._reject_telegram_secrets(patch)
        allowed = {
            "accountId", "botUsername", "targetChatId", "targetChatType", "targetChatTitle",
            "targetVerifiedAt", "autoSendEnabled", "enabledAt", "discoveredTargets",
            "nextUpdateOffset", "deliveryRecoveryHold",
        }
        unknown = sorted(set(patch) - allowed)
        if unknown:
            raise ValueError(f"未知 Telegram 配置字段: {', '.join(unknown)}")
        with self._lock:
            current_enabled = bool(self._data.get("telegram_auto_send_enabled", False))
            next_enabled = bool(patch.get("autoSendEnabled", current_enabled))
            account = str(patch.get("accountId", self._data.get("telegram_account_id", "")) or "").strip()
            target = str(patch.get("targetChatId", self._data.get("telegram_target_chat_id", "")) or "").strip()
            verified = patch.get("targetVerifiedAt", self._data.get("telegram_target_verified_at"))
            if next_enabled and (not account or not target or not verified):
                raise ValueError("启用自动发送前必须完成 Bot 绑定和接收位置验证")
            mapping = {
                "accountId": "telegram_account_id",
                "botUsername": "telegram_bot_username",
                "targetChatId": "telegram_target_chat_id",
                "targetChatType": "telegram_target_chat_type",
                "targetChatTitle": "telegram_target_chat_title",
                "targetVerifiedAt": "telegram_target_verified_at",
                "autoSendEnabled": "telegram_auto_send_enabled",
                "discoveredTargets": "telegram_discovered_targets",
                "nextUpdateOffset": "telegram_next_update_offset",
                "deliveryRecoveryHold": "telegram_delivery_recovery_hold",
            }
            for key, field in mapping.items():
                if key in patch:
                    value = patch[key]
                    if key == "discoveredTargets":
                        if not isinstance(value, list):
                            raise ValueError("discoveredTargets 必须是数组")
                        value = value[-200:]
                    if key == "nextUpdateOffset" and value is not None:
                        if not isinstance(value, str) or not re.fullmatch(r"(?:0|[1-9][0-9]*)", value):
                            raise ValueError("nextUpdateOffset 必须是无符号十进制字符串或 null")
                    self._data[field] = value
            if "autoSendEnabled" in patch:
                self._data["telegram_auto_send_enabled"] = next_enabled
                if next_enabled and not current_enabled:
                    self._data["telegram_enabled_at"] = now or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
                elif not next_enabled:
                    self._data["telegram_enabled_at"] = None
            if "enabledAt" in patch:
                self._data["telegram_enabled_at"] = patch["enabledAt"]
            self._save()
            return self.telegram_config()

    def update_from_dict(self, partial: Dict[str, Any]) -> Dict[str, Any]:
        self._reject_telegram_secrets(partial)
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
        next_data["cookies_from_browser"] = str(
            next_data.get("cookies_from_browser", "") or ""
        )
        next_data["embed_metadata"] = bool(next_data.get("embed_metadata", True))
        next_data["subtitle_langs"] = str(next_data.get("subtitle_langs", "") or "")
        next_data["embed_subs"] = bool(next_data.get("embed_subs", False))
        next_data["concurrent_fragments"] = max(
            0, int(next_data.get("concurrent_fragments", 4) or 0)
        )
        next_data["download_sections"] = str(next_data.get("download_sections", "") or "")
        next_data["sponsorblock_remove"] = str(
            next_data.get("sponsorblock_remove", "") or ""
        )
        next_data["telemetry_enabled"] = bool(next_data.get("telemetry_enabled", False))
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

    def is_telemetry_enabled(self) -> bool:
        return bool(self._data.get("telemetry_enabled", False))

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
        url = (self.get_proxy_url() or "").strip()
        if self.is_proxy_enabled():
            return url or None
        # 保留“填写但关闭”的语义；没有手动地址时才复用系统/本机代理。
        if url:
            return None
        return detect_system_proxy()

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
            cookies_from_browser=str(self._data.get("cookies_from_browser", "") or ""),
            embed_metadata=bool(self._data.get("embed_metadata", True)),
            subtitle_langs=str(self._data.get("subtitle_langs", "") or ""),
            embed_subs=bool(self._data.get("embed_subs", False)),
            concurrent_fragments=int(self._data.get("concurrent_fragments", 4) or 0),
            download_sections=str(self._data.get("download_sections", "") or ""),
            sponsorblock_remove=str(self._data.get("sponsorblock_remove", "") or ""),
        )
