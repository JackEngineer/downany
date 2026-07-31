import os
from pathlib import Path

import PyQt6
from PyQt6.QtWidgets import QApplication

from src.core.download_task import Platform, VideoInfo
import src.ui.tabs.search_tab as search_tab_module

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault(
    "QT_QPA_PLATFORM_PLUGIN_PATH",
    str(Path(PyQt6.__file__).resolve().parent / "Qt6" / "plugins" / "platforms"),
)

APP = QApplication.instance() or QApplication([])


class DummyConfigManager:
    def get_proxy_url(self):
        return ""

    def is_proxy_enabled(self):
        return False

    def get_download_dir(self):
        return "downloads"

    def get_default_quality(self):
        return "best"

    def is_download_subtitles(self):
        return False


class DummyHistoryDB:
    def add_search_record(self, *_args, **_kwargs):
        return None

    def get_recent_searches(self, limit=20):
        return []


class DummyDownloadManager:
    def add_task(self, *_args, **_kwargs):
        return None


def _make_video(index: int, duration=None) -> VideoInfo:
    if duration is None:
        duration = 100 + index
    return VideoInfo(
        url=f"https://example.com/watch?v=video{index}",
        title=f"详情测试视频 {index}",
        duration=duration,
        thumbnail_url=f"https://example.com/thumb{index}.jpg",
        uploader=f"上传者{index}",
        platform=Platform.YOUTUBE,
    )


def _flush_events(rounds: int = 3):
    for _ in range(rounds):
        APP.processEvents()


def test_selection_updates_detail_panel_and_enables_preview(monkeypatch):
    monkeypatch.setattr(search_tab_module, "ConfigManager", DummyConfigManager)
    monkeypatch.setattr(search_tab_module, "HistoryDB", DummyHistoryDB)

    tab = search_tab_module.SearchTab(DummyDownloadManager())
    tab.show()
    tab._active_search_request_id = 1
    tab.display_results(1, [_make_video(1), _make_video(2)])
    _flush_events()

    tab.result_list.setCurrentRow(1)
    _flush_events()

    assert tab.preview_btn.isEnabled() is True
    assert tab.detail_title_label.text() == "详情测试视频 2"
    assert tab.detail_url_label.text() == "链接：https://example.com/watch?v=video2"


def test_selection_handles_none_duration_without_crash(monkeypatch):
    monkeypatch.setattr(search_tab_module, "ConfigManager", DummyConfigManager)
    monkeypatch.setattr(search_tab_module, "HistoryDB", DummyHistoryDB)

    tab = search_tab_module.SearchTab(DummyDownloadManager())
    tab.show()
    video = _make_video(1)
    video.duration = None
    tab._active_search_request_id = 1
    tab.display_results(1, [video])
    _flush_events()

    tab.result_list.setCurrentRow(0)
    _flush_events()

    assert "时长：暂无" in tab.detail_meta_label.text()
