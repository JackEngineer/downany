"""
搜索结果项组件，包含缩略图占位与更新能力。
"""
from PyQt6.QtCore import Qt, QSize
from PyQt6.QtGui import QPixmap
from PyQt6.QtWidgets import QWidget, QHBoxLayout, QVBoxLayout, QLabel

from src.core.download_task import VideoInfo
from src.ui.components.thumbnail_loader import ThumbnailLoader


class SearchResultItemWidget(QWidget):
    """搜索结果列表项组件。"""

    THUMBNAIL_SIZE = QSize(120, 68)

    def __init__(self, video: VideoInfo, thumbnail_loader: ThumbnailLoader = None):
        super().__init__()
        self.video = video
        self.thumbnail_loader = thumbnail_loader

        self.thumbnail_label = QLabel()
        self.thumbnail_status_label = QLabel()
        self.title_label = QLabel()
        self.meta_label = QLabel()

        self._init_ui()
        self._bind_loader()

    @property
    def item_key(self) -> str:
        return self.video.url

    def _init_ui(self) -> None:
        root_layout = QHBoxLayout()
        root_layout.setContentsMargins(8, 6, 8, 6)
        root_layout.setSpacing(10)

        thumb_layout = QVBoxLayout()
        thumb_layout.setSpacing(4)
        thumb_layout.setAlignment(Qt.AlignmentFlag.AlignTop)

        self.thumbnail_label.setFixedSize(self.THUMBNAIL_SIZE)
        self.thumbnail_label.setStyleSheet(
            "background-color: #2b2b2b; border: 1px solid #4a4a4a; border-radius: 4px;"
        )
        self.thumbnail_label.setAlignment(Qt.AlignmentFlag.AlignCenter)

        self.thumbnail_status_label.setText("封面待加载")
        self.thumbnail_status_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.thumbnail_status_label.setStyleSheet("color: #7a7a7a; font-size: 11px;")

        thumb_layout.addWidget(self.thumbnail_label)
        thumb_layout.addWidget(self.thumbnail_status_label)

        info_layout = QVBoxLayout()
        info_layout.setSpacing(4)

        self.title_label.setText(self.video.title or "Unknown")
        self.title_label.setWordWrap(True)
        self.title_label.setStyleSheet("font-size: 13px; font-weight: 600;")

        duration_str = self._format_duration(self.video.duration)
        self.meta_label.setText(f"上传者: {self.video.uploader or 'Unknown'} | 时长: {duration_str}")
        self.meta_label.setStyleSheet("color: #7a7a7a; font-size: 12px;")

        info_layout.addWidget(self.title_label)
        info_layout.addWidget(self.meta_label)
        info_layout.addStretch()

        root_layout.addLayout(thumb_layout)
        root_layout.addLayout(info_layout, 1)
        self.setLayout(root_layout)

    def _bind_loader(self) -> None:
        if not self.thumbnail_loader:
            return

        self.thumbnail_loader.thumbnail_loaded.connect(self._on_thumbnail_loaded)
        self.thumbnail_loader.thumbnail_failed.connect(self._on_thumbnail_failed)
        self.thumbnail_loader.request_thumbnail(self.item_key, self.video.thumbnail_url)

    def set_placeholder(self, text: str = "封面待加载") -> None:
        """显示占位封面文本。"""
        self.thumbnail_label.clear()
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
        if seconds == 0:
            return "N/A"

        seconds = int(seconds)
        hours = seconds // 3600
        minutes = (seconds % 3600) // 60
        secs = seconds % 60

        if hours > 0:
            return f"{hours:02d}:{minutes:02d}:{secs:02d}"
        return f"{minutes:02d}:{secs:02d}"
