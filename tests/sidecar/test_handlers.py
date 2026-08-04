"""Sidecar method handlers 行为测试。"""
import types

import pytest

from src.core.download_manager import DownloadManager
from src.core.download_task import DownloadTask, Platform, TaskStatus, VideoInfo
from src.data.database import HistoryDB
from src.data.json_config import JsonConfig
from src.data.queue_store import QueueStore
from src.sidecar.handlers import HandlerContext, HandlerError, dispatch
from src.sidecar.paths import AppPaths
from src.sidecar.protocol import ErrorCode, Method


def _ctx(tmp_path):
    HistoryDB._instance = None
    paths = AppPaths(data_dir=tmp_path / "data", log_dir=tmp_path / "logs").ensure()
    cfg = JsonConfig(str(paths.config_path))
    db = HistoryDB(db_path=str(paths.history_db_path))
    store = QueueStore(str(paths.history_db_path))
    manager = DownloadManager(config=cfg, db=db, queue_store=store)
    events = []
    ctx = HandlerContext(
        config=cfg,
        db=db,
        manager=manager,
        emit_event=lambda name, payload: events.append((name, payload)),
        paths=paths,
    )
    return ctx, events


def test_ping(tmp_path):
    ctx, _ = _ctx(tmp_path)
    assert dispatch(ctx, Method.APP_PING.value, {}) == {"ok": True}


def test_settings_roundtrip(tmp_path):
    ctx, events = _ctx(tmp_path)
    updated = dispatch(
        ctx,
        Method.SETTINGS_UPDATE.value,
        {"concurrent_downloads": 4, "theme_mode": "dark"},
    )
    assert updated["concurrent_downloads"] == 4
    assert updated["theme_mode"] == "dark"
    assert dispatch(ctx, Method.SETTINGS_GET.value, {})["theme_mode"] == "dark"
    assert events[-1][0] == "settings.changed"


def test_get_snapshot_and_create_tasks(tmp_path):
    ctx, _ = _ctx(tmp_path)
    result = dispatch(
        ctx,
        Method.DOWNLOAD_CREATE_TASKS.value,
        {"urls": ["https://example.com/a", "https://example.com/b"]},
    )
    assert len(result["taskIds"]) == 2
    snap = dispatch(ctx, Method.APP_GET_SNAPSHOT.value, {})
    assert len(snap["tasks"]) == 2
    assert "settings" in snap


def test_create_tasks_accepts_playlist_group_fields(tmp_path):
    ctx, _ = _ctx(tmp_path)
    result = dispatch(
        ctx,
        Method.DOWNLOAD_CREATE_TASKS.value,
        {
            "urls": [
                "https://www.youtube.com/watch?v=a1",
                "https://www.youtube.com/watch?v=a2",
            ],
            "items": [
                {
                    "url": "https://www.youtube.com/watch?v=a1",
                    "title": "第一集",
                    "group_id": "g-pl",
                    "group_title": "周末合集",
                    "playlist_index": 1,
                },
                {
                    "url": "https://www.youtube.com/watch?v=a2",
                    "title": "第二集",
                    "group_id": "g-pl",
                    "group_title": "周末合集",
                    "playlist_index": 2,
                },
            ],
        },
    )
    assert len(result["taskIds"]) == 2
    snap = dispatch(ctx, Method.APP_GET_SNAPSHOT.value, {})
    tasks = {t["url"]: t for t in snap["tasks"]}
    assert tasks["https://www.youtube.com/watch?v=a1"]["group_id"] == "g-pl"
    assert tasks["https://www.youtube.com/watch?v=a1"]["group_title"] == "周末合集"
    assert tasks["https://www.youtube.com/watch?v=a1"]["playlist_index"] == 1
    assert tasks["https://www.youtube.com/watch?v=a2"]["playlist_index"] == 2


def test_create_tasks_auto_expands_playlist_url(tmp_path, monkeypatch):
    from src.core.download_task import Platform, VideoInfo
    from src.core.url_parser import ParseResult
    import src.sidecar.handlers as handlers

    class FakeSession:
        def __init__(self, url, proxy=None, timeout=30.0, *, allow_playlist=False):
            self.url = url
            self.allow_playlist = allow_playlist

        def run(self):
            assert self.allow_playlist is True
            return ParseResult(
                info=VideoInfo(
                    url=self.url,
                    title="測試合集",
                    platform=Platform.YOUTUBE,
                ),
                entries=[
                    {"id": "a1", "title": "第一集", "url": "https://www.youtube.com/watch?v=a1", "index": "1"},
                    {"id": "a2", "title": "", "url": "https://www.youtube.com/watch?v=5Bq0nj2RVu0", "index": "2"},
                    {"id": "a3", "title": "第三集", "url": "https://www.youtube.com/watch?v=a3", "index": "3"},
                ],
                playlist={"id": "PLxxx", "title": "測試合集", "count": 3},
            )

    monkeypatch.setattr(handlers, "ParseSession", FakeSession)
    ctx, _ = _ctx(tmp_path)
    playlist = "https://www.youtube.com/playlist?list=PLxxx"
    result = dispatch(
        ctx,
        Method.DOWNLOAD_CREATE_TASKS.value,
        {"urls": [playlist]},
    )
    assert len(result["taskIds"]) == 3
    snap = dispatch(ctx, Method.APP_GET_SNAPSHOT.value, {})
    tasks = snap["tasks"]
    assert len(tasks) == 3
    assert all(t["group_id"] for t in tasks)
    assert all(t["group_title"] == "測試合集" for t in tasks)
    assert {t["playlist_index"] for t in tasks} == {1, 2, 3}
    untitled = next(t for t in tasks if "5Bq0nj2RVu0" in t["url"])
    assert untitled["title"] == "a2"


