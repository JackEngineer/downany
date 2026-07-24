"""Sidecar method handlers 行为测试。"""
import pytest

from src.core.download_manager import DownloadManager
from src.data.database import HistoryDB
from src.data.json_config import JsonConfig
from src.data.queue_store import QueueStore
from src.sidecar.handlers import HandlerContext, HandlerError, dispatch
from src.sidecar.protocol import ErrorCode, Method


def _ctx(tmp_path):
    HistoryDB._instance = None
    cfg = JsonConfig(str(tmp_path / "config.json"))
    db = HistoryDB(db_path=str(tmp_path / "history.db"))
    store = QueueStore(str(tmp_path / "history.db"))
    manager = DownloadManager(config=cfg, db=db, queue_store=store)
    events = []
    ctx = HandlerContext(
        config=cfg,
        db=db,
        manager=manager,
        emit_event=lambda name, payload: events.append((name, payload)),
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


def test_shutdown_sets_flag(tmp_path):
    ctx, _ = _ctx(tmp_path)
    assert dispatch(ctx, Method.APP_SHUTDOWN.value, {}) == {"ok": True}
    assert ctx.shutdown_requested is True


def test_updater_not_implemented(tmp_path):
    ctx, _ = _ctx(tmp_path)
    with pytest.raises(HandlerError) as exc_info:
        dispatch(ctx, Method.UPDATER_CHECK_YTDLP.value, {})
    assert exc_info.value.code == ErrorCode.NOT_IMPLEMENTED


def test_unknown_method(tmp_path):
    ctx, _ = _ctx(tmp_path)
    with pytest.raises(HandlerError) as exc_info:
        dispatch(ctx, "no.such", {})
    assert exc_info.value.code == ErrorCode.METHOD_NOT_FOUND
