"""Credentials never cross into Python; transient media URLs never become durable."""
from dataclasses import asdict
from pathlib import Path
from unittest.mock import Mock, patch
import pytest
from src.core.download_manager import DownloadManager, QueueMutationError
from src.core.download_task import DownloadTask, DownloadOptions, TaskStatus, VideoInfo
from src.core.downloader import Downloader, DownloadError
from src.core.output_contract import compile_output_plan
from src.data.queue_store import QueueStore
from tests.core.test_downloader import FakeYDLFactory, _toolchain
ORIGINAL = "https://www.douyin.com/video/123"
MEDIA = "https://v26-web.douyinvod.com/video.mp4?token=runtime-only"

def make_manager(tmp_path, queue=None):
    config = Mock(); config.build_download_options.return_value = DownloadOptions(cookies_from_browser="chrome")
    manager = DownloadManager(config=config, db=Mock(), queue_store=queue, temp_dir=str(tmp_path))
    task = DownloadTask(id="test-123", video_info=VideoInfo(url=ORIGINAL), status=TaskStatus.FAILED, options=DownloadOptions(quality="720p", output_path=str(tmp_path), http_headers={"Cookie": "old-secret"}, cookiefile="private", cookies_from_browser="chrome"))
    manager.tasks[task.id] = task
    return manager, task

def test_retry_preserves_identity_quality_directory_and_drops_credentials(tmp_path):
    manager, task = make_manager(tmp_path)
    manager.retry_embedded_douyin(task.id, ORIGINAL, MEDIA, "作品名称")
    assert task.status == TaskStatus.PENDING and task.video_info.url == ORIGINAL
    assert task.video_info.title == "作品名称" and task.video_info.media_title_verified
    assert task.options.quality == "720p" and task.options.output_path == str(tmp_path)
    assert not task.options.http_headers and not task.options.cookiefile and not task.options.cookies_from_browser
    assert task.embedded_media_url == MEDIA and task.requires_embedded_session
    assert MEDIA not in str(task.to_dict()) + str(asdict(task.to_snapshot())) + repr(task)

def test_queue_round_trip_excludes_runtime_url(tmp_path):
    store = QueueStore(str(tmp_path / "queue.db")); manager, task = make_manager(tmp_path, store)
    manager.retry_embedded_douyin(task.id, ORIGINAL, MEDIA, "作品名称")
    restored = store.load_tasks()[0]
    assert restored.requires_embedded_session and not restored.embedded_media_url
    assert MEDIA.encode() not in (tmp_path / "queue.db").read_bytes()
    assert b"old-secret" not in (tmp_path / "queue.db").read_bytes()

@pytest.mark.parametrize("action", ["pause_task", "cancel_task"])
def test_pause_cancel_release_pending_runtime_url(tmp_path, action):
    manager, task = make_manager(tmp_path); manager.retry_embedded_douyin(task.id, ORIGINAL, MEDIA, "作品名称")
    getattr(manager, action)(task.id); assert not task.embedded_media_url

def test_stop_releases_runtime_url(tmp_path):
    manager, task = make_manager(tmp_path); manager.retry_embedded_douyin(task.id, ORIGINAL, MEDIA, "作品名称")
    manager.stop(); assert not task.embedded_media_url

def test_restart_requires_explicit_session_retry_and_never_requests_original_anonymously(tmp_path):
    manager, task = make_manager(tmp_path); task.requires_embedded_session = True; task.status = TaskStatus.PENDING
    with patch("src.core.download_manager.Downloader") as download, patch("src.core.download_manager.VideoInfoExtractor.extract") as extract:
        manager._download_task(task)
    assert task.status == TaskStatus.FAILED and task.error_code == "embedded_session_required"
    download.assert_not_called(); extract.assert_not_called()

def test_persistence_failure_rolls_back_runtime_and_options(tmp_path):
    queue = Mock(); queue.upsert_tasks.side_effect = RuntimeError("disk full")
    manager, task = make_manager(tmp_path, queue)
    with pytest.raises(QueueMutationError): manager.retry_embedded_douyin(task.id, ORIGINAL, MEDIA, "作品名称")
    assert task.status == TaskStatus.FAILED and not task.requires_embedded_session and not task.embedded_media_url
    assert task.options.cookies_from_browser == "chrome"

@pytest.mark.parametrize("original,media", [("https://evil.com/video/123", MEDIA), (ORIGINAL, "https://evil.com/a"), (ORIGINAL, "https://sid:secret@v26-web.douyinvod.com/a")])
def test_sidecar_revalidates_domains(tmp_path, original, media):
    manager, task = make_manager(tmp_path)
    with pytest.raises(ValueError): manager.retry_embedded_douyin(task.id, original, media, "作品名称")
    assert task.status == TaskStatus.FAILED and not task.embedded_media_url

def test_ephemeral_download_strips_credentials_cache_and_raw_errors(tmp_path, caplog):
    task = DownloadTask(video_info=VideoInfo(url=ORIGINAL), options=DownloadOptions(output_path=str(tmp_path), embed_metadata=False, http_headers={"Cookie": "secret"}, cookies_from_browser="chrome", cookiefile="private"))
    plan = compile_output_plan(task); factory = FakeYDLFactory(RuntimeError(MEDIA + " Cookie=secret")); downloader = Downloader(ydl_factory=factory)
    errors = []; downloader.set_callbacks(error=errors.append)
    with pytest.raises(DownloadError) as failure:
        downloader.download(MEDIA, plan, toolchain=_toolchain(tmp_path), staging_dir=tmp_path, preferred_title="作品名称", ephemeral_source_url=ORIGINAL)
    opts = factory.option_snapshots[0]
    assert not opts.get("cookiesfrombrowser") and not opts.get("cookiefile") and "Cookie" not in opts["http_headers"]
    assert opts["cachedir"] is False and opts["writeinfojson"] is False
    for method in ("debug", "info", "warning", "error"): getattr(opts["logger"], method)(MEDIA + " Cookie=secret")
    assert MEDIA not in caplog.text + str(failure.value) + str(errors)
    assert "Cookie=secret" not in caplog.text + str(failure.value) + str(errors)
