"""
轻量级 toast / 横幅通知。

Fluent 可用时使用 InfoBar；否则使用自绘顶部浮层。
"""
from __future__ import annotations

from typing import Callable, Optional

from PyQt6.QtCore import Qt, QTimer
from PyQt6.QtWidgets import QFrame, QHBoxLayout, QLabel, QPushButton, QVBoxLayout, QWidget

from src.ui.fluent_support import import_qfluentwidgets


class ToastService:
    """全局 toast 服务，挂在主窗口上使用。"""

    def __init__(self, parent: QWidget, use_fluent: bool = False):
        self._parent = parent
        self._use_fluent = use_fluent
        self._legacy_toast: Optional[QFrame] = None
        self._legacy_timer: Optional[QTimer] = None

    def show_success(
        self,
        title: str,
        content: str = "",
        action_label: Optional[str] = None,
        action_cb: Optional[Callable[[], None]] = None,
        duration_ms: int = 2500,
    ) -> None:
        self._show("success", title, content, action_label, action_cb, duration_ms)

    def show_warning(
        self,
        title: str,
        content: str = "",
        action_label: Optional[str] = None,
        action_cb: Optional[Callable[[], None]] = None,
        duration_ms: int = 3000,
    ) -> None:
        self._show("warning", title, content, action_label, action_cb, duration_ms)

    def show_error(
        self,
        title: str,
        content: str = "",
        action_label: Optional[str] = None,
        action_cb: Optional[Callable[[], None]] = None,
        duration_ms: int = 3500,
    ) -> None:
        self._show("error", title, content, action_label, action_cb, duration_ms)

    def show_info(
        self,
        title: str,
        content: str = "",
        action_label: Optional[str] = None,
        action_cb: Optional[Callable[[], None]] = None,
        duration_ms: int = 2500,
    ) -> None:
        self._show("info", title, content, action_label, action_cb, duration_ms)

    def _show(
        self,
        level: str,
        title: str,
        content: str,
        action_label: Optional[str],
        action_cb: Optional[Callable[[], None]],
        duration_ms: int,
    ) -> None:
        if action_label and action_cb:
            self._show_legacy(level, title, content, action_label, action_cb, duration_ms)
            return

        if self._use_fluent and self._try_fluent(level, title, content, duration_ms):
            return
        self._show_legacy(level, title, content, None, None, duration_ms)

    def _try_fluent(self, level: str, title: str, content: str, duration_ms: int) -> bool:
        qfw = import_qfluentwidgets()
        if qfw is None:
            return False
        info_bar = getattr(qfw, "InfoBar", None)
        info_bar_position = getattr(qfw, "InfoBarPosition", None)
        if info_bar is None:
            return False

        position = getattr(info_bar_position, "TOP_RIGHT", None) if info_bar_position else None
        method = getattr(info_bar, level, None) or getattr(info_bar, "info", None)
        if method is None:
            return False

        try:
            kwargs = {
                "title": title,
                "content": content or "",
                "parent": self._parent,
                "duration": duration_ms,
                "isClosable": True,
            }
            if position is not None:
                kwargs["position"] = position
            method(**kwargs)
            return True
        except Exception:
            return False

    def _show_legacy(
        self,
        level: str,
        title: str,
        content: str,
        action_label: Optional[str],
        action_cb: Optional[Callable[[], None]],
        duration_ms: int,
    ) -> None:
        self._hide_legacy()

        frame = QFrame(self._parent)
        frame.setObjectName("ToastFrame")
        frame.setProperty("level", level)
        frame.setWindowFlags(Qt.WindowType.FramelessWindowHint | Qt.WindowType.SubWindow)
        frame.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents, False)

        layout = QVBoxLayout(frame)
        layout.setContentsMargins(16, 12, 16, 12)
        layout.setSpacing(6)

        title_label = QLabel(title)
        title_label.setObjectName("ToastTitle")
        layout.addWidget(title_label)

        if content:
            content_label = QLabel(content)
            content_label.setObjectName("ToastContent")
            content_label.setWordWrap(True)
            layout.addWidget(content_label)

        if action_label and action_cb:
            action_row = QHBoxLayout()
            action_row.addStretch()
            action_btn = QPushButton(action_label)
            action_btn.setObjectName("ghostActionButton")

            def _on_action():
                action_cb()
                self._hide_legacy()

            action_btn.clicked.connect(_on_action)
            action_row.addWidget(action_btn)
            layout.addLayout(action_row)

        parent_rect = self._parent.rect()
        frame.adjustSize()
        x = parent_rect.width() - frame.width() - 24
        y = 16
        frame.move(max(16, x), y)
        frame.show()
        frame.raise_()

        self._legacy_toast = frame
        self._legacy_timer = QTimer(frame)
        self._legacy_timer.setSingleShot(True)
        self._legacy_timer.timeout.connect(self._hide_legacy)
        self._legacy_timer.start(duration_ms)

    def _hide_legacy(self) -> None:
        if self._legacy_timer is not None:
            self._legacy_timer.stop()
            self._legacy_timer = None
        if self._legacy_toast is not None:
            self._legacy_toast.hide()
            self._legacy_toast.deleteLater()
            self._legacy_toast = None
