import os
from pathlib import Path

import PyQt6

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault(
    "QT_QPA_PLATFORM_PLUGIN_PATH",
    str(Path(PyQt6.__file__).resolve().parent / "Qt6" / "plugins" / "platforms"),
)

from PyQt6.QtGui import QColor, QPixmap
from PyQt6.QtWidgets import QApplication

from src.core.download_task import Platform, VideoInfo
from src.ui.components.search_result_item import SearchResultItemWidget

APP = QApplication.instance() or QApplication([])


def _make_video() -> VideoInfo:
    return VideoInfo(
        url="https://example.com/watch?v=abc123",
        title="测试视频",
        duration=120,
        thumbnail_url="",
        uploader="测试上传者",
        platform=Platform.YOUTUBE,
    )
def test_search_result_item_has_placeholder_thumbnail():
    widget = SearchResultItemWidget(_make_video())

    assert widget.thumbnail_status_label.text() == "封面待加载"
    assert widget.thumbnail_label.pixmap() is not None
    assert widget.thumbnail_label.pixmap().isNull()


def test_search_result_item_updates_when_thumbnail_available():
    widget = SearchResultItemWidget(_make_video())

    pixmap = QPixmap(120, 68)
    pixmap.fill(QColor("#33A1FF"))
    widget.set_thumbnail(pixmap)

    assert widget.thumbnail_label.pixmap() is not None
    assert widget.thumbnail_status_label.text() == "封面已加载"
