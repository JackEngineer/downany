"""ParseSession 取消、超时与成功路径测试。"""
import sys
import threading
import time

import pytest

import src.core.url_parser as url_parser
from src.core.download_task import Platform
from src.core.url_parser import (
    ParseCancelled,
    ParseFailed,
    ParseSession,
    ParseTimeout,
    build_parse_command,
)


FAKE_INFO = {
    "title": "测试视频",
    "duration": 61,
    "thumbnail": "https://example.com/t.jpg",
    "uploader": "uploader1",
    "filesize": 12345,
}


def _fake_command(payload):
    """构造一个打印 JSON 后退出的子进程命令。"""
    code = f"import json; print(json.dumps({payload!r}))"
    return [sys.executable, "-c", code]


def test_build_parse_command_includes_proxy():
    cmd = build_parse_command("https://example.com/v", proxy="http://127.0.0.1:7890")
    assert "--proxy" in cmd
    assert "http://127.0.0.1:7890" in cmd
    assert cmd[-1] == "https://example.com/v"
    assert "--no-playlist" in cmd


def test_build_parse_command_allows_playlist_when_requested():
    cmd = build_parse_command("https://example.com/playlist", allow_playlist=True)
    assert "--no-playlist" not in cmd
    assert "--flat-playlist" in cmd


def test_successful_parse(monkeypatch):
    monkeypatch.setattr(
        url_parser, "build_parse_command", lambda url, proxy=None, allow_playlist=False: _fake_command(FAKE_INFO)
    )
    session = ParseSession("https://www.youtube.com/watch?v=x", timeout=10)
    result = session.run()
    assert result.info.title == "测试视频"
    assert result.info.duration == 61
    assert result.info.uploader == "uploader1"
    assert result.info.platform == Platform.YOUTUBE


def test_timeout_kills_process(monkeypatch):
    monkeypatch.setattr(
        url_parser,
        "build_parse_command",
        lambda url, proxy=None, allow_playlist=False: [sys.executable, "-c", "import time; time.sleep(30)"],
    )
    session = ParseSession("https://example.com/v", timeout=0.5)
    start = time.monotonic()
    with pytest.raises(ParseTimeout):
        session.run()
    assert time.monotonic() - start < 5


def test_cancel_interrupts_running_parse(monkeypatch):
    monkeypatch.setattr(
        url_parser,
        "build_parse_command",
        lambda url, proxy=None, allow_playlist=False: [sys.executable, "-c", "import time; time.sleep(30)"],
    )
    session = ParseSession("https://example.com/v", timeout=60)
    result = {}

    def run():
        try:
            session.run()
        except Exception as exc:
            result["error"] = exc

    thread = threading.Thread(target=run)
    thread.start()
    time.sleep(0.3)
    session.cancel()
    thread.join(timeout=5)

    assert not thread.is_alive()
    assert isinstance(result["error"], ParseCancelled)


def test_cancel_before_run_raises_immediately():
    session = ParseSession("https://example.com/v")
    session.cancel()
    with pytest.raises(ParseCancelled):
        session.run()


def test_nonzero_exit_raises_parse_failed(monkeypatch):
    monkeypatch.setattr(
        url_parser,
        "build_parse_command",
        lambda url, proxy=None, allow_playlist=False: [
            sys.executable,
            "-c",
            "import sys; sys.stderr.write('ERROR: Unsupported URL'); sys.exit(1)",
        ],
    )
    session = ParseSession("https://example.com/v", timeout=10)
    with pytest.raises(ParseFailed) as exc_info:
        session.run()
    assert "Unsupported URL" in str(exc_info.value)


def test_twitter_parse_falls_back_to_fxtwitter(monkeypatch):
    monkeypatch.setattr(
        url_parser,
        "build_parse_command",
        lambda url, proxy=None, allow_playlist=False: [
            sys.executable,
            "-c",
            "import sys; sys.stderr.write('ERROR: [twitter] Video #1 is unavailable'); sys.exit(1)",
        ],
    )

    from src.core.download_task import VideoInfo

    def fake_resolve(url, proxy=None):
        return (
            VideoInfo(
                url=url,
                title="回退标题",
                duration=12,
                thumbnail_url="https://example.com/t.jpg",
                uploader="u",
                platform=Platform.TWITTER,
            ),
            "https://video.twimg.com/x.mp4",
        )

    monkeypatch.setattr(url_parser, "resolve_twitter_media", fake_resolve)
    session = ParseSession(
        "https://x.com/LillianB47947/status/2057757739775033790/video/1",
        timeout=10,
    )
    info = session.run()
    assert info.info.title == "回退标题"
    assert info.info.platform == Platform.TWITTER


