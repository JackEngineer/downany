import os
import time
from pathlib import Path
from time import monotonic

import PyQt6
from PyQt6.QtWidgets import QApplication

import src.ui.components.video_preview_widget as video_preview_widget_module
from src.ui.components.video_preview_widget import VideoPreviewWidget

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault(
    "QT_QPA_PLATFORM_PLUGIN_PATH",
    str(Path(PyQt6.__file__).resolve().parent / "Qt6" / "plugins" / "platforms"),
)

APP = QApplication.instance() or QApplication([])


def _wait_for(condition, timeout=2.5):
    deadline = monotonic() + timeout
    while monotonic() < deadline:
        APP.processEvents()
        if condition():
            return True
        time.sleep(0.01)
    APP.processEvents()
    return condition()


def test_try_play_resolves_direct_url_in_background(monkeypatch):
    def slow_extract(url: str):
        time.sleep(0.15)
        return "https://cdn.example.com/direct.mp4", ""

    monkeypatch.setattr(video_preview_widget_module, "_extract_direct_playback_url", slow_extract)

    widget = VideoPreviewWidget()
    applied_urls = []
    monkeypatch.setattr(widget, "_apply_playback_url", lambda url: applied_urls.append(url))

    started = monotonic()
    assert widget.try_play("https://www.youtube.com/watch?v=abc123") is True
    assert monotonic() - started < 0.1
    assert applied_urls == []

    assert _wait_for(lambda: bool(applied_urls) and not widget._resolve_threads)
    assert applied_urls == ["https://cdn.example.com/direct.mp4"]


def test_try_play_emits_failure_when_no_direct_url(monkeypatch):
    monkeypatch.setattr(
        video_preview_widget_module,
        "_extract_direct_playback_url",
        lambda _url: ("", "no_direct_playback_url"),
    )

    widget = VideoPreviewWidget()
    failed_reasons = []
    widget.playback_failed.connect(lambda reason: failed_reasons.append(reason))

    started = monotonic()
    assert widget.try_play("https://www.bilibili.com/video/BV1xx411c7mD") is True
    assert monotonic() - started < 0.1

    assert _wait_for(lambda: bool(failed_reasons) and not widget._resolve_threads)
    assert failed_reasons == ["no_direct_playback_url"]
    assert widget.status_label.text() == "解析可播放链接失败"


def test_stop_invalidates_pending_background_resolution(monkeypatch):
    def slow_extract(url: str):
        time.sleep(0.15)
        return "https://cdn.example.com/direct.mp4", ""

    monkeypatch.setattr(video_preview_widget_module, "_extract_direct_playback_url", slow_extract)

    widget = VideoPreviewWidget()
    applied_urls = []
    monkeypatch.setattr(widget, "_apply_playback_url", lambda url: applied_urls.append(url))

    assert widget.try_play("https://www.youtube.com/watch?v=xyz789") is True
    widget.stop()

    assert _wait_for(lambda: not widget._resolve_threads)
    assert applied_urls == []
    assert widget.status_label.text() == "已停止"
