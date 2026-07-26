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


def test_successful_parse(monkeypatch):
    monkeypatch.setattr(
        url_parser, "build_parse_command", lambda url, proxy=None: _fake_command(FAKE_INFO)
    )
    session = ParseSession("https://www.youtube.com/watch?v=x", timeout=10)
    info = session.run()
    assert info.title == "测试视频"
    assert info.duration == 61
    assert info.uploader == "uploader1"
    assert info.platform == Platform.YOUTUBE


def test_timeout_kills_process(monkeypatch):
    monkeypatch.setattr(
        url_parser,
        "build_parse_command",
        lambda url, proxy=None: [sys.executable, "-c", "import time; time.sleep(30)"],
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
        lambda url, proxy=None: [sys.executable, "-c", "import time; time.sleep(30)"],
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
        lambda url, proxy=None: [
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
        lambda url, proxy=None: [
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
    assert info.title == "回退标题"
    assert info.platform == Platform.TWITTER
