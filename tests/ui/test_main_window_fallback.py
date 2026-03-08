import os
from pathlib import Path

import PyQt6
from PyQt6.QtWidgets import QApplication, QWidget

import src.ui.main_window as main_window_module

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault(
    "QT_QPA_PLATFORM_PLUGIN_PATH",
    str(Path(PyQt6.__file__).resolve().parent / "Qt6" / "plugins" / "platforms"),
)

APP = QApplication.instance() or QApplication([])


class DummyDownloadManager:
    def start(self):
        return None

    def stop(self):
        return None


class DummyTab(QWidget):
    def __init__(self, *_args, **_kwargs):
        super().__init__()


def test_main_window_fallback_uses_qtabwidget(monkeypatch):
    monkeypatch.setattr(main_window_module, "DownloadManager", DummyDownloadManager)
    monkeypatch.setattr(main_window_module, "SearchTab", DummyTab)
    monkeypatch.setattr(main_window_module, "DownloadTab", DummyTab)
    monkeypatch.setattr(main_window_module, "QueueTab", DummyTab)
    monkeypatch.setattr(main_window_module, "HistoryTab", DummyTab)
    monkeypatch.setattr(main_window_module, "SettingsTab", DummyTab)

    window = main_window_module.MainWindow(use_fluent=False)
    assert window.tabs.count() == 5
