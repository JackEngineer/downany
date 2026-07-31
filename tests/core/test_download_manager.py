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


def _completed_download(path):
    def fake_download(_url, _opts=None):
        return path

    return fake_download


def _run_one_task(manager, task, download_return="/tmp/out.mp4"):
    """用假 Downloader 跑完一个任务，返回捕获的 opts。"""
    captured = {}

    def fake_download(url, opts=None):
        captured["opts"] = opts or {}
        return download_return

    with patch("src.core.download_manager.Downloader") as mock_cls, patch(
        "src.core.download_manager.VideoInfoExtractor.extract", return_value=None
    ):
        instance = MagicMock()
        instance.download.side_effect = fake_download
        mock_cls.return_value = instance
        manager.add_task(task)
        assert _wait_until(lambda: task.status == TaskStatus.COMPLETED)
    return captured["opts"]


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


def test_audio_only_forces_bestaudio_and_mp3_extract(manager):
    task = _make_task()
    task.options.audio_only = True
    opts = _run_one_task(manager, task, "/tmp/out.mp3")
    assert opts["format"] == "bestaudio/best"
    assert opts["postprocessors"] == [
        {"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "192"}
    ]


def test_postprocessing_mp3_same_as_audio_only(manager):
    task = _make_task()
    task.options.postprocessing = "mp3"
    opts = _run_one_task(manager, task, "/tmp/out.mp3")
    assert opts["format"] == "bestaudio/best"
    assert opts["postprocessors"][0]["key"] == "FFmpegExtractAudio"


def test_postprocessing_mp4_adds_video_convertor(manager):
    task = _make_task()
    task.options.postprocessing = "mp4"
    opts = _run_one_task(manager, task)
    assert opts["postprocessors"] == [
        {"key": "FFmpegVideoConvertor", "preferedformat": "mp4"}
    ]
    assert opts.get("format") != "bestaudio/best"


def test_filename_template_used_as_outtmpl(manager):
    task = _make_task(url="https://x.com/user/status/123")
    task.options.filename_template = "%(uploader)s-%(title)s.%(ext)s"
    opts = _run_one_task(manager, task)
    assert opts["outtmpl"].endswith("%(uploader)s-%(title)s.%(ext)s")


def test_script_postprocess_runs_after_completion(manager):
    task = _make_task()
    task.options.postprocessing = "script"
    task.options.postprocess_script = "process-video {file}"
    with patch("src.core.download_manager.subprocess.run") as mock_run:
        mock_run.return_value = MagicMock(returncode=0, stderr="")
        _run_one_task(manager, task, "/tmp/my file.mp4")
        assert _wait_until(lambda: mock_run.called)
    command = mock_run.call_args[0][0]
    assert command.startswith("process-video ")
    assert "'/tmp/my file.mp4'" in command  # shlex.quote 处理空格


def test_priority_picks_highest_first():
    config = MagicMock()
    config.get_concurrent_downloads.return_value = 1
    mgr = DownloadManager(config=config, db=MagicMock())
    low = _make_task(url="https://example.com/low")
    mid = _make_task(url="https://example.com/mid")
    high = _make_task(url="https://example.com/high")
    low.priority, mid.priority, high.priority = 0, 5, 10
    for task in (low, mid, high):
        mgr.tasks[task.id] = task
    with mgr._lock:
        first = mgr._pick_next_pending_locked()
        assert first is not None and first.id == high.id
        # 同优先级按创建时间先到先得
        mid.created_at = high.created_at
        high.created_at = mid.created_at
        high.status = TaskStatus.PENDING
        mgr.active_tasks[high.id] = MagicMock()
        second = mgr._pick_next_pending_locked()
        assert second is not None and second.id == mid.id


def test_update_task_changes_options_and_priority(manager):
    task = _make_task()
    manager.tasks[task.id] = task
    updated = manager.update_task(
        task.id, audio_only=True, postprocessing="mp4", priority=7, quality="720p"
    )
    assert updated is task
    assert task.options.audio_only is True
    assert task.options.postprocessing == "mp4"
    assert task.options.quality == "720p"
    assert task.priority == 7


def test_update_task_rejects_option_change_while_downloading(manager):
    task = _make_task()
    task.status = TaskStatus.DOWNLOADING
    manager.tasks[task.id] = task
    with pytest.raises(ValueError):
        manager.update_task(task.id, audio_only=True)
    # 但允许仅改标题
    manager.update_task(task.id, title="新标题")
    assert task.video_info.title == "新标题"


def test_update_task_renames_completed_file(manager, tmp_path):
    target = tmp_path / "旧名字.mp4"
    target.write_bytes(b"data")
    task = _make_task()
    task.status = TaskStatus.COMPLETED
    task.file_path = str(target)
    manager.tasks[task.id] = task
    manager.update_task(task.id, title="新名字")
    assert not target.exists()
    assert (tmp_path / "新名字.mp4").exists()
    assert task.file_path.endswith("新名字.mp4")


def test_placeholder_title_backfilled_from_filename_on_complete(manager):
    task = _make_task(title="未命名视频")
    with patch("src.core.download_manager.Downloader") as mock_cls, patch(
        "src.core.download_manager.VideoInfoExtractor.extract", return_value=None
    ):
        instance = MagicMock()
        instance.last_info = None
        instance.download.return_value = "/tmp/真正的标题.mp4"
        mock_cls.return_value = instance
        manager.add_task(task)
        assert _wait_until(lambda: task.status == TaskStatus.COMPLETED)
    assert task.video_info.title == "真正的标题"


def test_placeholder_title_backfilled_from_twitter_last_info(manager):
    from src.core.download_task import Platform

    task = _make_task(url="https://x.com/u/status/1", title="未命名视频")
    info = VideoInfo(
        url=task.video_info.url,
        title="推文正文标题",
        platform=Platform.TWITTER,
    )
    with patch("src.core.download_manager.Downloader") as mock_cls, patch(
        "src.core.download_manager.VideoInfoExtractor.extract", return_value=None
    ):
        instance = MagicMock()
        instance.last_info = info
        instance.download.return_value = "/tmp/hash.mp4"
        mock_cls.return_value = instance
        manager.add_task(task)
        assert _wait_until(lambda: task.status == TaskStatus.COMPLETED)
    assert task.video_info.title == "推文正文标题"
