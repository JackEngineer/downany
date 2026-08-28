"""DownloadManager 状态机与并发安全测试（Qt 无关）。"""
import asyncio
import hashlib
import shutil
import sqlite3
import sys
import tempfile
import threading
import time
from pathlib import Path
from types import MappingProxyType
from unittest.mock import MagicMock, patch

import pytest

from src.core.download_manager import DownloadManager, format_postprocess_command
from src.core.download_task import (
    DownloadOptions,
    DownloadTask,
    Platform,
    TaskRunIntent,
    TaskStatus,
    VideoInfo,
)
from src.core.downloader import DownloadCancelled, DownloadError
from src.core.downloader import DownloadResult, SourceFacts
from src.core.task_actions import TaskAction, TaskActionOutcome
from src.core.media_verifier import MediaVerification
from src.core.output_commit import CommittedOutput
from src.core import error_codes as ec
from src.data.database import HistoryDB
from src.data.json_config import JsonConfig
from src.data.telegram_delivery_store import DeliveryStateConflict, TelegramDeliveryStore
from src.data.queue_store import QueueStore
from src.sidecar.telegram_delivery_service import TelegramDeliveryService
from src.sidecar.bin_paths import MediaToolchain

_TEST_OUTPUT_ROOT = Path(tempfile.gettempdir()) / "DownanyTests" / "outputs"


@pytest.fixture(autouse=True)
def verified_output_dependencies(monkeypatch, tmp_path):
    """Keep manager tests focused while satisfying the verified-output boundary."""
    global _TEST_OUTPUT_ROOT
    _TEST_OUTPUT_ROOT = tmp_path / "outputs"
    toolchain = MediaToolchain(
        ffmpeg=tmp_path / "ffmpeg",
        ffprobe=tmp_path / "ffprobe",
        ffmpeg_location=tmp_path,
        source="test",
    )
    monkeypatch.setattr(
        "src.core.download_manager.resolve_media_toolchain",
        lambda **_kwargs: toolchain,
    )
    monkeypatch.setattr(
        "src.core.download_manager.verify_media",
        lambda *_args, **_kwargs: MediaVerification(
            "mp4", ("video",), (), False, False, 0
        ),
    )
    monkeypatch.setattr(
        "src.core.download_manager.ensure_local_thumbnail",
        lambda *_args, **_kwargs: "",
    )

    def commit(*, download_root, playlist_folder, result):
        folder = Path(download_root)
        if playlist_folder:
            folder /= playlist_folder
        folder.mkdir(parents=True, exist_ok=True)
        suffix = result.main_file.suffix or ".mp4"
        target = folder / f"{result.main_file.stem} [{result.source_key[:8]}]{suffix}"
        shutil.copyfile(result.main_file, target)
        return CommittedOutput(target, (), ())

    monkeypatch.setattr("src.core.download_manager.commit_output_bundle", commit)


def _download_result(instance, staging_dir, file_path, *, info=None):
    staging = Path(staging_dir)
    staging.mkdir(parents=True, exist_ok=True)
    source = Path(file_path)
    staged = staging / source.name
    try:
        original = source.read_bytes()
    except OSError:
        original = b"test-media"
    staged.write_bytes(original or b"test-media")
    payload = dict(info or getattr(instance, "last_ydl_info", None) or {})
    payload.setdefault("title", source.stem)
    payload["filepath"] = str(staged)
    return DownloadResult(
        main_file=staged,
        subtitles=(),
        info=MappingProxyType(payload),
        rendered_leaf=source.name,
        source_key=staging.name,
        downloaded_this_run=True,
        source_facts=SourceFacts((), False, False, False, True),
    )


def _result_side_effect(instance, file_path, *, info=None):
    def download(_url, _plan, *, toolchain, staging_dir):
        return _download_result(instance, staging_dir, file_path, info=info)

    return download


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
        options=DownloadOptions(output_path=str(_TEST_OUTPUT_ROOT)),
    )


