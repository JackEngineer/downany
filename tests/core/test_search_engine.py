"""SearchEngine 结果 URL 与元数据规范化测试（不触网，mock 外部请求）。"""
import json
import urllib.parse

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


def test_bilibili_search_resolves_entries_to_preserve_metadata(monkeypatch):
    class _BilibiliYDL(_FakeYDL):
        def __init__(self, _opts):
            raise AssertionError("Bilibili 搜索不应再走 yt-dlp")

    class _Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self):
            return json.dumps(
                {
                    "code": 0,
                    "data": {
                        "result": [
                            {
                                "aid": 116803598557031,
                                "bvid": "BV1KRgP6EEFq",
                                "arcurl": "http://www.bilibili.com/video/av116803598557031",
                                "title": '<em class="keyword">AI</em> 完整标题',
                                "duration": "3:12",
                                "pic": "//i0.hdslb.com/bfs/archive/cover.jpg",
                                "author": "测试作者",
                            }
                        ]
                    },
                }
            ).encode()

    class _Opener:
        def add_handler(self, _handler):
            pass

        def open(self, request, timeout):
            assert timeout == 6
            parsed = urllib.parse.urlparse(request.full_url)
            query = urllib.parse.parse_qs(parsed.query)
            assert parsed.path == "/x/web-interface/search/type"
            assert query["keyword"] == ["AI"]
            assert query["search_type"] == ["video"]
            assert query["page"] == ["1"]
            return _Response()

    monkeypatch.setattr("src.core.search_engine.yt_dlp.YoutubeDL", _BilibiliYDL)
    monkeypatch.setattr("urllib.request.build_opener", lambda: _Opener())

    videos = SearchEngine.search(Platform.BILIBILI, "AI", max_results=1)

    assert len(videos) == 1
    assert videos[0].url == "https://www.bilibili.com/video/BV1KRgP6EEFq"
    assert videos[0].title == "AI 完整标题"
    assert videos[0].duration == 192
    assert videos[0].thumbnail_url == "https://i0.hdslb.com/bfs/archive/cover.jpg"
    assert videos[0].uploader == "测试作者"


def test_pornhub_search_is_not_supported():
    assert SearchEngine.supports(Platform.PORNHUB) is False


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
