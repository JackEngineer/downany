"""
缩略图加载器。
提供异步加载、内存缓存、失败短缓存和重复请求去重能力。
"""
from collections import OrderedDict
from time import monotonic
from typing import Callable, Dict, List, Tuple

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
        self._pixmap_cache: "OrderedDict[str, QPixmap]" = OrderedDict()
        self._failed_cache_expiry: Dict[str, float] = {}
        self._in_flight_keys: Dict[str, str] = {}
        self._reply_context: Dict[QNetworkReply, Tuple[str, str]] = {}
        self._network_manager = QNetworkAccessManager(self)

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

    def _touch_cache(self, item_key: str, pixmap: QPixmap) -> None:
        self._pixmap_cache[item_key] = pixmap
        self._pixmap_cache.move_to_end(item_key)
        while len(self._pixmap_cache) > self._max_cache_size:
            self._pixmap_cache.popitem(last=False)

    def _set_failure_cache(self, item_key: str) -> None:
        if self._failure_ttl_seconds <= 0:
            return
        self._failed_cache_expiry[item_key] = monotonic() + self._failure_ttl_seconds

    def _is_failure_cached(self, item_key: str) -> bool:
        expires_at = self._failed_cache_expiry.get(item_key)
        if expires_at is None:
            return False
        if monotonic() >= expires_at:
            self._failed_cache_expiry.pop(item_key, None)
            return False
        return True

    def _on_reply_finished(self, reply: QNetworkReply) -> None:
        context = self._reply_context.pop(reply, None)
        if not context:
            reply.deleteLater()
            return

        item_key, _request_url = context
        self._in_flight_keys.pop(item_key, None)

        if reply.error() != QNetworkReply.NetworkError.NoError:
            self._set_failure_cache(item_key)
            self.emit_failed(item_key, reply.errorString() or "thumbnail_request_failed")
            reply.deleteLater()
            return

        image_data = bytes(reply.readAll())
        image = QImage.fromData(image_data)
        if image.isNull():
            self._set_failure_cache(item_key)
            self.emit_failed(item_key, "invalid_thumbnail_image")
            reply.deleteLater()
            return

        pixmap = QPixmap.fromImage(image)
        if pixmap.isNull():
            self._set_failure_cache(item_key)
            self.emit_failed(item_key, "invalid_thumbnail_pixmap")
            reply.deleteLater()
            return

        self._failed_cache_expiry.pop(item_key, None)
        self._touch_cache(item_key, pixmap)
        self.emit_loaded(item_key, pixmap)
        reply.deleteLater()

    def request_thumbnail(self, item_key: str, thumbnail_url: str) -> None:
        """请求加载缩略图（缓存命中时立即返回，未命中时异步加载）。"""
        if not thumbnail_url:
            self.emit_failed(item_key, "empty_thumbnail_url")
            return

        cached = self._pixmap_cache.get(item_key)
        if cached is not None and not cached.isNull():
            self._pixmap_cache.move_to_end(item_key)
            self._emit_loaded_async(item_key, cached)
            return

        if self._is_failure_cached(item_key):
            self.emit_failed(item_key, "thumbnail_recently_failed")
            return

        in_flight_url = self._in_flight_keys.get(item_key)
        if in_flight_url == thumbnail_url:
            return
        if in_flight_url is not None:
            return

        request = QNetworkRequest(QUrl(thumbnail_url))
        reply = self._network_manager.get(request)
        self._in_flight_keys[item_key] = thumbnail_url
        self._reply_context[reply] = (item_key, thumbnail_url)
        reply.finished.connect(lambda r=reply: self._on_reply_finished(r))