def test_playlist_parse_returns_entries_summary(monkeypatch):
    payload = {
        "id": "PL123",
        "title": "播放列表",
        "playlist_title": "播放列表",
        "duration": 0,
        "entries": [
            {"id": "a1", "title": "第一集", "url": "https://example.com/a1", "playlist_index": 1},
            {"id": "a2", "title": "第二集", "webpage_url": "https://example.com/a2"},
        ],
    }
    monkeypatch.setattr(
        url_parser, "build_parse_command", lambda url, proxy=None, allow_playlist=False: _fake_command(payload)
    )
    session = ParseSession(
        "https://www.youtube.com/playlist?list=xyz",
        timeout=10,
        allow_playlist=True,
    )
    result = session.run()
    assert result.info.title == "播放列表"
    assert len(result.entries) == 2
    assert result.entries[0]["id"] == "a1"
    assert result.entries[0]["index"] == "1"
    assert result.entries[0]["available"] == "1"
    assert result.entries[1]["url"] == "https://example.com/a2"
    assert result.entries[1]["index"] == "2"
    assert result.playlist == {"id": "PL123", "title": "播放列表", "count": 2}


def test_flat_playlist_synthesizes_youtube_watch_url(monkeypatch):
    payload = {
        "id": "PLabc",
        "title": "合集",
        "entries": [
            {"id": "vid1", "title": "只有 id"},
        ],
    }
    monkeypatch.setattr(
        url_parser, "build_parse_command", lambda url, proxy=None, allow_playlist=False: _fake_command(payload)
    )
    session = ParseSession(
        "https://www.youtube.com/playlist?list=PLabc",
        timeout=10,
        allow_playlist=True,
    )
    result = session.run()
    assert result.entries[0]["url"] == "https://www.youtube.com/watch?v=vid1"
    assert result.playlist["count"] == 1


def test_flat_playlist_empty_title_still_available_for_bilibili(monkeypatch):
    payload = {
        "id": "season1",
        "title": "合集",
        "entries": [
            {
                "id": "BV1AB6bBHEM4",
                "ie_key": "BiliBili",
                "_type": "url",
                "url": "https://www.bilibili.com/video/BV1AB6bBHEM4",
            },
        ],
    }
    monkeypatch.setattr(
        url_parser,
        "build_parse_command",
        lambda url, proxy=None, allow_playlist=False: _fake_command(payload),
    )
    monkeypatch.setattr(
        url_parser,
        "fetch_bilibili_view",
        lambda bvid, proxy=None: ("新秩序·第一集", "https://i0.hdslb.com/bfs/x.jpg"),
    )
    session = ParseSession(
        "https://space.bilibili.com/1/lists/2?type=season",
        timeout=10,
        allow_playlist=True,
    )
    result = session.run()
    assert result.entries[0]["available"] == "1"
    assert result.entries[0]["title"] == "新秩序·第一集"
    assert result.entries[0]["thumbnail_url"].endswith("x.jpg")
    assert result.entries[0]["url"].endswith("BV1AB6bBHEM4")


def test_enrich_bilibili_skips_non_empty_titles(monkeypatch):
    called = []

    def _fake(bvid, proxy=None):
        called.append(bvid)
        return ("补全", "")

    monkeypatch.setattr(url_parser, "fetch_bilibili_view", _fake)
    entries = [
        {"id": "BV1AB6bBHEM4", "title": "已有", "url": "https://www.bilibili.com/video/BV1AB6bBHEM4"},
        {"id": "BV1KfoABfEF4", "title": "", "url": "https://www.bilibili.com/video/BV1KfoABfEF4"},
    ]
    url_parser.enrich_bilibili_entry_titles(entries)
    assert called == ["BV1KfoABfEF4"]
    assert entries[0]["title"] == "已有"
    assert entries[1]["title"] == "补全"


def test_looks_like_playlist_url():
    from src.core.url_parser import looks_like_playlist_url

    assert looks_like_playlist_url(
        "https://www.youtube.com/playlist?list=PLvAJTuxHphYqM-4WPDlnQduRE_Be3ZElw"
    )
    assert looks_like_playlist_url("https://www.youtube.com/watch?v=abc&list=PLxxx")
    assert not looks_like_playlist_url("https://www.youtube.com/watch?v=abc")
    assert not looks_like_playlist_url("https://youtu.be/abc")
