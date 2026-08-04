"""DownloadManager 状态机与并发安全测试（Qt 无关）。"""
import threading
import time
from unittest.mock import MagicMock, patch

import pytest

from src.core.download_manager import DownloadManager
from src.core.download_task import DownloadOptions, DownloadTask, TaskStatus, VideoInfo
from src.core.downloader import DownloadCancelled, DownloadError
from src.core import error_codes as ec


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
    assert task.error_code == ec.UNKNOWN
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


def test_playlist_group_uses_subfolder_outtmpl(manager):
    task = _make_task(url="https://www.youtube.com/watch?v=abc", title="第一集")
    task.group_id = "g1"
    task.group_title = "我的播放列表"
    task.playlist_index = 5
    opts = _run_one_task(manager, task)
    outtmpl = opts["outtmpl"]
    assert outtmpl.endswith("005 - %(title)s.%(ext)s")
    assert "我的播放列表" in outtmpl


def test_temp_dir_sets_paths_temp(tmp_path):
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
        assert opts["paths"]["temp"] == str(tmp_path / "tmpdir")
        assert (tmp_path / "tmpdir").is_dir()
    finally:
        mgr.stop(join_timeout=2)


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


def test_queue_order_picks_lower_first():
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
        assert first is not None and first.id == early.id


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
        instance.last_ydl_info = None
        instance.download.return_value = "/tmp/hash.mp4"
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
        instance.download.return_value = (
            "/tmp/Rick Astley - Never Gonna Give You Up.mp4"
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
        instance.download.return_value = "/tmp/out.mp4"
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
        instance.download.return_value = "/tmp/xhs.mp4"
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
        instance.download.return_value = "/tmp/ig.mp4"
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
    assert opts["embedmetadata"] is True
    assert opts["subtitleslangs"] == ["en", "zh-Hans"]
    assert opts["embedsubtitles"] == ["en", "zh-Hans"]
    assert opts["concurrent_fragment_downloads"] == 8
    assert opts["download_sections"] == "*10:00-12:00"
    assert opts["sponsorblock_remove"] == ["sponsor", "intro"]
    assert opts["cookiesfrombrowser"] == ("chrome",)


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
    assert set(removed) == {t1.id, t2.id}
    assert mgr.get_all_tasks() == {}
    assert file_a.is_file() and file_b.is_file()

    t3 = _make_task(url="https://example.com/3", title="c")
    t3.group_id = "g2"
    t3.status = TaskStatus.COMPLETED
    t3.file_path = str(file_a)
    with mgr._lock:
        mgr.tasks[t3.id] = t3
    removed = mgr.remove_group("g2", delete_files=True)
    assert removed == [t3.id]
    assert not file_a.exists()
    assert file_b.is_file()
