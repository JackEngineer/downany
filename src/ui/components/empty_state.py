"""
空态组件：图标 + 主文案 + 可选行动按钮。
"""
from __future__ import annotations

from typing import Callable, Optional

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import QHBoxLayout, QLabel, QPushButton, QVBoxLayout, QWidget

from src.ui.components.chrome import BodyLabel, StrongBodyLabel


class EmptyStateWidget(QWidget):
    """页面空态占位。"""

    def __init__(
        self,
        message: str,
        hint: str = "",
        action_label: Optional[str] = None,
        action_cb: Optional[Callable[[], None]] = None,
        parent=None,
    ):
        super().__init__(parent)
        self.setObjectName("EmptyStateWidget")

        layout = QVBoxLayout(self)
        layout.setContentsMargins(24, 24, 24, 24)
        layout.setSpacing(10)
        layout.setAlignment(Qt.AlignmentFlag.AlignCenter)

        icon_label = QLabel("📭")
        icon_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        icon_label.setObjectName("EmptyStateIcon")
        layout.addWidget(icon_label)

        self.message_label = StrongBodyLabel(message)
        self.message_label.setObjectName("EmptyStateLabel")
        self.message_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.message_label.setWordWrap(True)
        layout.addWidget(self.message_label)

        self.hint_label = BodyLabel(hint)
        self.hint_label.setObjectName("PageHint")
        self.hint_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.hint_label.setWordWrap(True)
        if hint:
            layout.addWidget(self.hint_label)
        else:
            self.hint_label.hide()

        self._action_btn: Optional[QPushButton] = None
        if action_label and action_cb:
            action_row = QHBoxLayout()
            action_row.addStretch()
            self._action_btn = QPushButton(action_label)
            self._action_btn.setObjectName("primaryActionButton")
            self._action_btn.clicked.connect(action_cb)
            action_row.addWidget(self._action_btn)
            action_row.addStretch()
            layout.addLayout(action_row)

    def set_message(self, message: str, hint: str = "") -> None:
        self.message_label.setText(message)
        self.hint_label.setText(hint)
        self.hint_label.setVisible(bool(hint))
