"""
搜索结果项组件。

用于在搜索列表中展示更像商用桌面产品的内容卡片，
包含缩略图、平台徽标、时长与摘要信息。
"""
from __future__ import annotations

from PyQt6.QtCore import Qt, QSize
from PyQt6.QtGui import QPixmap
from PyQt6.QtWidgets import QHBoxLayout, QLabel, QVBoxLayout, QWidget

from src.core.download_task import VideoInfo
from src.ui.components.chrome import BodyLabel, StatusBadge, StrongBodyLabel
from src.ui.components.thumbnail_loader import ThumbnailLoader


class SearchResultItemWidget(QWidget):
    """搜索结果列表项组件。"""

    THUMBNAIL_SIZE = QSize(136, 76)

    def __init__(self, video: VideoInfo, thumbnail_loader: ThumbnailLoader = None):
        super().__init__()
        self.video = video
        self.thumbnail_loader = thumbnail_loader
        self.setObjectName("SearchResultItem")
        self.setProperty("selected", False)

        self.thumbnail_label = QLabel()
        self.thumbnail_status_label = QLabel()
        self.title_label = StrongBodyLabel()
        self.meta_label = BodyLabel()
        self.platform_badge = StatusBadge()
        self.duration_badge = StatusBadge()
        self._selected = False

        self._init_ui()
        self._bind_loader()

    @property
    def item_key(self) -> str:
        return self.video.url

    def _init_ui(self) -> None:
        root_layout = QHBoxLayout()
        root_layout.setContentsMargins(12, 10, 12, 10)
        root_layout.setSpacing(12)

        thumb_layout = QVBoxLayout()
        thumb_layout.setSpacing(4)
        thumb_layout.setContentsMargins(0, 0, 0, 0)

        self.thumbnail_label.setFixedSize(self.THUMBNAIL_SIZE)
        self.thumbnail_label.setObjectName("SearchResultThumbnail")
        self.thumbnail_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.thumbnail_label.setText("封面")

        self.thumbnail_status_label.setText("封面待加载")
        self.thumbnail_status_label.setObjectName("SearchResultThumbStatus")
        self.thumbnail_status_label.setAlignment(Qt.AlignmentFlag.AlignCenter)

        thumb_layout.addWidget(self.thumbnail_label)
        thumb_layout.addWidget(self.thumbnail_status_label)

        info_layout = QVBoxLayout()
        info_layout.setSpacing(6)
        info_layout.setContentsMargins(0, 0, 0, 0)

        self.title_label.setObjectName("SearchResultTitle")
        self.title_label.setText(self.video.title or "未命名视频")
        self.title_label.setWordWrap(True)

        top_row = QHBoxLayout()
        top_row.setContentsMargins(0, 0, 0, 0)
        top_row.setSpacing(8)
        top_row.addWidget(self.platform_badge)
        top_row.addWidget(self.duration_badge)
        top_row.addStretch()

        uploader = self.video.uploader or "未知"
        duration_str = self._format_duration(self.video.duration)
        self.meta_label.setObjectName("SearchResultMeta")
        self.meta_label.setText(f"上传者：{uploader}")
        self.meta_label.setWordWrap(True)

        self.platform_badge.setText(self._platform_label())
        self.platform_badge.setTone(self._platform_tone())
        self.duration_badge.setText(f"时长 {duration_str}")
        self.duration_badge.setTone("neutral")

        info_layout.addLayout(top_row)
        info_layout.addWidget(self.title_label)
        info_layout.addWidget(self.meta_label)
        info_layout.addStretch()

        root_layout.addLayout(thumb_layout)
        root_layout.addLayout(info_layout, 1)
        self.setLayout(root_layout)
        self.set_selected(False)

    def _platform_label(self) -> str:
        platform = self.video.platform.value if self.video.platform else "unknown"
        mapping = {
            "youtube": "YouTube",
            "bilibili": "Bilibili",
            "douyin": "抖音",
            "tiktok": "TikTok",
            "twitter": "X / Twitter",
            "instagram": "Instagram",
            "pornhub": "Pornhub",
        }
        return mapping.get(platform, platform.capitalize())

    def _platform_tone(self) -> str:
        platform = self.video.platform.value if self.video.platform else "unknown"
        if platform == "youtube":
            return "youtube"
        if platform == "bilibili":
            return "bilibili"
        if platform == "douyin":
            return "warning"
        if platform == "tiktok":
            return "info"
        if platform in {"twitter", "instagram", "pornhub"}:
            return "primary"
        return "neutral"

    def set_selected(self, selected: bool) -> None:
        """根据列表选中态调整整体视觉状态。"""

        self._selected = bool(selected)
        self.setProperty("selected", self._selected)
        self.platform_badge.setTone(self._platform_tone())
        self.duration_badge.setTone("primary" if self._selected else "neutral")
        style = self.style()
        if style is not None:
            style.unpolish(self)
            style.polish(self)
            self.update()

    def _bind_loader(self) -> None:
        if not self.thumbnail_loader:
            return

        self.thumbnail_loader.thumbnail_loaded.connect(self._on_thumbnail_loaded)
        self.thumbnail_loader.thumbnail_failed.connect(self._on_thumbnail_failed)

    def set_placeholder(self, text: str = "封面待加载") -> None:
        """显示占位封面文本。"""

        self.thumbnail_label.clear()
        self.thumbnail_label.setText("封面")
        self.thumbnail_status_label.setText(text)

    def set_thumbnail(self, pixmap: QPixmap) -> None:
        """更新封面图。"""

        scaled = pixmap.scaled(
            self.THUMBNAIL_SIZE,
            Qt.AspectRatioMode.KeepAspectRatioByExpanding,
            Qt.TransformationMode.SmoothTransformation,
        )
        self.thumbnail_label.setPixmap(scaled)
        self.thumbnail_status_label.setText("封面已加载")

    def _on_thumbnail_loaded(self, item_key: str, pixmap: QPixmap) -> None:
        if item_key != self.item_key:
            return
        self.set_thumbnail(pixmap)

    def _on_thumbnail_failed(self, item_key: str, _reason: str) -> None:
        if item_key != self.item_key:
            return
        self.set_placeholder("暂无封面")

    @staticmethod
    def _format_duration(seconds: int) -> str:
        if seconds in (None, "", 0):
            return "暂无"

        try:
            seconds = int(seconds)
        except (TypeError, ValueError):
            return "暂无"

        if seconds <= 0:
            return "暂无"
        hours = seconds // 3600
        minutes = (seconds % 3600) // 60
        secs = seconds % 60

        if hours > 0:
            return f"{hours:02d}:{minutes:02d}:{secs:02d}"
        return f"{minutes:02d}:{secs:02d}"
