"""
可复用的页面 chrome 组件。

用于构建更像商业桌面软件的页面头部、信息卡片和状态徽标。
"""
from __future__ import annotations

from typing import Iterable, Sequence

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import (
    QFrame,
    QHBoxLayout,
    QLabel,
    QSizePolicy,
    QVBoxLayout,
    QWidget,
)

from src.ui.fluent_support import get_fluent_widget


def _widget_class(name: str, fallback):
    cls = get_fluent_widget(name)
    return cls if cls is not None else fallback


BodyLabel = _widget_class("BodyLabel", QLabel)
StrongBodyLabel = _widget_class("StrongBodyLabel", QLabel)
TitleLabel = _widget_class("TitleLabel", QLabel)
SubtitleLabel = _widget_class("SubtitleLabel", QLabel)
CardBase = QFrame


def _repolish(widget: QWidget) -> None:
    style = widget.style()
    if style is None:
        return
    style.unpolish(widget)
    style.polish(widget)
    widget.update()


def clear_layout(layout) -> None:
    """安全清空布局。"""

    while layout.count():
        item = layout.takeAt(0)
        widget = item.widget()
        sub_layout = item.layout()
        if widget is not None:
            widget.setParent(None)
            widget.deleteLater()
        if sub_layout is not None:
            clear_layout(sub_layout)


class StatusBadge(QLabel):
    """状态徽标。"""

    def __init__(self, text: str = "", tone: str = "neutral", parent=None):
        super().__init__(text, parent)
        self.setObjectName("StatusBadge")
        self.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.setSizePolicy(QSizePolicy.Policy.Fixed, QSizePolicy.Policy.Fixed)
        self.setMinimumHeight(26)
        self.setTone(tone)

    def setTone(self, tone: str) -> None:
        self.setProperty("tone", (tone or "neutral").lower())
        _repolish(self)

    def setText(self, text: str) -> None:  # noqa: N802 - Qt API
        super().setText(text)
        self.adjustSize()


class MetricCard(CardBase):
    """顶部摘要指标卡。"""

    def __init__(
        self,
        label: str = "",
        value: str = "",
        hint: str = "",
        tone: str = "neutral",
        parent=None,
    ):
        super().__init__(parent)
        self.setObjectName("MetricCard")
        self.setProperty("emphasis", tone == "primary")
        self.setMinimumWidth(132)
        self.setSizePolicy(QSizePolicy.Policy.Preferred, QSizePolicy.Policy.Fixed)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(14, 12, 14, 12)
        layout.setSpacing(2)

        self.value_label = StrongBodyLabel(value)
        self.value_label.setObjectName("MetricValue")
        self.value_label.setWordWrap(True)
        layout.addWidget(self.value_label)

        self.label_label = BodyLabel(label)
        self.label_label.setObjectName("MetricLabel")
        self.label_label.setWordWrap(True)
        layout.addWidget(self.label_label)

        self.hint_label = BodyLabel(hint)
        self.hint_label.setObjectName("MetricHint")
        self.hint_label.setWordWrap(True)
        if hint:
            layout.addWidget(self.hint_label)

    def set_metric(self, label: str, value: str, hint: str = "") -> None:
        self.value_label.setText(value)
        self.label_label.setText(label)
        self.hint_label.setText(hint)
        self.hint_label.setVisible(bool(hint))


class SectionCard(CardBase):
    """带标题的内容卡片。"""

    def __init__(self, title: str = "", subtitle: str = "", parent=None):
        super().__init__(parent)
        self.setObjectName("SectionCard")
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Preferred)

        outer_layout = QVBoxLayout(self)
        outer_layout.setContentsMargins(16, 16, 16, 16)
        outer_layout.setSpacing(10)

        self.header_widget = QWidget(self)
        header_layout = QVBoxLayout(self.header_widget)
        header_layout.setContentsMargins(0, 0, 0, 0)
        header_layout.setSpacing(2)

        self.title_label = StrongBodyLabel(title)
        self.title_label.setObjectName("SectionTitle")
        self.title_label.setWordWrap(True)
        header_layout.addWidget(self.title_label)

        self.subtitle_label = BodyLabel(subtitle)
        self.subtitle_label.setObjectName("SectionSubtitle")
        self.subtitle_label.setWordWrap(True)
        if subtitle:
            header_layout.addWidget(self.subtitle_label)

        outer_layout.addWidget(self.header_widget)

        self.body_widget = QWidget(self)
        self.body_layout = QVBoxLayout(self.body_widget)
        self.body_layout.setContentsMargins(0, 0, 0, 0)
        self.body_layout.setSpacing(10)
        outer_layout.addWidget(self.body_widget)

        self.set_title(title, subtitle)

    def set_title(self, title: str, subtitle: str = "") -> None:
        self.title_label.setText(title)
        self.subtitle_label.setText(subtitle)
        self.subtitle_label.setVisible(bool(subtitle))


class PageHeader(QWidget):
    """页面顶部标题与摘要。"""

    def __init__(
        self,
        title: str,
        subtitle: str,
        metrics: Sequence[tuple[str, str, str]] | None = None,
        parent=None,
    ):
        super().__init__(parent)
        self.setObjectName("PageHeader")
        self._metric_cards: list[MetricCard] = []

        layout = QHBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(16)

        left_layout = QVBoxLayout()
        left_layout.setContentsMargins(0, 0, 0, 0)
        left_layout.setSpacing(6)

        self.title_label = TitleLabel(title)
        self.title_label.setObjectName("PageTitle")
        self.title_label.setWordWrap(True)
        left_layout.addWidget(self.title_label)

        self.subtitle_label = SubtitleLabel(subtitle)
        self.subtitle_label.setObjectName("PageSubtitle")
        self.subtitle_label.setWordWrap(True)
        left_layout.addWidget(self.subtitle_label)

        left_layout.addStretch()
        layout.addLayout(left_layout, 1)

        self.metrics_widget = QWidget(self)
        self.metrics_layout = QHBoxLayout(self.metrics_widget)
        self.metrics_layout.setContentsMargins(0, 0, 0, 0)
        self.metrics_layout.setSpacing(8)
        self.metrics_layout.addStretch()
        layout.addWidget(self.metrics_widget, 0, Qt.AlignmentFlag.AlignTop)

        if metrics:
            self.set_metrics(metrics)

    def set_metrics(self, metrics: Sequence[tuple[str, str, str]]) -> None:
        metrics_list = list(metrics)
        if len(self._metric_cards) == len(metrics_list):
            for card, (label, value, hint) in zip(self._metric_cards, metrics_list):
                card.set_metric(label, value, hint)
            return

        clear_layout(self.metrics_layout)
        self._metric_cards = []
        self.metrics_layout.addStretch()
        for label, value, hint in metrics_list:
            card = MetricCard(label, value, hint)
            self._metric_cards.append(card)
            self.metrics_layout.addWidget(card)

    def metric_cards(self) -> list[MetricCard]:
        return list(self._metric_cards)