def _wait_until(predicate, timeout=3.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return predicate()


def _run_one_task(manager, task, download_return="/tmp/out.mp4"):
    """用假 Downloader 跑完一个任务，返回编译后的 yt-dlp 选项。"""
    captured = {}

    def fake_download(url, plan, *, toolchain, staging_dir):
        captured["opts"] = plan.to_ydl_options()
        captured["opts"]["_final_leaf_template"] = plan.final_leaf_template
        captured["opts"]["_playlist_folder"] = plan.playlist_folder
        captured["opts"]["_staging_dir"] = str(staging_dir)
        return _download_result(instance, staging_dir, download_return)

    with patch("src.core.download_manager.Downloader") as mock_cls, patch(
        "src.core.download_manager.VideoInfoExtractor.extract", return_value=None
    ):
        instance = MagicMock()
        instance.download.side_effect = fake_download
        mock_cls.return_value = instance
        manager.add_task(task)
        assert _wait_until(lambda: task.status == TaskStatus.COMPLETED)
    return captured["opts"]


def test_download_rebinds_missing_system_proxy_before_starting(manager):
    manager.config.get_proxy_for_download.return_value = "http://127.0.0.1:7897"
    task = _make_task(title="old-task-without-proxy")

    opts = _run_one_task(manager, task)

    assert task.options.proxy == "http://127.0.0.1:7897"
    assert opts["proxy"] == "http://127.0.0.1:7897"


def test_verified_output_fixture_skips_thumbnail_extraction_for_fake_media(
    manager, monkeypatch
):
    def fail_if_thumbnail_extraction_runs(*_args, **_kwargs):
        raise AssertionError("test fixture leaked into real thumbnail extraction")

    monkeypatch.setattr(
        "src.core.local_thumbnail.extract_video_thumbnail",
        fail_if_thumbnail_extraction_runs,
    )

    _run_one_task(manager, _make_task(title="fake-media-thumbnail-isolation"))


def test_auto_detected_proxy_credentials_are_not_logged(manager, caplog):
    manager.config.get_proxy_for_download.return_value = (
        "http://proxy-user:proxy-secret@127.0.0.1:7897"
    )
    task = _make_task(title="proxy-credential-log-test")

    with caplog.at_level("INFO", logger="DownloadManager"):
        manager._refresh_task_proxy(task)

    assert task.options.proxy == "http://proxy-user:proxy-secret@127.0.0.1:7897"
    assert "proxy-user" not in caplog.text
    assert "proxy-secret" not in caplog.text


def test_retry_rebinds_missing_system_proxy(manager):
    manager.config.get_proxy_for_download.return_value = "http://127.0.0.1:7897"
    task = _make_task(title="failed-task-without-proxy")
    task.status = TaskStatus.FAILED
    manager.tasks[task.id] = task

    manager.retry_task(task.id)

    assert task.status == TaskStatus.PENDING
    assert task.options.proxy == "http://127.0.0.1:7897"


def test_retry_repairs_duplicate_youtube_url(manager):
    malformed = (
        "https://www.youtube.comhttps://www.youtube.com/watch?v=QPspNEOkvxM"
        "/watch?v=QPspNEOkvxM"
    )
    task = _make_task(url=malformed, title="failed-youtube-task")
    task.status = TaskStatus.FAILED
    manager.tasks[task.id] = task

    manager.retry_task(task.id)

    assert task.video_info.url == "https://www.youtube.com/watch?v=QPspNEOkvxM"


def test_youtube_progress_replaces_stale_extension_title(manager):
    """首次下载进度应立即采用 yt-dlp 元数据，避免页面 URL 配到旧标题。"""
    task = _make_task(
        url="https://www.youtube.com/watch?v=current",
        title="上一条视频标题",
    )
    observed = {}

    with patch("src.core.download_manager.Downloader") as mock_cls, patch(
        "src.core.download_manager.VideoInfoExtractor.extract", return_value=None
    ):
        instance = MagicMock()
        instance.last_info = None
        instance.last_ydl_info = None

        def fake_download(_url, _plan, *, toolchain, staging_dir):
            progress = instance.set_callbacks.call_args.kwargs["progress"]
            progress(
                {
                    "status": "downloading",
                    "_percent_str": "1.0%",
                    "downloaded_bytes": 1,
                    "total_bytes": 100,
                    "info_dict": {
                        "title": "当前视频真实标题",
                        "uploader": "当前作者",
                    },
                }
            )
            observed["title_during_download"] = task.video_info.title
            return _download_result(
                instance,
                staging_dir,
                "/tmp/out.mp4",
                info={"title": "当前视频真实标题", "uploader": "当前作者"},
            )

        instance.download.side_effect = fake_download
        mock_cls.return_value = instance
        manager.add_task(task)
        assert _wait_until(lambda: task.status == TaskStatus.COMPLETED)

    assert observed["title_during_download"] == "当前视频真实标题"


def test_progress_callbacks_never_open_sqlite_and_late_callbacks_preserve_completion(tmp_path, monkeypatch):
    store = QueueStore(str(tmp_path / "queue.db"))
    mgr = DownloadManager(config=JsonConfig(str(tmp_path / "config.json")),
                          db=MagicMock(), queue_store=store, temp_dir=str(tmp_path / "staging"))
    task = _make_task(url="https://www.youtube.com/watch?v=local-test", title="old title")
    mgr.add_task(task)
    callback_writes, progress_hook = [], []
    real_connect = store._get_connection
    in_callback = [False]

    def connect():
        if in_callback[0]:
            callback_writes.append(True)
        return real_connect()

    monkeypatch.setattr(store, "_get_connection", connect)
    with patch("src.core.download_manager.Downloader") as mock_cls:
        instance = MagicMock()
        instance.last_info = None

        def download(_url, _plan, *, toolchain, staging_dir):
            progress = instance.set_callbacks.call_args.kwargs["progress"]
            progress_hook.append(progress)
            in_callback[0] = True
            try:
                for value in range(100):
                    progress({"status": "downloading", "_percent_str": f"{value}%",
                              "downloaded_bytes": value, "total_bytes": 100,
                              "info_dict": {"title": "current title"}})
            finally:
                in_callback[0] = False
            return _download_result(instance, staging_dir, "local.mp4", info={"title": "current title"})

        instance.download.side_effect = download
        mock_cls.return_value = instance
        mgr._download_task(task)
    assert task.status is TaskStatus.COMPLETED
    assert callback_writes == []
    before = task.to_snapshot()
    progress_hook[0]({"status": "downloading", "_percent_str": "99%", "downloaded_bytes": 99})
    assert task.to_snapshot() == before
    assert store.load_tasks()[0].progress == 100


def test_download_repairs_duplicate_youtube_url_before_starting(manager):
    malformed = (
        "https://www.youtube.comhttps://www.youtube.com/watch?v=QPspNEOkvxM"
        "/watch?v=QPspNEOkvxM"
    )
    task = _make_task(url=malformed, title="youtube-task")
    captured = {}

    def fake_download(url, _plan, *, toolchain, staging_dir):
        captured["url"] = url
        return _download_result(instance, staging_dir, "/tmp/out.mp4")

    with patch("src.core.download_manager.Downloader") as mock_cls, patch(
        "src.core.download_manager.VideoInfoExtractor.extract", return_value=None
    ):
        instance = MagicMock()
        instance.download.side_effect = fake_download
        mock_cls.return_value = instance
        manager.add_task(task)
        assert _wait_until(lambda: task.status == TaskStatus.COMPLETED)

    assert captured["url"] == "https://www.youtube.com/watch?v=QPspNEOkvxM"
    assert task.video_info.url == "https://www.youtube.com/watch?v=QPspNEOkvxM"


def test_youtube_task_skips_optional_metadata_prefetch(manager):
    """元数据预取不可阻塞真正的 YouTube 下载请求。"""
    task = _make_task(
        url="https://www.youtube.com/watch?v=UXEjocWEfiM",
        title="未命名视频",
    )
    task.video_info.platform = Platform.YOUTUBE

    with patch("src.core.download_manager.Downloader") as mock_cls, patch(
        "src.core.download_manager.VideoInfoExtractor.extract",
        side_effect=AssertionError("YouTube 下载不应先做可选元数据预取"),
    ):
        instance = MagicMock()
        instance.last_info = None
        instance.last_ydl_info = None
        instance.download.side_effect = (
            lambda _url, _plan, *, toolchain, staging_dir: _download_result(
                instance, staging_dir, "/tmp/out.mp4"
            )
        )
        mock_cls.return_value = instance

        manager.add_task(task)
        assert _wait_until(
            lambda: task.status in {TaskStatus.COMPLETED, TaskStatus.FAILED}
        )

    assert task.status == TaskStatus.COMPLETED


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
    assert task.error_code == ec.UNKNOWN
    manager.db.add_download_record.assert_called()
    assert ("task_added", {"task_id": task.id}) in events
    assert ("task_failed", {"task_id": task.id, "error": task.error_message}) in events


def test_cancel_does_not_complete(manager):
    task = _make_task(title="cancel-me")
    started = threading.Event()
    proceed = threading.Event()

    def fake_download(url, _plan, *, toolchain, staging_dir):
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

    def fake_download(url, _plan, *, toolchain, staging_dir):
        call_count["n"] += 1
        if call_count["n"] == 1:
            gate.set()
            time.sleep(0.15)
            raise DownloadCancelled("任务已暂停")
        return _download_result(instance, staging_dir, "/tmp/done.mp4")

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

    def fake_download(url, _plan, *, toolchain, staging_dir):
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
    opts = _run_one_task(manager, task, "/tmp/done.mp4")

    headers = opts["http_headers"]
    assert headers["Referer"] == "https://example.com/watch"
    assert headers["Cookie"] == "sid=1"
    assert headers["User-Agent"] == DEFAULT_HTTP_HEADERS["User-Agent"]


def test_direct_media_url_uses_stable_source_key_in_final_template(manager):
    task = _make_task(url="https://cdn.example/4d0c6728-abcd.m3u8", title="我的视频")
    task.options.http_headers = {"Referer": "https://example.com/"}
    opts = _run_one_task(manager, task, "/tmp/done.mp4")

    template = opts["_final_leaf_template"]
    assert "%(title)s" in template
    assert "%(ext)s" in template
    assert "[" in template


def test_page_url_task_uses_ytdlp_title_and_page_identity_template(manager):
    """页面链接使用 yt-dlp 标题，并加入来源身份避免同名覆盖。"""
    task = _make_task(url="https://x.com/user/status/123", title="页面标题")
    opts = _run_one_task(manager, task, "/tmp/done.mp4")

    assert opts["_final_leaf_template"] == (
        "%(title)s [%(extractor)s-%(id)s].%(ext)s"
    )


def test_audio_only_forces_bestaudio_and_mp3_extract(manager):
    task = _make_task()
    task.options.audio_only = True
    task.options.embed_metadata = False
    opts = _run_one_task(manager, task, "/tmp/out.mp3")
    assert opts["format"] == "bestaudio/best"
    assert opts["postprocessors"] == [
        {"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "192"}
    ]


def test_postprocessing_mp3_same_as_audio_only(manager):
    task = _make_task()
    task.options.postprocessing = "mp3"
    task.options.embed_metadata = False
    opts = _run_one_task(manager, task, "/tmp/out.mp3")
    assert opts["format"] == "bestaudio/best"
    assert opts["postprocessors"][0]["key"] == "FFmpegExtractAudio"


def test_completed_task_uses_final_output_size(manager, tmp_path):
    source = tmp_path / "converted.mp3"
    source.write_bytes(b"final-output-is-larger")
    task = _make_task()
    task.downloaded_bytes = 5
    task.total_bytes = 9

    _run_one_task(manager, task, str(source))

    final_size = Path(task.file_path).stat().st_size
    assert final_size == len(b"final-output-is-larger")
    assert task.downloaded_bytes == final_size
    assert task.total_bytes == final_size
    assert task.video_info.file_size == final_size


def test_script_completion_refreshes_size_after_script_mutates_output(
    manager, tmp_path, monkeypatch
):
    monkeypatch.setattr(sys, "platform", "darwin")
    source = tmp_path / "scripted.mp4"
    source.write_bytes(b"before")
    task = _make_task()
    task.options.postprocessing = "script"
    task.options.postprocess_script = "process-video {file}"

    def mutate_output(*_args, **_kwargs):
        Path(task.file_path).write_bytes(b"after-script-output")
        return MagicMock(returncode=0, stderr="")

    with patch(
        "src.core.download_manager.subprocess.run", side_effect=mutate_output
    ):
        _run_one_task(manager, task, str(source))

    final_size = Path(task.file_path).stat().st_size
    assert final_size == len(b"after-script-output")
    assert task.downloaded_bytes == final_size
    assert task.total_bytes == final_size
    assert task.video_info.file_size == final_size


def test_postprocessing_mp4_adds_video_convertor(manager):
    task = _make_task()
    task.options.postprocessing = "mp4"
    task.options.embed_metadata = False
    opts = _run_one_task(manager, task)
    assert opts["postprocessors"] == [
        {"key": "FFmpegVideoConvertor", "preferedformat": "mp4"}
    ]
    assert opts.get("format") != "bestaudio/best"


def test_filename_template_used_as_outtmpl(manager):
    task = _make_task(url="https://x.com/user/status/123")
    task.options.filename_template = "%(uploader)s-%(title)s.%(ext)s"
    opts = _run_one_task(manager, task)
    assert opts["_final_leaf_template"] == (
        "%(uploader)s-%(title)s [%(extractor)s-%(id)s].%(ext)s"
    )


def test_playlist_group_uses_subfolder_outtmpl(manager):
    task = _make_task(url="https://www.youtube.com/watch?v=abc", title="第一集")
    task.group_id = "g1"
    task.group_title = "我的播放列表"
    task.playlist_index = 5
    opts = _run_one_task(manager, task)
    assert opts["_final_leaf_template"].startswith("005 - %(title)s")
    assert "我的播放列表" in opts["_playlist_folder"]


def test_temp_dir_sets_task_owned_staging_directory(tmp_path):
    config = MagicMock()
    config.get_concurrent_downloads.return_value = 1
    mgr = DownloadManager(
        config=config,
        db=MagicMock(),
        temp_dir=str(tmp_path / "tmpdir"),
    )
    mgr.start()
    try:
        task = _make_task(url="https://www.youtube.com/watch?v=abc")
        opts = _run_one_task(mgr, task)
        assert opts["_staging_dir"] == str(tmp_path / "tmpdir" / task.id)
        assert (tmp_path / "tmpdir").is_dir()
    finally:
        mgr.stop(join_timeout=2)


def test_format_postprocess_posix(monkeypatch):
    monkeypatch.setattr(sys, "platform", "darwin")
    cmd = format_postprocess_command("echo {file}", "/tmp/my file.mp4")
    assert "'/tmp/my file.mp4'" in cmd


def test_format_postprocess_windows(monkeypatch):
    monkeypatch.setattr(sys, "platform", "win32")
    cmd = format_postprocess_command("echo {file}", r"C:\Users\a\my file.mp4")
    assert "my file.mp4" in cmd
    assert "'" not in cmd or '"' in cmd  # list2cmdline 用双引号


def test_script_postprocess_runs_after_completion(manager, monkeypatch):
    monkeypatch.setattr(sys, "platform", "darwin")
    task = _make_task()
    task.options.postprocessing = "script"
    task.options.postprocess_script = "process-video {file}"
    with patch("src.core.download_manager.subprocess.run") as mock_run:
        mock_run.return_value = MagicMock(returncode=0, stderr="")
        _run_one_task(manager, task, "/tmp/my file.mp4")
        assert _wait_until(lambda: mock_run.called)
    command = mock_run.call_args[0][0]
    expected = format_postprocess_command("process-video {file}", task.file_path)
    assert command == expected


def test_failed_script_postprocess_does_not_mark_output_ready(manager, monkeypatch):
    monkeypatch.setattr(sys, "platform", "darwin")
    task = _make_task()
    task.options.postprocessing = "script"
    task.options.postprocess_script = "process-video {file}"
    sink = MagicMock()
    manager.output_ready_sink = sink
    with patch("src.core.download_manager.subprocess.run") as mock_run:
        mock_run.return_value = MagicMock(returncode=7, stderr="postprocess failed")
        _run_one_task(manager, task, "/tmp/my file.mp4")
        assert _wait_until(lambda: mock_run.called)

    sink.mark_processing.assert_called_once()
    sink.mark_ready.assert_not_called()


@pytest.mark.parametrize("delivery_outcome", ["pending", "failed", "uncertain"])
def test_completed_download_is_enqueued_for_telegram_delivery(tmp_path, delivery_outcome):
    """真实下载管理器完成任务后，Telegram 队列应保存可发送的文件快照。"""
    HistoryDB._instance = None
    root = tmp_path / "telegram-handoff"
    root.mkdir()
    config = JsonConfig(str(root / "config.json"))
    config.configure_telegram(
        {
            "accountId": "42",
            "botUsername": "downany_bot",
            "targetChatId": "-100123",
            "targetChatType": "supergroup",
            "targetChatTitle": "测试群",
            "targetVerifiedAt": "2026-01-01T00:00:00Z",
            "autoSendEnabled": True,
        },
        now="2026-01-01T00:00:00Z",
    )
    db = HistoryDB(db_path=str(root / "history.db"))
    delivery_clock = ["2026-08-28T00:00:00Z"]
    delivery = TelegramDeliveryService(
        config,
        TelegramDeliveryStore(str(root / "history.db")),
        now=lambda: delivery_clock[0],
    )
    manager = DownloadManager(
        config=config,
        db=db,
        queue_store=QueueStore(str(root / "history.db")),
        temp_dir=str(root / "tmp"),
        output_ready_sink=delivery,
    )
    output = root / "clip.mp4"
    output.write_bytes(b"downloaded-bytes")
    task = DownloadTask(
        id="task-telegram-handoff",
        video_info=VideoInfo(
            url="https://example.com/clip.mp4",
            title="自动转发测试",
            platform=Platform.UNKNOWN,
        ),
        options=DownloadOptions(output_path=str(root / "downloads")),
    )

    def fake_download(_url, _plan, *, toolchain, staging_dir):
        return _download_result(downloader, staging_dir, str(output))

    try:
        manager.start()
        with patch("src.core.download_manager.Downloader") as downloader_cls, patch(
            "src.core.download_manager.VideoInfoExtractor.extract", return_value=None
        ):
            downloader = MagicMock()
            downloader.download.side_effect = fake_download
            downloader_cls.return_value = downloader
            manager.add_task(task)
            assert _wait_until(lambda: task.status == TaskStatus.COMPLETED)

        assert _wait_until(
            lambda: delivery.list_summaries(offset=0, limit=10, status="pending")["total"] == 1
        )
        page = delivery.list_summaries(offset=0, limit=10, status="pending")
        assert page["total"] == 1
        item = page["items"][0]
        assert item["taskId"] == task.id
        assert item["accountId"] == "42"
        assert item["targetChatId"] == "-100123"
        assert item["status"] == "pending"
        manager.stop(join_timeout=2)
        output_path = Path(task.file_path)
        output_hash = hashlib.sha256(output_path.read_bytes()).hexdigest()
        before_queue = manager.queue_store.load_tasks()
        before_history = db.get_download_record(task.id)
        before_snapshot = manager.get_snapshot()
        if delivery_outcome != "pending":
            delivery_clock[0] = "2026-08-28T00:00:01Z"
            claim = delivery.claim_next(account_id="42", now=delivery_clock[0], lease_id="delivery-lease",
                                        lease_expires_at="2026-08-28T00:01:00Z")
            assert claim is not None
            delivery.mark_sending(item["id"], "delivery-lease", delivery_clock[0], "video", False, True)
            settle = delivery.mark_failed if delivery_outcome == "failed" else delivery.mark_uncertain
            settled = settle(item["id"], "delivery-lease", "NETWORK_ERROR", "发送结果", "2026-08-28T00:00:02Z")
            assert settled["status"] == delivery_outcome
        delivery_clock[0] = "2026-08-28T00:00:03Z"
        restarted = TelegramDeliveryService(config, TelegramDeliveryStore(str(root / "history.db")),
                                             now=lambda: delivery_clock[0])
        restarted.recover_delivery_leases()
        restarted.recover_output_records()
        assert restarted.list_summaries(offset=0, limit=10, status=delivery_outcome)["total"] == 1
        if delivery_outcome != "pending":
            if delivery_outcome == "uncertain":
                with pytest.raises(DeliveryStateConflict, match="duplicate"):
                    asyncio.run(restarted.retry(item["id"], confirm_possible_duplicate=False,
                                                confirm_interrupted_output=False))
            retried = asyncio.run(restarted.retry(item["id"], confirm_possible_duplicate=delivery_outcome == "uncertain",
                                                  confirm_interrupted_output=False))
            assert retried["status"] == "pending"
            assert retried["taskId"] == task.id
        assert restarted.cancel_pending("42") == 1
        assert manager.queue_store.load_tasks() == before_queue
        assert db.get_download_record(task.id) == before_history
        assert manager.get_snapshot() == before_snapshot
        assert hashlib.sha256(output_path.read_bytes()).hexdigest() == output_hash
        assert len(list(output_path.parent.glob("*.mp4"))) == 1
        downloader.download.assert_called_once()
    finally:
        manager.stop(join_timeout=2)
        HistoryDB._instance = None


def test_telegram_store_failure_cannot_undo_a_verified_download(queue_download_harness, monkeypatch):
    harness = queue_download_harness
    manager = harness.manager()
    monkeypatch.setattr(HistoryDB, "_instance", None)
    manager.db = HistoryDB(db_path=manager.queue_store.db_path)
    manager.config.configure_telegram({
        "accountId": "42", "targetChatId": "-100123", "targetChatType": "supergroup",
        "targetChatTitle": "测试群", "targetVerifiedAt": "2026-01-01T00:00:00Z", "autoSendEnabled": True,
    }, now="2026-01-01T00:00:00Z")
    delivery_store = TelegramDeliveryStore(manager.queue_store.db_path)
    manager.output_ready_sink = TelegramDeliveryService(manager.config, delivery_store)
    with sqlite3.connect(manager.queue_store.db_path) as conn:
        conn.execute("CREATE TRIGGER fail_delivery BEFORE INSERT ON telegram_delivery_queue "
                     "BEGIN SELECT RAISE(ABORT, 'injected delivery storage failure'); END")
    task = harness.task(manager, "delivery-store-failure")
    manager.add_task(task)
    manager._download_task(task)
    assert task.status is TaskStatus.COMPLETED and task.progress == 100
    assert manager.queue_store.load_tasks()[0].status is TaskStatus.COMPLETED
    assert manager.db.get_download_record(task.id).status == "completed"
    assert Path(task.file_path).read_bytes() == b"local-media:" + task.id.encode()
    assert delivery_store.list_deliveries().total == 0


def test_priority_takes_precedence_over_queue_order():
    config = MagicMock()
    config.get_concurrent_downloads.return_value = 1
    mgr = DownloadManager(config=config, db=MagicMock())
    late = _make_task(url="https://example.com/late")
    early = _make_task(url="https://example.com/early")
    late.queue_order, early.queue_order = 5, 1
    late.priority, early.priority = 10, 0
    for task in (late, early):
        mgr.tasks[task.id] = task
    with mgr._lock:
        first = mgr._pick_next_pending_locked()
        assert first is not None and first.id == late.id


def test_reorder_tasks_updates_queue_order():
    config = MagicMock()
    config.get_concurrent_downloads.return_value = 1
    mgr = DownloadManager(config=config, db=MagicMock())
    a = _make_task(url="https://example.com/a")
    b = _make_task(url="https://example.com/b")
    c = _make_task(url="https://example.com/c")
    for idx, task in enumerate((a, b, c)):
        task.queue_order = idx
        mgr.tasks[task.id] = task
    mgr.reorder_tasks([c.id, a.id, b.id])
    assert a.queue_order == 1
    assert b.queue_order == 2
    assert c.queue_order == 0


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
        instance.download.side_effect = _result_side_effect(
            instance, "/tmp/真正的标题.mp4"
        )
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
        instance.last_ydl_info = None
        instance.download.side_effect = _result_side_effect(
            instance,
            "/tmp/hash.mp4",
            info={
                "title": info.title,
                "uploader": info.uploader,
                "duration": info.duration,
            },
        )
        mock_cls.return_value = instance
        manager.add_task(task)
        assert _wait_until(lambda: task.status == TaskStatus.COMPLETED)
    assert task.video_info.title == "推文正文标题"


def test_page_download_backfills_title_and_platform_from_ydl_info(manager):
    """扩展传入的临时标题不应挡住 yt-dlp 解析到的真实标题/平台。"""
    from src.core.download_task import Platform

    task = _make_task(
        url="https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        title="bridge-probe-fixed",
    )
    assert task.video_info.platform == Platform.UNKNOWN
    with patch("src.core.download_manager.Downloader") as mock_cls, patch(
        "src.core.download_manager.VideoInfoExtractor.extract", return_value=None
    ):
        instance = MagicMock()
        instance.last_info = None
        instance.last_ydl_info = {
            "title": "Rick Astley - Never Gonna Give You Up",
            "thumbnail": "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg",
            "uploader": "Rick Astley",
            "duration": 213,
        }
        instance.download.side_effect = _result_side_effect(
            instance,
            "/tmp/Rick Astley - Never Gonna Give You Up.mp4",
            info=instance.last_ydl_info,
        )
        mock_cls.return_value = instance
        manager.add_task(task)
        assert _wait_until(lambda: task.status == TaskStatus.COMPLETED)

    assert task.video_info.title == "Rick Astley - Never Gonna Give You Up"
    assert task.video_info.platform == Platform.YOUTUBE
    assert task.video_info.uploader == "Rick Astley"
    assert task.video_info.duration == 213
    assert "dQw4w9WgXcQ" in task.video_info.thumbnail_url


def test_page_task_with_title_still_prefills_missing_thumbnail(manager):
    """扩展已带标题但无封面时，仍应预拉 thumbnail（不覆盖标题）。"""
    from src.core.download_task import Platform

    task = _make_task(
        url="https://www.pornhub.com/view_video.php?viewkey=abc",
        title="页面标题已有",
    )
    task.video_info.platform = Platform.PORNHUB
    extracted = VideoInfo(
        url=task.video_info.url,
        title="yt-dlp 标题不应覆盖",
        thumbnail_url="https://pix-cdn77.phncdn.com/a.jpg",
        uploader="uploader",
        duration=12,
        platform=Platform.PORNHUB,
    )
    with patch("src.core.download_manager.Downloader") as mock_cls, patch(
        "src.core.download_manager.VideoInfoExtractor.extract",
        return_value=extracted,
    ) as mock_extract:
        instance = MagicMock()
        instance.last_info = None
        instance.last_ydl_info = None
        instance.download.side_effect = _result_side_effect(
            instance,
            "/tmp/out.mp4",
            info={"title": task.video_info.title},
        )
        mock_cls.return_value = instance
        manager.add_task(task)
        assert _wait_until(lambda: task.status == TaskStatus.COMPLETED)

    mock_extract.assert_called()
    assert task.video_info.title == "页面标题已有"
    assert task.video_info.thumbnail_url.endswith("a.jpg")


def test_xiaohongshu_cdn_uses_referer_page_for_thumbnail(manager):
    """小红书 CDN 直链：用 Referer 页面补封面/平台，但保留 CDN 下载 URL。"""
    from src.core.download_task import Platform

    task = _make_task(
        url="https://sns-video-bd.xhscdn.com/stream/abc.mp4",
        title="每天从这里醒来该有多快乐 - 小红书",
    )
    task.options.http_headers = {
        "Referer": "https://www.xiaohongshu.com/explore/6411cf99000000001300b6d9",
    }
    extracted = VideoInfo(
        url="https://www.xiaohongshu.com/explore/6411cf99000000001300b6d9",
        title="页面真实标题",
        thumbnail_url="https://sns-webpic-qc.xhscdn.com/cover.jpg",
        uploader="5c31698d0000000007018a31",
        platform=Platform.XIAOHONGSHU,
    )
    with patch("src.core.download_manager.Downloader") as mock_cls, patch(
        "src.core.download_manager.VideoInfoExtractor.extract",
        return_value=extracted,
    ) as mock_extract:
        instance = MagicMock()
        instance.last_info = None
        instance.last_ydl_info = None
        instance.download.side_effect = _result_side_effect(
            instance,
            "/tmp/xhs.mp4",
            info={"title": task.video_info.title},
        )
        mock_cls.return_value = instance
        manager.add_task(task)
        assert _wait_until(lambda: task.status == TaskStatus.COMPLETED)

    mock_extract.assert_called()
    assert mock_extract.call_args.args[0].startswith(
        "https://www.xiaohongshu.com/explore/"
    )
    assert task.video_info.url.startswith("https://sns-video-bd.xhscdn.com/")
    assert task.video_info.thumbnail_url.endswith("cover.jpg")
    assert task.video_info.platform == Platform.XIAOHONGSHU
    assert task.video_info.title == "每天从这里醒来该有多快乐 - 小红书"


def test_instagram_weak_title_backfilled_from_description(manager):
    """Instagram 的 Video by / 站点名标题应被 description 文案替换。"""
    from src.core.download_task import Platform

    task = _make_task(
        url="https://www.instagram.com/reels/DbC-8YmTgQt/",
        title="Instagram",
    )
    task.video_info.platform = Platform.INSTAGRAM
    with patch("src.core.download_manager.Downloader") as mock_cls, patch(
        "src.core.download_manager.VideoInfoExtractor.extract", return_value=None
    ):
        instance = MagicMock()
        instance.last_info = None
        instance.last_ydl_info = {
            "title": "Video by goutouluoli_",
            "description": "今日份小狗 #cute\n第二行",
            "uploader": "goutouluoli_",
            "thumbnail": "https://example.com/t.jpg",
        }
        instance.download.side_effect = _result_side_effect(
            instance,
            "/tmp/ig.mp4",
            info=instance.last_ydl_info,
        )
        mock_cls.return_value = instance
        manager.add_task(task)
        assert _wait_until(lambda: task.status == TaskStatus.COMPLETED)

    assert task.video_info.title == "今日份小狗 #cute"


def test_failure_sets_structured_error_code(manager):
    task = _make_task()
    with patch("src.core.download_manager.Downloader") as mock_cls, patch(
        "src.core.download_manager.VideoInfoExtractor.extract", return_value=None
    ):
        instance = MagicMock()
        instance.download.side_effect = DownloadError("Sign in to confirm your age")
        mock_cls.return_value = instance
        manager.add_task(task)
        assert _wait_until(lambda: task.status == TaskStatus.FAILED)
    assert task.error_code == ec.NEED_LOGIN


@pytest.mark.parametrize(
    "latest_proxy,latest_browser",
    [
        ("http://127.0.0.1:9000", "chrome"),
        (None, ""),
    ],
)
def test_retry_refreshes_current_recovery_settings(latest_proxy, latest_browser):
    config = MagicMock()
    config.build_download_options.return_value = DownloadOptions(
        output_path="/ignored",
        quality="best",
        proxy=latest_proxy,
        cookies_from_browser=latest_browser,
    )
    retry_manager = DownloadManager(config=config, db=MagicMock())
    task = DownloadTask(
        video_info=VideoInfo(url="https://example.com/login-required", title="login"),
        options=DownloadOptions(
            output_path="/chosen",
            quality="720p",
            proxy="http://127.0.0.1:8000",
            cookies_from_browser="firefox",
            cookiefile="/chosen/cookies.txt",
        ),
        status=TaskStatus.FAILED,
        error_message="Sign in to continue",
        error_code=ec.NEED_LOGIN,
    )
    retry_manager.tasks[task.id] = task

    retry_manager.retry_task(task.id)

    assert task.status == TaskStatus.PENDING
    assert task.options.proxy == latest_proxy
    assert task.options.cookies_from_browser == latest_browser
    assert task.options.cookiefile == "/chosen/cookies.txt"
    assert task.options.output_path == "/chosen"
    assert task.options.quality == "720p"


def test_embed_metadata_and_m2_opts_passed_to_ytdlp(manager):
    task = _make_task()
    task.options.embed_metadata = True
    task.options.subtitle_langs = "en,zh-Hans"
    task.options.embed_subs = True
    task.options.concurrent_fragments = 8
    task.options.download_sections = "*10:00-12:00"
    task.options.sponsorblock_remove = "sponsor,intro"
    task.options.cookies_from_browser = "chrome"
    opts = _run_one_task(manager, task)
    assert opts["writethumbnail"] is True
    assert opts["subtitleslangs"] == ("en", "zh-Hans")
    assert opts["concurrent_fragment_downloads"] == 8
    assert "download_sections" not in opts
    assert "sponsorblock_remove" not in opts
    assert opts["cookiesfrombrowser"] == ("chrome",)
    assert [item["key"] for item in opts["postprocessors"]] == [
        "FFmpegVideoRemuxer",
        "FFmpegEmbedSubtitle",
        "FFmpegMetadata",
        "EmbedThumbnail",
    ]


def test_download_subtitles_without_langs_keeps_legacy_behavior(manager):
    task = _make_task()
    task.options.download_subtitles = True
    task.options.subtitle_langs = ""
    opts = _run_one_task(manager, task)
    assert opts["writesubtitles"] is True
    assert opts["writeautomaticsub"] is True
    assert "subtitleslangs" not in opts


def test_concurrent_fragments_zero_omits_option(manager):
    task = _make_task()
    task.options.concurrent_fragments = 0
    opts = _run_one_task(manager, task)
    assert "concurrent_fragment_downloads" not in opts


def test_remove_group_force_and_optional_files(tmp_path):
    config = MagicMock()
    config.get_concurrent_downloads.return_value = 1
    mgr = DownloadManager(config=config, db=MagicMock())
    file_a = tmp_path / "合集名" / "001 - a.mp4"
    file_b = tmp_path / "合集名" / "002 - b.mp4"
    file_a.parent.mkdir(parents=True)
    file_a.write_text("a")
    file_b.write_text("b")

    t1 = _make_task(url="https://example.com/1", title="a")
    t1.group_id = "g1"
    t1.group_title = "合集名"
    t1.status = TaskStatus.COMPLETED
    t1.file_path = str(file_a)
    t2 = _make_task(url="https://example.com/2", title="b")
    t2.group_id = "g1"
    t2.group_title = "合集名"
    t2.status = TaskStatus.PENDING
    t2.file_path = str(file_b)
    with mgr._lock:
        mgr.tasks[t1.id] = t1
        mgr.tasks[t2.id] = t2

    # 默认不删文件也能强制清队列（含 pending）
    removed = mgr.remove_group("g1", delete_files=False)
    assert set(removed.removed) == {t1.id, t2.id}
    assert removed.file_delete_failures == ()
    assert mgr.get_all_tasks() == {}
    assert file_a.is_file() and file_b.is_file()

    t3 = _make_task(url="https://example.com/3", title="c")
    t3.group_id = "g2"
    t3.status = TaskStatus.COMPLETED
    t3.file_path = str(file_a)
    with mgr._lock:
        mgr.tasks[t3.id] = t3
    removed = mgr.remove_group("g2", delete_files=True)
    assert removed.removed == (t3.id,)
    assert removed.file_delete_failures == ()
    assert not file_a.exists()
    assert file_b.is_file()


def test_restore_same_database_preserves_outputs_and_group_delete_scope(tmp_path):
    database_path = tmp_path / "queue.db"
    download_root = tmp_path / "downloads"
    group_dir = download_root / "合集"
    group_dir.mkdir(parents=True)
    grouped_file = group_dir / "002 - 第二集.mp4"
    grouped_file.write_bytes(b"grouped-output")
    ordinary_file = download_root / "普通视频.mp4"
    ordinary_file.write_bytes(b"ordinary-output")
    unrelated_file = group_dir / "手动保存的说明.txt"
    unrelated_file.write_bytes(b"keep-me")

    downloading = _make_task(
        url="https://example.com/playlist/1",
        title="第一集",
    )
    downloading.status = TaskStatus.DOWNLOADING
    downloading.group_id = "group-one"
    downloading.group_title = "合集"
    downloading.playlist_index = 1
    downloading.completion_note = "字幕已保存为独立文件"

    grouped_completed = _make_task(
        url="https://example.com/playlist/2",
        title="第二集",
    )
    grouped_completed.status = TaskStatus.COMPLETED
    grouped_completed.progress = 100
    grouped_completed.group_id = "group-one"
    grouped_completed.group_title = "合集"
    grouped_completed.playlist_index = 2
    grouped_completed.file_path = str(grouped_file)

    ordinary_completed = _make_task(
        url="https://example.com/ordinary",
        title="普通视频",
    )
    ordinary_completed.status = TaskStatus.COMPLETED
    ordinary_completed.progress = 100
    ordinary_completed.file_path = str(ordinary_file)

    store = QueueStore(str(database_path))
    for task in (downloading, grouped_completed, ordinary_completed):
        store.upsert_task(task)

    def snapshot(path):
        stat = path.stat()
        return (
            path.name,
            path.parent,
            stat.st_size,
            stat.st_mtime_ns,
            path.read_bytes(),
        )

    before = {
        path: snapshot(path)
        for path in (grouped_file, ordinary_file, unrelated_file)
    }
    config = MagicMock()
    config.get_concurrent_downloads.return_value = 1

    first = DownloadManager(
        config=config,
        db=MagicMock(),
        queue_store=QueueStore(str(database_path)),
    )
    first.restore_tasks()
    first_restored = first.get_all_tasks()
    assert first_restored[downloading.id].status == TaskStatus.PENDING
    assert first_restored[grouped_completed.id].status == TaskStatus.COMPLETED

    second = DownloadManager(
        config=config,
        db=MagicMock(),
        queue_store=QueueStore(str(database_path)),
    )
    second.restore_tasks()
    restored = second.get_all_tasks()

    assert restored[downloading.id].status == TaskStatus.PENDING
    assert restored[downloading.id].group_id == "group-one"
    assert restored[downloading.id].group_title == "合集"
    assert restored[downloading.id].playlist_index == 1
    assert restored[downloading.id].completion_note == "字幕已保存为独立文件"
    assert restored[grouped_completed.id].status == TaskStatus.COMPLETED
    assert restored[grouped_completed.id].group_id == "group-one"
    assert restored[grouped_completed.id].group_title == "合集"
    assert restored[grouped_completed.id].playlist_index == 2
    assert restored[grouped_completed.id].file_path == str(grouped_file)
    assert restored[ordinary_completed.id].status == TaskStatus.COMPLETED
    assert restored[ordinary_completed.id].group_id == ""
    assert restored[ordinary_completed.id].file_path == str(ordinary_file)
    assert {
        path: snapshot(path)
        for path in (grouped_file, ordinary_file, unrelated_file)
    } == before

    removed = second.remove_group("group-one", delete_files=True)

    assert set(removed.removed) == {downloading.id, grouped_completed.id}
    assert removed.file_delete_failures == ()
    assert not grouped_file.exists()
    assert ordinary_file.is_file()
    assert unrelated_file.is_file()
    assert snapshot(ordinary_file) == before[ordinary_file]
    assert snapshot(unrelated_file) == before[unrelated_file]
    remaining = QueueStore(str(database_path)).load_tasks()
    assert [task.id for task in remaining] == [ordinary_completed.id]


def test_pending_pause_prevents_scheduler_start(tmp_path):
    config = MagicMock()
    config.get_concurrent_downloads.return_value = 1
    manager = DownloadManager(config=config, db=MagicMock(), queue_store=QueueStore(str(tmp_path / "q.db")))
    task = _make_task(url="https://example.com/video.mp4")
    entered = threading.Event()

    def unexpected_download(*_args, **_kwargs):
        entered.set()
        raise DownloadError("unexpected worker start")

    with patch("src.core.download_manager.Downloader") as factory, patch(
        "src.core.download_manager.VideoInfoExtractor.extract", return_value=None,
    ):
        factory.return_value.download.side_effect = unexpected_download
        manager.add_task(task)
        manager.pause_task(task.id)
        manager.start()
        try:
            assert not entered.wait(0.75)
            assert task.status is TaskStatus.PAUSED
            assert task.run_intent is TaskRunIntent.PAUSE
            assert not manager.active_tasks
        finally:
            manager.stop(join_timeout=2)


@pytest.mark.parametrize("first_action,next_action", [(TaskAction.PAUSE, TaskAction.RESUME), (TaskAction.CANCEL, TaskAction.RETRY)])
def test_requested_restart_waits_for_the_old_worker_and_is_durable(tmp_path, first_action, next_action):
    config = MagicMock()
    config.get_concurrent_downloads.return_value = 2
    config.build_download_options.return_value = DownloadOptions()
    store = QueueStore(str(tmp_path / "queue.db"))
    manager = DownloadManager(config=config, db=MagicMock(), queue_store=store, temp_dir=str(tmp_path / "staging"))
    task = _make_task(url="https://example.com/video.mp4")
    entered, release = threading.Event(), threading.Event()
    starts = []

    with patch("src.core.download_manager.Downloader") as factory, patch(
        "src.core.download_manager.VideoInfoExtractor.extract", return_value=None,
    ):
        instance = MagicMock()
        factory.return_value = instance

        def download(_url, _plan, *, toolchain, staging_dir):
            starts.append(threading.get_ident())
            if len(starts) == 1:
                entered.set()
                if not release.wait(5):
                    raise AssertionError("test worker was not released")
                raise DownloadCancelled("interrupted by user")
            return _download_result(instance, staging_dir, "/tmp/resumed.mp4")

        instance.download.side_effect = download
        manager.add_task(task)
        manager.start()
        try:
            assert entered.wait(2)
            manager.apply_task_action(task.id, first_action)
            result = manager.apply_task_action(task.id, next_action)
            assert result.outcome is TaskActionOutcome.DEFERRED
            assert (task.status, task.run_intent) == (TaskStatus.PAUSED, TaskRunIntent.RUN)
            persisted = store.load_tasks()[0]
            assert (persisted.status, persisted.run_intent) == (TaskStatus.PAUSED, TaskRunIntent.RUN)
            assert len(starts) == 1 and len(manager.active_tasks) == 1
            release.set()
            assert _wait_until(lambda: task.status is TaskStatus.COMPLETED)
            assert _wait_until(lambda: task.id not in manager.active_tasks)
            assert len(starts) == 2
            assert len(store.load_tasks()) == 1
            assert store.load_tasks()[0].status is TaskStatus.COMPLETED
            assert len(list(Path(task.options.output_path).glob("*.mp4"))) == 1
        finally:
            release.set()
            manager.stop(join_timeout=2)
