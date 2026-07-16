import os
from pathlib import Path

import PyQt6
from PyQt6.QtWidgets import QApplication

from src.core.download_task import Platform
import src.ui.tabs.search_tab as search_tab_module
import src.ui.tabs.settings_tab as settings_tab_module

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

    def get_concurrent_downloads(self):
        return 3

    def get_speed_limit(self):
        return 0

    def get_theme_mode(self):
        return "system"


class DummyHistoryDB:
    def add_search_record(self, *_args, **_kwargs):
        return None


class DummyDownloadManager:
    def add_task(self, *_args, **_kwargs):
        return None


def test_search_tab_platform_combo_uses_user_data(monkeypatch):
    monkeypatch.setattr(search_tab_module, "ConfigManager", DummyConfigManager)
    monkeypatch.setattr(search_tab_module, "HistoryDB", DummyHistoryDB)

    tab = search_tab_module.SearchTab(DummyDownloadManager())

    assert tab.platform_combo.currentData() == Platform.YOUTUBE

    tab.platform_combo.setCurrentIndex(1)

    assert tab.platform_combo.currentData() == Platform.BILIBILI
    assert tab._resolve_selected_platform() == Platform.BILIBILI


def test_settings_tab_theme_combo_uses_user_data(monkeypatch):
    monkeypatch.setattr(settings_tab_module, "ConfigManager", DummyConfigManager)

    tab = settings_tab_module.SettingsTab()

    assert tab.theme_combo.currentData() == "system"

    tab.theme_combo.setCurrentIndex(1)

    assert tab.theme_combo.currentData() == "light"
