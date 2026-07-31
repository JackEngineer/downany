"""Sidecar method handlers 行为测试。"""
import types

import pytest

from src.core.download_manager import DownloadManager
from src.core.download_task import Platform, VideoInfo
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
