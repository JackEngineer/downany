import os
from pathlib import Path
from time import monotonic

import PyQt6
from PyQt6.QtCore import Qt
from PyQt6.QtGui import QColor, QPixmap
from PyQt6.QtWidgets import QApplication

from src.core.download_task import Platform, VideoInfo
from src.ui.components.thumbnail_loader import ThumbnailLoader
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


class RecordingThumbnailLoader(ThumbnailLoader):
    def __init__(self):
        super().__init__()
        self.calls = []

    def request_thumbnail(self, item_key: str, thumbnail_url: str) -> None:
        self.calls.append((item_key, thumbnail_url))


def _make_video(index: int) -> VideoInfo:
    return VideoInfo(
        url=f"https://example.com/watch?v=video{index}",
        title=f"测试视频 {index}",
        duration=120 + index,
        thumbnail_url=f"https://example.com/thumbnail{index}.jpg",
        uploader="测试上传者",
        platform=Platform.YOUTUBE,
    )


def _visible_item_keys(tab) -> set[str]:
    viewport_rect = tab.result_list.viewport().rect()
    keys = set()
    for index in range(tab.result_list.count()):
        item = tab.result_list.item(index)
        if tab.result_list.visualItemRect(item).intersects(viewport_rect):
            video = item.data(Qt.ItemDataRole.UserRole)
            keys.add(video.url)
    return keys


def _flush_events(rounds: int = 3):
    for _ in range(rounds):
        APP.processEvents()


def test_visible_items_only_trigger_thumbnail_requests(monkeypatch):
    monkeypatch.setattr(search_tab_module, "ConfigManager", DummyConfigManager)
    monkeypatch.setattr(search_tab_module, "HistoryDB", DummyHistoryDB)

    loader = RecordingThumbnailLoader()
    tab = search_tab_module.SearchTab(DummyDownloadManager(), thumbnail_loader=loader)
    tab.resize(640, 360)
    tab.show()

    results = [_make_video(i) for i in range(40)]
    tab.display_results(results)
    _flush_events()

    requested_keys = {item_key for item_key, _ in loader.calls}
    visible_keys = _visible_item_keys(tab)

    assert requested_keys == visible_keys
    assert 0 < len(requested_keys) < len(results)


def test_cache_hit_skips_new_network_request():
    loader = ThumbnailLoader()
    item_key = "video-1"
    thumbnail_url = "https://example.com/thumbnail.jpg"

    pixmap = QPixmap(120, 68)
    pixmap.fill(QColor("#2288DD"))
    loader._pixmap_cache[thumbnail_url] = pixmap

    class FakeNetworkManager:
        def __init__(self):
            self.calls = 0

        def get(self, _request):
            self.calls += 1
            raise AssertionError("缓存命中时不应发起网络请求")

    fake_network_manager = FakeNetworkManager()
    loader._network_manager = fake_network_manager

    loaded_keys = []
    loader.thumbnail_loaded.connect(lambda key, _pixmap: loaded_keys.append(key))
    loader.request_thumbnail(item_key, thumbnail_url)
    _flush_events()

    assert fake_network_manager.calls == 0
    assert loaded_keys == [item_key]


def test_switch_item_key_to_new_thumbnail_url_not_blocked_by_old_failed_cache():
    loader = ThumbnailLoader()
    item_key = "video-1"
    old_thumbnail_url = "https://example.com/thumbnail-old.jpg"
    new_thumbnail_url = "https://example.com/thumbnail-new.jpg"
    loader._failed_cache_expiry[old_thumbnail_url] = monotonic() + 30

    class FakeSignal:
        def connect(self, _callback):
            return None

    class FakeReply:
        def __init__(self):
            self.finished = FakeSignal()

    class FakeNetworkManager:
        def __init__(self):
            self.calls = 0
            self.requested_urls = []

        def get(self, request):
            self.calls += 1
            self.requested_urls.append(request.url().toString())
            return FakeReply()

    fake_network_manager = FakeNetworkManager()
    loader._network_manager = fake_network_manager

    failed_events = []
    loader.thumbnail_failed.connect(lambda key, reason: failed_events.append((key, reason)))
    loader.request_thumbnail(item_key, new_thumbnail_url)

    assert fake_network_manager.calls == 1
    assert fake_network_manager.requested_urls == [new_thumbnail_url]
    assert failed_events == []
