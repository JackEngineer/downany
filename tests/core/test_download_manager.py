"""DownloadManager 状态机与并发安全测试（Qt 无关）。"""
import threading
import time
from unittest.mock import MagicMock, patch

import pytest

from src.core.download_manager import DownloadManager
from src.core.download_task import DownloadOptions, DownloadTask, TaskStatus, VideoInfo
from src.core.downloader import DownloadCancelled, DownloadError


@pytest.fixture
def manager():
    config = MagicMock()
    config.get_concurrent_downloads.return_value = 2
    db = MagicMock()
    mgr = DownloadManager(config=config, db=db)
    mgr.start()
    yield mgr
    mgr.stop(join_timeout=2)


def _make_task(url="https://example.com/a", title="t"):
    return DownloadTask(
        video_info=VideoInfo(url=url, title=title),
        options=DownloadOptions(output_path="/tmp"),
    )


def _wait_until(predicate, timeout=3.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return predicate()


def test_download_failure_marks_failed_and_emits_event(manager):
    task = _make_task()
    events = []
    manager.events.subscribe(lambda e, p: events.append((e, p)))

    with patch("src.core.download_manager.Downloader") as mock_cls, patch(
        "src.core.download_manager.VideoInfoExtractor.extract", return_value=None
    ):
        instance = MagicMock()
        instance.download.side_effect = DownloadError("boom")
        mock_cls.return_value = instance
        manager.add_task(task)
        assert _wait_until(
            lambda: any(e == "task_failed" for e, _ in events)
        )

    assert task.status == TaskStatus.FAILED
    assert "boom" in task.error_message
    manager.db.add_download_record.assert_called()
    assert ("task_added", {"task_id": task.id}) in events
    assert ("task_failed", {"task_id": task.id, "error": task.error_message}) in events


def test_cancel_does_not_complete(manager):
    task = _make_task(title="cancel-me")
    started = threading.Event()
    proceed = threading.Event()

    def fake_download(url, opts=None):
        started.set()
        proceed.wait(timeout=2)
        raise DownloadCancelled("任务已取消")

    with patch("src.core.download_manager.Downloader") as mock_cls, patch(
        "src.core.download_manager.VideoInfoExtractor.extract", return_value=None
    ):
        instance = MagicMock()
        instance.download.side_effect = fake_download
        mock_cls.return_value = instance
        manager.add_task(task)
        assert started.wait(2)
        manager.cancel_task(task.id)
        proceed.set()
        assert _wait_until(lambda: task.id not in manager.active_tasks)

    assert task.status == TaskStatus.CANCELLED


def test_pause_then_resume_after_thread_exits(manager):
    task = _make_task(title="pause-me")
    call_count = {"n": 0}
    gate = threading.Event()

    def fake_download(url, opts=None):
        call_count["n"] += 1
        if call_count["n"] == 1:
            gate.set()
            time.sleep(0.15)
            raise DownloadCancelled("任务已暂停")
        return "/tmp/done.mp4"

    with patch("src.core.download_manager.Downloader") as mock_cls, patch(
        "src.core.download_manager.VideoInfoExtractor.extract", return_value=None
    ):
        instance = MagicMock()
        instance.download.side_effect = fake_download
        mock_cls.return_value = instance
        manager.add_task(task)
        assert gate.wait(2)
        manager.pause_task(task.id)
        assert _wait_until(lambda: task.id not in manager.active_tasks)
        assert task.status == TaskStatus.PAUSED

        manager.resume_task(task.id)
        assert _wait_until(lambda: task.status == TaskStatus.COMPLETED)

    assert call_count["n"] >= 2


def test_resume_while_active_does_not_double_start(manager):
    task = _make_task(title="double")
    started = threading.Event()
    release = threading.Event()
    starts = []

    def fake_download(url, opts=None):
        starts.append(1)
        started.set()
        release.wait(timeout=2)
        raise DownloadCancelled("任务已暂停")

    with patch("src.core.download_manager.Downloader") as mock_cls, patch(
        "src.core.download_manager.VideoInfoExtractor.extract", return_value=None
    ):
        instance = MagicMock()
        instance.download.side_effect = fake_download
        mock_cls.return_value = instance
        manager.add_task(task)
        assert started.wait(2)
        manager.pause_task(task.id)
        manager.resume_task(task.id)
        assert len(starts) == 1
        release.set()
        assert _wait_until(lambda: task.id not in manager.active_tasks)

    assert len(starts) <= 2


def test_two_managers_are_independent_instances():
    a = DownloadManager(config=MagicMock(), db=MagicMock())
    b = DownloadManager(config=MagicMock(), db=MagicMock())
    assert a is not b


def test_http_headers_merged_into_ydl_opts(manager):
    from src.core.http_headers import DEFAULT_HTTP_HEADERS

    task = _make_task(title="with-headers")
    task.options.http_headers = {
        "Referer": "https://example.com/watch",
        "Cookie": "sid=1",
    }
    captured = {}

    def fake_download(url, opts=None):
        captured["opts"] = opts
        return "/tmp/done.mp4"

    with patch("src.core.download_manager.Downloader") as mock_cls, patch(
        "src.core.download_manager.VideoInfoExtractor.extract", return_value=None
    ):
        instance = MagicMock()
        instance.download.side_effect = fake_download
        mock_cls.return_value = instance
        manager.add_task(task)
        assert _wait_until(lambda: task.status == TaskStatus.COMPLETED)

    headers = captured["opts"]["http_headers"]
    assert headers["Referer"] == "https://example.com/watch"
    assert headers["Cookie"] == "sid=1"
    assert headers["User-Agent"] == DEFAULT_HTTP_HEADERS["User-Agent"]


def test_direct_media_url_uses_task_title_in_outtmpl(manager):
    task = _make_task(url="https://cdn.example/4d0c6728-abcd.m3u8", title="我的视频")
    task.options.http_headers = {"Referer": "https://example.com/"}
    captured = {}

    def fake_download(url, opts=None):
        captured["opts"] = opts
        return "/tmp/done.mp4"

    with patch("src.core.download_manager.Downloader") as mock_cls, patch(
        "src.core.download_manager.VideoInfoExtractor.extract", return_value=None
    ):
        instance = MagicMock()
        instance.download.side_effect = fake_download
        mock_cls.return_value = instance
        manager.add_task(task)
        assert _wait_until(lambda: task.status == TaskStatus.COMPLETED)

    outtmpl = captured["opts"]["outtmpl"]
    assert "我的视频.%(ext)s" in outtmpl
    assert "4d0c6728" not in outtmpl


def test_page_url_task_keeps_ytdlp_title(manager):
    """页面链接任务不固定 outtmpl，交给 yt-dlp 用解析到的真实标题。"""
    task = _make_task(url="https://x.com/user/status/123", title="页面标题")
    captured = {}

    def fake_download(url, opts=None):
        captured["opts"] = opts
        return "/tmp/done.mp4"

    with patch("src.core.download_manager.Downloader") as mock_cls, patch(
        "src.core.download_manager.VideoInfoExtractor.extract", return_value=None
    ):
        instance = MagicMock()
        instance.download.side_effect = fake_download
        mock_cls.return_value = instance
        manager.add_task(task)
        assert _wait_until(lambda: task.status == TaskStatus.COMPLETED)

    assert "outtmpl" not in captured["opts"]
