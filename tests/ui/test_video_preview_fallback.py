"""
测试视频预览失败回退浏览器逻辑。
"""
import os
from pathlib import Path
from unittest.mock import patch

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


class DummyDownloadManager:
    def add_task(self, *_args, **_kwargs):
        return None


def _make_video(index: int, url: str = None) -> VideoInfo:
    return VideoInfo(
        url=url or f"https://example.com/watch?v=video{index}",
        title=f"测试视频 {index}",
        duration=120 + index,
        thumbnail_url=f"https://example.com/thumb{index}.jpg",
        uploader="测试上传者",
        platform=Platform.YOUTUBE,
    )


def _flush_events(rounds: int = 3):
    for _ in range(rounds):
        APP.processEvents()


def test_preview_fallback_to_browser_on_player_failure(monkeypatch):
    """
    测试预览组件返回 False 时，会触发浏览器回退。
    """
    monkeypatch.setattr(search_tab_module, "ConfigManager", DummyConfigManager)
    monkeypatch.setattr(search_tab_module, "HistoryDB", DummyHistoryDB)

    tab = search_tab_module.SearchTab(DummyDownloadManager())
    tab.show()

    # 模拟 try_play 返回 False（预览失败）
    with patch.object(tab.preview_widget, "try_play", return_value=False):
        # 模拟浏览器打开成功
        with patch("src.ui.tabs.search_tab.QDesktopServices.openUrl", return_value=True) as mock_open:
            tab.display_results([_make_video(1)])
            _flush_events()

            tab.result_list.setCurrentRow(0)
            _flush_events()

            # 调用预览
            tab.preview_selected_video()
            _flush_events()

            # 验证浏览器打开被调用
            mock_open.assert_called_once()
            # 验证状态文案显示回退成功
            assert "浏览器" in tab.preview_status_label.text() or "打开" in tab.preview_status_label.text()


def test_preview_status_on_fallback_failure(monkeypatch):
    """
    测试回退浏览器也失败时，状态提示正确。
    """
    monkeypatch.setattr(search_tab_module, "ConfigManager", DummyConfigManager)
    monkeypatch.setattr(search_tab_module, "HistoryDB", DummyHistoryDB)

    tab = search_tab_module.SearchTab(DummyDownloadManager())
    tab.show()

    # 模拟 try_play 返回 False，同时浏览器打开也失败
    with patch.object(tab.preview_widget, "try_play", return_value=False):
        with patch("src.ui.tabs.search_tab.QDesktopServices.openUrl", return_value=False):
            tab.display_results([_make_video(1)])
            _flush_events()

            tab.result_list.setCurrentRow(0)
            _flush_events()

            tab.preview_selected_video()
            _flush_events()

            # 验证状态显示失败提示
            assert "失败" in tab.preview_status_label.text() or "手动" in tab.preview_status_label.text()