def test_create_tasks_skips_expand_when_client_already_grouped(tmp_path, monkeypatch):
    import src.sidecar.handlers as handlers

    def boom(*_a, **_k):
        raise AssertionError("should not expand already-grouped items")

    monkeypatch.setattr(handlers, "ParseSession", boom)
    ctx, _ = _ctx(tmp_path)
    playlist = "https://www.youtube.com/playlist?list=PLxxx"
    result = dispatch(
        ctx,
        Method.DOWNLOAD_CREATE_TASKS.value,
        {
            "urls": [playlist],
            "items": [
                {
                    "url": playlist,
                    "title": "整表",
                    "group_id": "g-keep",
                    "group_title": "保留",
                    "playlist_index": 1,
                }
            ],
        },
    )
    assert len(result["taskIds"]) == 1
    task = ctx.manager.get_task(result["taskIds"][0])
    assert task.group_id == "g-keep"
    assert task.video_info.url == playlist


def test_create_tasks_normalizes_douyin_modal_id(tmp_path):
    ctx, _ = _ctx(tmp_path)
    jingxuan = "https://www.douyin.com/jingxuan?modal_id=7661234567890123456"
    result = dispatch(
        ctx,
        Method.DOWNLOAD_CREATE_TASKS.value,
        {
            "urls": [jingxuan],
            "items": [
                {
                    "url": jingxuan,
                    "title": "抖音精选视频",
                    "headers": {"Referer": jingxuan, "Cookie": "ttwid=1"},
                }
            ],
        },
    )
    assert len(result["taskIds"]) == 1
    task = ctx.manager.get_task(result["taskIds"][0])
    assert task is not None
    assert task.video_info.url == "https://www.douyin.com/video/7661234567890123456"
    assert task.video_info.title == "抖音精选视频"
    assert task.options.http_headers["Cookie"] == "ttwid=1"

    ctx, _ = _ctx(tmp_path)
    result = dispatch(
        ctx,
        Method.DOWNLOAD_CREATE_TASKS.value,
        {
            "urls": ["https://cdn.example/v.m3u8"],
            "items": [
                {
                    "url": "https://cdn.example/v.m3u8",
                    "title": "带请求头的视频",
                    "headers": {
                        "Referer": "https://example.com/watch",
                        "Cookie": "sid=abc",
                    },
                }
            ],
        },
    )
    assert len(result["taskIds"]) == 1
    task = ctx.manager.get_task(result["taskIds"][0])
    assert task is not None
    assert task.video_info.title == "带请求头的视频"
    assert task.options.http_headers == {
        "Referer": "https://example.com/watch",
        "Cookie": "sid=abc",
    }

def test_shutdown_sets_flag(tmp_path):
    ctx, _ = _ctx(tmp_path)
    assert dispatch(ctx, Method.APP_SHUTDOWN.value, {}) == {"ok": True}
    assert ctx.shutdown_requested is True


def test_run_migration_via_handler(tmp_path):
    ctx, _ = _ctx(tmp_path)
    result = dispatch(ctx, Method.APP_RUN_MIGRATION.value, {})
    assert result["status"] in {"skipped", "migrated", "failed"}
    again = dispatch(ctx, Method.APP_RUN_MIGRATION.value, {})
    assert again["status"] == "skipped"


def test_check_ytdlp_handler(tmp_path, monkeypatch):
    ctx, _ = _ctx(tmp_path)

    def fake_check(_paths):
        return {
            "currentVersion": "1.0.0",
            "latestVersion": "2.0.0",
            "updateAvailable": True,
            "downloadUrl": "https://example.com/yt-dlp",
        }

    monkeypatch.setattr("src.sidecar.ytdlp_updater.check_update", fake_check)
    result = dispatch(ctx, Method.UPDATER_CHECK_YTDLP.value, {})
    assert result["updateAvailable"] is True


