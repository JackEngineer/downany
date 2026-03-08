"""
缩略图加载器。
提供异步加载、内存缓存、失败短缓存和重复请求去重能力。
"""
from collections import OrderedDict
import json
from time import monotonic
import time
from typing import Callable, Dict, List

from PyQt6.QtCore import QObject, QTimer, QUrl, pyqtSignal
from PyQt6.QtGui import QImage, QPixmap
from PyQt6.QtNetwork import QNetworkAccessManager, QNetworkReply, QNetworkRequest


class ThumbnailLoader(QObject):
    """可复用的缩略图加载器接口。"""

    thumbnail_loaded = pyqtSignal(str, QPixmap)
    thumbnail_failed = pyqtSignal(str, str)

    def __init__(self, max_cache_size: int = 64, failure_ttl_seconds: float = 10.0):
        super().__init__()
        self._loaded_callbacks: List[Callable[[str, QPixmap], None]] = []
        self._max_cache_size = max(1, max_cache_size)
        self._failure_ttl_seconds = max(0.0, failure_ttl_seconds)
        # 缓存语义按 thumbnail_url 维度
        self._pixmap_cache: "OrderedDict[str, QPixmap]" = OrderedDict()
        self._failed_cache_expiry: Dict[str, float] = {}
        self._in_flight_waiters: Dict[str, List[str]] = {}
        self._reply_context: Dict[QNetworkReply, str] = {}
        self._network_manager = QNetworkAccessManager(self)

    def _debug_log(self, hypothesis_id: str, location: str, message: str, data: dict = None, run_id: str = "initial") -> None:
        # region agent log
        payload = {
            "sessionId": "5680ec",
            "runId": run_id,
            "hypothesisId": hypothesis_id,
            "location": location,
            "message": message,
            "data": data or {},
            "timestamp": int(time.time() * 1000),
        }
        try:
            with open("/Users/jacklee/work/personal/trae/downloader/.cursor/debug-5680ec.log", "a", encoding="utf-8") as f:
                f.write(json.dumps(payload, ensure_ascii=False) + "\n")
        except Exception:
            pass
        # endregion

    def add_loaded_callback(self, callback: Callable[[str, QPixmap], None]) -> None:
        """注册缩略图加载成功回调。"""
        self._loaded_callbacks.append(callback)

    def remove_loaded_callback(self, callback: Callable[[str, QPixmap], None]) -> None:
        """移除缩略图加载成功回调。"""
        if callback in self._loaded_callbacks:
            self._loaded_callbacks.remove(callback)

    def emit_loaded(self, item_key: str, pixmap: QPixmap) -> None:
        """对外触发加载成功事件（信号 + 回调）。"""
        self.thumbnail_loaded.emit(item_key, pixmap)
        for callback in list(self._loaded_callbacks):
            callback(item_key, pixmap)

    def emit_failed(self, item_key: str, reason: str) -> None:
        """对外触发加载失败事件。"""
        self.thumbnail_failed.emit(item_key, reason)

    def _emit_loaded_async(self, item_key: str, pixmap: QPixmap) -> None:
        QTimer.singleShot(0, lambda: self.emit_loaded(item_key, pixmap))

    def _touch_cache(self, thumbnail_url: str, pixmap: QPixmap) -> None:
        self._pixmap_cache[thumbnail_url] = pixmap
        self._pixmap_cache.move_to_end(thumbnail_url)
        while len(self._pixmap_cache) > self._max_cache_size:
            self._pixmap_cache.popitem(last=False)

    def _set_failure_cache(self, thumbnail_url: str) -> None:
        if self._failure_ttl_seconds <= 0:
            return
        self._failed_cache_expiry[thumbnail_url] = monotonic() + self._failure_ttl_seconds

    def _is_failure_cached(self, thumbnail_url: str) -> bool:
        expires_at = self._failed_cache_expiry.get(thumbnail_url)
        if expires_at is None:
            return False
        if monotonic() >= expires_at:
            self._failed_cache_expiry.pop(thumbnail_url, None)
            return False
        return True

    def _on_reply_finished(self, reply: QNetworkReply) -> None:
        thumbnail_url = self._reply_context.pop(reply, None)
        if not thumbnail_url:
            reply.deleteLater()
            return

        waiting_item_keys = self._in_flight_waiters.pop(thumbnail_url, [])

        if reply.error() != QNetworkReply.NetworkError.NoError:
            self._set_failure_cache(thumbnail_url)
            reason = reply.errorString() or "thumbnail_request_failed"
            status_code = reply.attribute(QNetworkRequest.Attribute.HttpStatusCodeAttribute)
            self._debug_log(
                "H2",
                "thumbnail_loader.py:_on_reply_finished",
                "thumbnail request failed",
                {
                    "thumbnailUrl": thumbnail_url[:180],
                    "reason": reason,
                    "statusCode": int(status_code) if status_code is not None else None,
                    "waiterCount": len(waiting_item_keys),
                },
            )
            for item_key in waiting_item_keys:
                self.emit_failed(item_key, reason)
            reply.deleteLater()
            return

        image_data = bytes(reply.readAll())
        image = QImage.fromData(image_data)
        if image.isNull():
            self._set_failure_cache(thumbnail_url)
            self._debug_log(
                "H2",
                "thumbnail_loader.py:_on_reply_finished",
                "thumbnail image decode failed",
                {
                    "thumbnailUrl": thumbnail_url[:180],
                    "bytesLength": len(image_data),
                    "waiterCount": len(waiting_item_keys),
                },
            )
            for item_key in waiting_item_keys:
                self.emit_failed(item_key, "invalid_thumbnail_image")
            reply.deleteLater()
            return

        pixmap = QPixmap.fromImage(image)
        if pixmap.isNull():
            self._set_failure_cache(thumbnail_url)
            self._debug_log(
                "H2",
                "thumbnail_loader.py:_on_reply_finished",
                "thumbnail pixmap creation failed",
                {
                    "thumbnailUrl": thumbnail_url[:180],
                    "imageSize": [image.width(), image.height()],
                    "waiterCount": len(waiting_item_keys),
                },
            )
            for item_key in waiting_item_keys:
                self.emit_failed(item_key, "invalid_thumbnail_pixmap")
            reply.deleteLater()
            return

        self._failed_cache_expiry.pop(thumbnail_url, None)
        self._touch_cache(thumbnail_url, pixmap)
        self._debug_log(
            "H2",
            "thumbnail_loader.py:_on_reply_finished",
            "thumbnail loaded successfully",
            {
                "thumbnailUrl": thumbnail_url[:180],
                "size": [pixmap.width(), pixmap.height()],
                "waiterCount": len(waiting_item_keys),
            },
        )
        for item_key in waiting_item_keys:
            self.emit_loaded(item_key, pixmap)
        reply.deleteLater()

    def request_thumbnail(self, item_key: str, thumbnail_url: str) -> None:
        """请求加载缩略图（缓存命中时立即返回，未命中时异步加载）。"""
        if not thumbnail_url:
            self._debug_log(
                "H1",
                "thumbnail_loader.py:request_thumbnail",
                "empty thumbnail url",
                {"itemKey": (item_key or "")[:120]},
            )
            self.emit_failed(item_key, "empty_thumbnail_url")
            return

        cached = self._pixmap_cache.get(thumbnail_url)
        if cached is not None and not cached.isNull():
            self._pixmap_cache.move_to_end(thumbnail_url)
            self._emit_loaded_async(item_key, cached)
            return

        if self._is_failure_cached(thumbnail_url):
            self._debug_log(
                "H2",
                "thumbnail_loader.py:request_thumbnail",
                "thumbnail skipped due failure cache",
                {"thumbnailUrl": thumbnail_url[:180], "itemKey": (item_key or "")[:120]},
            )
            self.emit_failed(item_key, "thumbnail_recently_failed")
            return

        waiters = self._in_flight_waiters.get(thumbnail_url)
        if waiters is not None:
            if item_key not in waiters:
                waiters.append(item_key)
            return

        request = QNetworkRequest(QUrl(thumbnail_url))
        reply = self._network_manager.get(request)
        self._in_flight_waiters[thumbnail_url] = [item_key]
        self._reply_context[reply] = thumbnail_url
        reply.finished.connect(lambda r=reply: self._on_reply_finished(r))
