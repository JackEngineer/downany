"""
缩略图加载器接口。
提供信号与回调，便于后续接入懒加载/缓存策略。
"""
from typing import Callable, List

from PyQt6.QtCore import QObject, pyqtSignal
from PyQt6.QtGui import QPixmap


class ThumbnailLoader(QObject):
    """可复用的缩略图加载器接口。"""

    thumbnail_loaded = pyqtSignal(str, QPixmap)
    thumbnail_failed = pyqtSignal(str, str)

    def __init__(self):
        super().__init__()
        self._loaded_callbacks: List[Callable[[str, QPixmap], None]] = []

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

    def request_thumbnail(self, item_key: str, thumbnail_url: str) -> None:
        """
        请求加载缩略图。
        Task2 仅提供接口占位，具体懒加载与缓存策略由后续任务实现。
        """
        if not thumbnail_url:
            self.emit_failed(item_key, "empty_thumbnail_url")
