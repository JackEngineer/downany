from src.core.download_task import DownloadOptions
from src.sidecar.handlers import _build_item_options


def test_extension_media_does_not_read_external_browser_session():
    base = DownloadOptions(cookies_from_browser="chrome", cookiefile="/private/session", embed_metadata=True)
    opts = _build_item_options(base, {"browser_extension": True, "direct_media": True})
    assert opts.cookies_from_browser == opts.cookiefile == ""
    assert opts.browser_extension and opts.direct_media and not opts.embed_metadata
    assert base.cookies_from_browser == "chrome"


def test_regular_task_keeps_existing_browser_preference():
    opts = _build_item_options(DownloadOptions(cookies_from_browser="chrome"), {})
    assert opts.cookies_from_browser == "chrome"
    assert not opts.browser_extension


def test_extension_flags_survive_restart_and_retry(tmp_path):
    from types import SimpleNamespace
    from src.core.download_manager import DownloadManager
    from src.core.download_task import DownloadTask, VideoInfo
    from src.data.queue_store import QueueStore

    task = DownloadTask(video_info=VideoInfo(url="https://cdn.example/v.mp4?signature=exact", title="clip"), options=DownloadOptions(browser_extension=True, direct_media=True, audio_only=True, quality="720p"))
    store = QueueStore(str(tmp_path / "queue.db"))
    store.upsert_task(task)
    restored = store.load_tasks()[0]
    assert restored.options.browser_extension and restored.options.direct_media
    assert restored.options.audio_only and restored.options.quality == "720p"
    manager = object.__new__(DownloadManager)
    manager.config = SimpleNamespace(build_download_options=lambda **kwargs: DownloadOptions(cookies_from_browser="chrome", cookiefile="/private/session"))
    manager._refresh_retry_recovery_options(restored)
    assert restored.options.cookies_from_browser == restored.options.cookiefile == ""
    assert restored.video_info.url.endswith("?signature=exact")
    assert restored.options.audio_only and restored.options.quality == "720p"


def test_legacy_extension_retry_drops_external_session(monkeypatch):
    from types import SimpleNamespace
    from src.sidecar import handlers
    from src.core.download_task import DownloadTask, VideoInfo, TaskStatus
    task = DownloadTask(video_info=VideoInfo(url="https://example.com/video", title="clip"), options=DownloadOptions(cookies_from_browser="chrome", cookiefile="/private/session"))
    task.status = TaskStatus.FAILED
    ctx = SimpleNamespace(manager=SimpleNamespace(get_task=lambda task_id: task))
    monkeypatch.setattr(handlers, "_single_action", lambda *args: {"ok": True})
    assert handlers._retry(ctx, {"taskId": task.id, "browser_extension": True})["ok"]
    assert task.options.browser_extension
    assert task.options.cookies_from_browser == task.options.cookiefile == ""
    assert task.video_info.url == "https://example.com/video"


def test_extension_output_selection_overrides_global_audio_preference():
    base = DownloadOptions(audio_only=True, postprocessing="mp3", quality="480p", cookies_from_browser="chrome")
    video = _build_item_options(base, {"browser_extension":True,"audio_only":False,"quality":"720p"})
    assert not video.audio_only and video.quality == "720p" and video.postprocessing == "none"
    assert not video.cookies_from_browser
    audio = _build_item_options(base, {"browser_extension":True,"direct_media":True,"audio_only":True,"quality":"best"})
    assert audio.audio_only and audio.direct_media and audio.quality == "best"
    assert base.audio_only and base.quality == "480p" and base.cookies_from_browser == "chrome"