def test_unknown_method(tmp_path):
    ctx, _ = _ctx(tmp_path)
    with pytest.raises(HandlerError) as exc_info:
        dispatch(ctx, "no.such", {})
    assert exc_info.value.code == ErrorCode.METHOD_NOT_FOUND


class _InlineThread:
    """同步执行 target 的 Thread 替身，让异步 worker 在测试内可断言。"""

    def __init__(self, target=None, daemon=None, **_kwargs):
        self._target = target

    def start(self):
        if self._target is not None:
            self._target()


def _inline_threads(monkeypatch):
    monkeypatch.setattr(
        "src.sidecar.handlers.threading", types.SimpleNamespace(Thread=_InlineThread)
    )


def test_search_query_emits_result(tmp_path, monkeypatch):
    ctx, events = _ctx(tmp_path)
    _inline_threads(monkeypatch)
    monkeypatch.setattr(
        "src.sidecar.handlers.SearchEngine.search",
        lambda platform, query, max_results=10, proxy=None: [
            VideoInfo(
                url="https://www.youtube.com/watch?v=abc",
                title="lofi mix",
                duration=61,
                uploader="someone",
                platform=platform,
            )
        ],
    )
    result = dispatch(
        ctx,
        Method.SEARCH_QUERY.value,
        {"query": "lofi", "platform": "youtube", "maxResults": 5},
    )
    assert result["searchId"]
    name, payload = events[-1]
    assert name == "search.result"
    assert payload["ok"] is True
    assert payload["searchId"] == result["searchId"]
    assert payload["items"][0]["url"] == "https://www.youtube.com/watch?v=abc"
    assert payload["items"][0]["platform"] == "youtube"


def test_search_query_failure_emits_error(tmp_path, monkeypatch):
    ctx, events = _ctx(tmp_path)
    _inline_threads(monkeypatch)

    def _boom(*_args, **_kwargs):
        raise RuntimeError("网络不可达")

    monkeypatch.setattr("src.sidecar.handlers.SearchEngine.search", _boom)
    result = dispatch(ctx, Method.SEARCH_QUERY.value, {"query": "x"})
    name, payload = events[-1]
    assert name == "search.result"
    assert payload["ok"] is False
    assert payload["searchId"] == result["searchId"]
    assert "网络不可达" in payload["error"]


def test_search_query_validation(tmp_path):
    ctx, _ = _ctx(tmp_path)
    with pytest.raises(HandlerError) as exc_info:
        dispatch(ctx, Method.SEARCH_QUERY.value, {})
    assert exc_info.value.code == ErrorCode.INVALID_PARAMS

    with pytest.raises(HandlerError) as exc_info:
        dispatch(ctx, Method.SEARCH_QUERY.value, {"query": "x", "platform": "myspace"})
    assert exc_info.value.code == ErrorCode.INVALID_PARAMS

    # 平台存在但不支持搜索
    with pytest.raises(HandlerError) as exc_info:
        dispatch(ctx, Method.SEARCH_QUERY.value, {"query": "x", "platform": "twitter"})
    assert exc_info.value.code == ErrorCode.INVALID_PARAMS
    assert Platform.TWITTER.value == "twitter"


def test_download_reorder(tmp_path):
    ctx, _ = _ctx(tmp_path)
    created = dispatch(
        ctx,
        Method.DOWNLOAD_CREATE_TASKS.value,
        {"urls": ["https://example.com/a", "https://example.com/b"]},
    )
    ids = created["taskIds"]
    assert len(ids) == 2
    dispatch(ctx, Method.DOWNLOAD_REORDER.value, {"ordered_ids": list(reversed(ids))})
    tasks = ctx.manager.get_all_tasks()
    by_id = {tid: tasks[tid].queue_order for tid in ids}
    assert by_id[ids[0]] == 1
    assert by_id[ids[1]] == 0


def test_download_remove_group(tmp_path):
    ctx, events = _ctx(tmp_path)
    t1 = DownloadTask(
        video_info=VideoInfo(url="https://example.com/1", title="一", platform=Platform.YOUTUBE),
        group_id="g-del",
        group_title="要删的合集",
        playlist_index=1,
    )
    t1.status = TaskStatus.COMPLETED
    t2 = DownloadTask(
        video_info=VideoInfo(url="https://example.com/2", title="二", platform=Platform.YOUTUBE),
        group_id="g-del",
        group_title="要删的合集",
        playlist_index=2,
    )
    t2.status = TaskStatus.PENDING
    ctx.manager.add_task(t1)
    ctx.manager.add_task(t2)
    result = dispatch(
        ctx,
        Method.DOWNLOAD_REMOVE_GROUP.value,
        {"groupId": "g-del", "delete_files": False},
    )
    assert result["ok"] is True
    assert set(result["removed"]) == {t1.id, t2.id}
    assert ctx.manager.get_all_tasks() == {}
    removed_events = [e for e in events if e[0] == "task.removed"]
    assert len(removed_events) == 2
