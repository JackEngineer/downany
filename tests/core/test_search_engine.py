"""SearchEngine 结果 URL 规范化测试（不触网，mock yt_dlp）。"""
import pytest

from src.core.download_task import Platform
from src.core.search_engine import SearchEngine, SearchError


class _FakeYDL:
    entries: list = []

    def __init__(self, _opts):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def extract_info(self, _query, download=False):
        return {"entries": type(self).entries}


def _patch_ydl(monkeypatch, entries):
    _FakeYDL.entries = entries
    monkeypatch.setattr("src.core.search_engine.yt_dlp.YoutubeDL", _FakeYDL)


def test_youtube_id_only_url_is_expanded(monkeypatch):
    _patch_ydl(
        monkeypatch,
        [{"id": "abc123", "url": "abc123", "title": "T", "duration": 5, "uploader": "U"}],
    )
    videos = SearchEngine.search(Platform.YOUTUBE, "lofi")
    assert len(videos) == 1
    assert videos[0].url == "https://www.youtube.com/watch?v=abc123"
    assert videos[0].thumbnail_url.endswith("/abc123/hqdefault.jpg")


def test_bilibili_id_only_url_is_expanded(monkeypatch):
    _patch_ydl(
        monkeypatch,
        [{"id": "BV1xx", "url": "BV1xx", "title": "T"}],
    )
    videos = SearchEngine.search(Platform.BILIBILI, "test")
    assert videos[0].url == "https://www.bilibili.com/video/BV1xx"


def test_full_url_is_kept(monkeypatch):
    full = "https://www.youtube.com/watch?v=xyz"
    _patch_ydl(monkeypatch, [{"url": full, "title": "T"}])
    videos = SearchEngine.search(Platform.YOUTUBE, "lofi")
    assert videos[0].url == full


def test_entries_without_url_are_dropped(monkeypatch):
    _patch_ydl(monkeypatch, [{"title": "no url"}, None])
    assert SearchEngine.search(Platform.YOUTUBE, "lofi") == []


def test_unsupported_platform_raises():
    with pytest.raises(SearchError):
        SearchEngine.search(Platform.TWITTER, "x")
