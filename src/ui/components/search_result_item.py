"""
搜索结果项组件，包含缩略图占位与更新能力。
"""
from PyQt6.QtCore import Qt, QSize
from PyQt6.QtGui import QPixmap
from PyQt6.QtWidgets import QWidget, QHBoxLayout, QVBoxLayout, QLabel
import json
import time

from src.core.download_task import VideoInfo
from src.ui.components.thumbnail_loader import ThumbnailLoader

_DEBUG_STYLE_LOGGED = False


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
        self._selected = False

        self._init_ui()
        self._bind_loader()

    @property
    def item_key(self) -> str:
        return self.video.url

    def _init_ui(self) -> None:
        global _DEBUG_STYLE_LOGGED
        root_layout = QHBoxLayout()
        root_layout.setContentsMargins(8, 6, 8, 6)
        root_layout.setSpacing(10)

        thumb_layout = QVBoxLayout()
        thumb_layout.setSpacing(4)
        thumb_layout.setAlignment(Qt.AlignmentFlag.AlignTop)

        self.thumbnail_label.setFixedSize(self.THUMBNAIL_SIZE)
        self.thumbnail_label.setObjectName("searchResultThumbnail")
        self.thumbnail_label.setAlignment(Qt.AlignmentFlag.AlignCenter)

        self.thumbnail_status_label.setText("封面待加载")
        self.thumbnail_status_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.thumbnail_status_label.setObjectName("searchResultThumbStatus")

        thumb_layout.addWidget(self.thumbnail_label)
        thumb_layout.addWidget(self.thumbnail_status_label)

        info_layout = QVBoxLayout()
        info_layout.setSpacing(4)

        self.title_label.setText(self.video.title or "Unknown")
        self.title_label.setWordWrap(True)
        self.title_label.setObjectName("searchResultTitle")

        duration_str = self._format_duration(self.video.duration)
        self.meta_label.setText(f"上传者: {self.video.uploader or 'Unknown'} | 时长: {duration_str}")
        self.meta_label.setObjectName("searchResultMeta")

        info_layout.addWidget(self.title_label)
        info_layout.addWidget(self.meta_label)
        info_layout.addStretch()

        root_layout.addLayout(thumb_layout)
        root_layout.addLayout(info_layout, 1)
        self.setLayout(root_layout)
        if not _DEBUG_STYLE_LOGGED:
            # region agent log
            payload = {
                "sessionId": "5680ec",
                "runId": "initial",
                "hypothesisId": "H5",
                "location": "search_result_item.py:_init_ui",
                "message": "result item style snapshot",
                "data": {
                    "titleStyle": self.title_label.styleSheet(),
                    "metaStyle": self.meta_label.styleSheet(),
                    "thumbStatusStyle": self.thumbnail_status_label.styleSheet(),
                    "thumbLabelStyle": self.thumbnail_label.styleSheet(),
                    "selected": self._selected,
                },
                "timestamp": int(time.time() * 1000),
            }
            try:
                with open("/Users/jacklee/work/personal/trae/downloader/.cursor/debug-5680ec.log", "a", encoding="utf-8") as f:
                    f.write(json.dumps(payload, ensure_ascii=False) + "\n")
            except Exception:
                pass
            # endregion
            _DEBUG_STYLE_LOGGED = True
        self.set_selected(False)

    def set_selected(self, selected: bool) -> None:
        """根据列表选中态调整文本颜色，提升可读性。"""
        self._selected = bool(selected)
        if self._selected:
            self.title_label.setStyleSheet("color: #FFFFFF; font-size: 13px; font-weight: 600;")
            self.meta_label.setStyleSheet("color: #EAF3FF; font-size: 12px;")
            self.thumbnail_status_label.setStyleSheet("color: #EAF3FF; font-size: 11px;")
        else:
            self.title_label.setStyleSheet("")
            self.meta_label.setStyleSheet("")
            self.thumbnail_status_label.setStyleSheet("")

    def _bind_loader(self) -> None:
        if not self.thumbnail_loader:
            return

        self.thumbnail_loader.thumbnail_loaded.connect(self._on_thumbnail_loaded)
        self.thumbnail_loader.thumbnail_failed.connect(self._on_thumbnail_failed)

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
        if seconds in (None, "", 0):
            return "N/A"

        try:
            seconds = int(seconds)
        except (TypeError, ValueError):
            return "N/A"

        if seconds <= 0:
            return "N/A"
        hours = seconds // 3600
        minutes = (seconds % 3600) // 60
        secs = seconds % 60

        if hours > 0:
            return f"{hours:02d}:{minutes:02d}:{secs:02d}"
        return f"{minutes:02d}:{secs:02d}"
