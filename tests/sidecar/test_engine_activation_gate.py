"""引擎切换只能在没有使用旧引擎的工作时冻结，并封住新请求竞态。"""
from copy import deepcopy
import threading
import time
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from src.core.download_manager import DownloadManager
from src.core.download_task import DownloadTask, TaskStatus, VideoInfo
from src.data.json_config import JsonConfig
from src.sidecar import handlers, ytdlp_updater
from src.sidecar.handlers import HandlerContext, HandlerError, dispatch
from src.sidecar.paths import AppPaths


SHA = "a" * 64
CURRENT = {"version": "2026.08.19", "source": "bundled", "selection": "bundled"}
PENDING = {"schemaVersion": 1, "sha256": SHA, "version": "2026.09.01"}


class FakeEngineUpdates:
    def __init__(self, _paths):
        self.state = {"current": CURRENT, "pending": PENDING, "operation": None}
        self.calls = []

    def snapshot(self):
        return deepcopy(self.state)

    def start_check(self):
        self.calls.append("check")
        return {"jobId": "check-job"}

    def start_prepare(self):
        self.calls.append("prepare")
        return {"jobId": "prepare-job"}


@pytest.fixture
def ctx(tmp_path, monkeypatch):
    monkeypatch.setattr(ytdlp_updater, "EngineUpdateService", FakeEngineUpdates, raising=False)
    monkeypatch.setattr(ytdlp_updater, "read_pending", lambda _paths: deepcopy(PENDING), raising=False)
    monkeypatch.setattr(ytdlp_updater, "check_update", lambda *_args, **_kwargs: {"legacy": True})
    monkeypatch.setattr(ytdlp_updater, "update_ytdlp", lambda *_args, **_kwargs: {"legacy": True})
    paths = AppPaths(data_dir=tmp_path / "data", log_dir=tmp_path / "logs").ensure()
    config = JsonConfig(str(paths.config_path))
    manager = DownloadManager(config, MagicMock())
    context = HandlerContext(config, MagicMock(), manager, lambda _event, _payload: None, paths)
    # 旧实现尚无服务成员；红测试仍须走到错误行为，而不是 fixture 报错。
    if not hasattr(context, "engine_updates"):
        context.engine_updates = FakeEngineUpdates(paths)
    return context


def freeze(ctx, sha=SHA):
    return dispatch(ctx, "updater.freezeEngine", {"sha256": sha})


def task(status):
    return DownloadTask(video_info=VideoInfo(url="https://example.invalid/test"), status=status)


def test_update_handlers_start_background_jobs_and_expose_state(ctx):
    assert dispatch(ctx, "updater.checkYtDlp", {}) == {"jobId": "check-job"}
    assert dispatch(ctx, "updater.updateYtDlp", {}) == {"jobId": "prepare-job"}
    assert dispatch(ctx, "updater.getEngineState", {}) == ctx.engine_updates.snapshot()
    assert ctx.engine_updates.calls == ["check", "prepare"]


@pytest.mark.parametrize("key,value", [
    ("downloadUrl", "https://example.invalid/code"), ("download_url", ""), ("downloadUrl", None),
])
def test_prepare_rejects_all_caller_download_urls(ctx, key, value):
    with pytest.raises(HandlerError) as exc:
        dispatch(ctx, "updater.updateYtDlp", {key: value})
    assert exc.value.code.value == "INVALID_PARAMS"
    assert ctx.engine_updates.calls == []


@pytest.mark.parametrize("status", [TaskStatus.PENDING, TaskStatus.DOWNLOADING])
def test_queued_or_downloading_tasks_block_freeze(ctx, status):
    queued = task(status)
    ctx.manager.tasks[queued.id] = queued
    assert freeze(ctx) == {"frozen": False, "reason": "busy"}
    assert queued.status == status


def test_still_owned_worker_blocks_freeze_even_after_task_is_paused(ctx):
    paused = task(TaskStatus.PAUSED)
    ctx.manager.tasks[paused.id] = paused
    ctx.manager.active_tasks[paused.id] = threading.current_thread()
    assert freeze(ctx) == {"frozen": False, "reason": "busy"}


@pytest.mark.parametrize("kind", ["parse", "search", "check", "prepare"])
def test_other_engine_work_blocks_freeze(ctx, kind):
    if kind == "parse":
        job = handlers._ParseJob()
        job.cancel()
        ctx._parse_jobs["cancelled-but-not-done"] = job
    elif kind == "search":
        ctx._search_jobs = {"owned-search"}
    else:
        ctx.engine_updates.state["operation"] = {"id": "work", "kind": kind, "state": "running"}
    assert freeze(ctx) == {"frozen": False, "reason": "busy"}


@pytest.mark.parametrize("pending,sha", [(None, SHA), (PENDING, "b" * 64), (PENDING, "")])
def test_freeze_binds_fresh_validated_pending_identity(ctx, monkeypatch, pending, sha):
    monkeypatch.setattr(ytdlp_updater, "read_pending", lambda _paths: pending)
    assert freeze(ctx, sha) == {"frozen": False, "reason": "not_ready"}


@pytest.mark.parametrize("status", ["preparing", "sending", "pending", "retry_wait"])
def test_telegram_active_deliveries_block_but_waiting_deliveries_remain(ctx, status):
    store = MagicMock()
    store.list_deliveries.side_effect = lambda **kwargs: SimpleNamespace(total=int(kwargs.get("status") == status))
    ctx.telegram = SimpleNamespace(store=store)
    result = freeze(ctx)
    assert result["frozen"] is (status in ("pending", "retry_wait"))
    if not result["frozen"]:
        assert result["reason"] == "busy"


def test_freeze_does_not_stop_or_rewrite_paused_queue_and_token_is_one_use(ctx, monkeypatch):
    paused = task(TaskStatus.PAUSED)
    ctx.manager.tasks[paused.id] = paused
    ctx.manager.running = True
    monkeypatch.setattr(ctx.manager, "stop", lambda: pytest.fail("freeze must not stop the manager"))
    result = freeze(ctx)
    assert result["frozen"] is True
    assert result["current"] == CURRENT
    assert result["pending"] == PENDING
    assert isinstance(result["token"], str) and result["token"]
    assert ctx.manager.running is True
    assert paused.status is TaskStatus.PAUSED
    assert ctx.manager._engine_update_frozen is True
    with pytest.raises(HandlerError):
        dispatch(ctx, "updater.unfreezeEngine", {"token": "wrong"})
    assert ctx.manager._engine_update_frozen is True
    assert dispatch(ctx, "updater.unfreezeEngine", {"token": result["token"]}) == {"ok": True}
    assert ctx.manager._engine_update_frozen is False
    with pytest.raises(HandlerError):
        dispatch(ctx, "updater.unfreezeEngine", {"token": result["token"]})


@pytest.mark.parametrize("method", [
    "settings.update", "download.createTasks", "download.parseUrls", "search.query",
    "download.retry", "telegram.claimNext", "updater.checkYtDlp", "updater.updateYtDlp",
])
def test_frozen_process_rejects_new_work_with_fixed_retryable_error(ctx, method):
    assert freeze(ctx)["frozen"]
    with pytest.raises(HandlerError) as exc:
        dispatch(ctx, method, {})
    assert exc.value.retryable is True
    assert exc.value.message == "下载组件正在切换，请稍后重试"


def test_frozen_process_keeps_read_and_control_requests_available(ctx, monkeypatch):
    token = freeze(ctx)["token"]
    monkeypatch.setattr(handlers, "check_ytdlp_health", lambda _paths: {"ok": True})
    assert dispatch(ctx, "app.ping", {}) == {"ok": True}
    assert "tasks" in dispatch(ctx, "app.getSnapshot", {})
    assert "current" in dispatch(ctx, "updater.getEngineState", {})
    assert dispatch(ctx, "updater.checkHealth", {}) == {"ok": True}
    assert dispatch(ctx, "updater.unfreezeEngine", {"token": token}) == {"ok": True}


def test_freeze_refuses_an_inflight_request_without_holding_lock_across_its_work(ctx, monkeypatch):
    started, release = threading.Event(), threading.Event()

    def slow_update(_ctx, _payload):
        started.set()
        assert release.wait(timeout=3)
        return {"ok": True}

    monkeypatch.setattr(handlers, "_settings_update", slow_update)
    thread = threading.Thread(target=lambda: dispatch(ctx, "settings.update", {}))
    thread.start()
    try:
        assert started.wait(timeout=1)
        before = time.monotonic()
        assert freeze(ctx) == {"frozen": False, "reason": "busy"}
        assert time.monotonic() - before < 0.5
    finally:
        release.set()
        thread.join(timeout=2)
    assert not thread.is_alive()
    assert freeze(ctx)["frozen"] is True


def test_shutdown_inflight_or_finished_cannot_issue_a_new_freeze_token(ctx, monkeypatch):
    stopping, release = threading.Event(), threading.Event()

    def stop():
        stopping.set()
        assert release.wait(timeout=3)

    monkeypatch.setattr(ctx.manager, "stop", stop)
    thread = threading.Thread(target=lambda: dispatch(ctx, "app.shutdown", {}))
    thread.start()
    try:
        assert stopping.wait(timeout=1)
        assert freeze(ctx) == {"frozen": False, "reason": "busy"}
    finally:
        release.set()
        thread.join(timeout=2)
    assert not thread.is_alive()
    assert ctx.shutdown_requested is True
    assert freeze(ctx) == {"frozen": False, "reason": "busy"}


def test_duplicate_search_ids_cannot_hide_an_older_running_search(ctx, monkeypatch):
    started = [threading.Event(), threading.Event()]
    release = [threading.Event(), threading.Event()]

    def search(_platform, query, **_kwargs):
        index = int(query)
        started[index].set()
        assert release[index].wait(timeout=4)
        return []

    monkeypatch.setattr(handlers.SearchEngine, "search", search)
    try:
        for index in range(2):
            dispatch(ctx, "search.query", {"query": str(index), "searchId": "same"})
            assert started[index].wait(timeout=1)
        assert len(ctx._search_jobs) == 2
        release[1].set()
        deadline = time.monotonic() + 1
        while len(ctx._search_jobs) > 1 and time.monotonic() < deadline:
            time.sleep(0.01)
        assert len(ctx._search_jobs) == 1
        assert freeze(ctx) == {"frozen": False, "reason": "busy"}
    finally:
        for event in release:
            event.set()
        deadline = time.monotonic() + 2
        while getattr(ctx, "_search_jobs", None) and time.monotonic() < deadline:
            time.sleep(0.01)


def test_request_arriving_while_freeze_is_committing_cannot_enter_afterwards(ctx, monkeypatch):
    reached_manager, release = threading.Event(), threading.Event()
    original_freeze = ctx.manager.freeze_for_engine_update
    responses, errors, entered = [], [], []

    def held_freeze():
        reached_manager.set()
        assert release.wait(timeout=3)
        return original_freeze()

    def request():
        try:
            dispatch(ctx, "settings.update", {})
        except HandlerError as exc:
            errors.append(exc)

    monkeypatch.setattr(ctx.manager, "freeze_for_engine_update", held_freeze)
    monkeypatch.setattr(handlers, "_settings_update", lambda *_args: entered.append(True))
    freezer = threading.Thread(target=lambda: responses.append(freeze(ctx)))
    requester = threading.Thread(target=request)
    freezer.start()
    try:
        assert reached_manager.wait(timeout=1)
        requester.start()
    finally:
        release.set()
        freezer.join(timeout=2)
        if requester.ident is not None:
            requester.join(timeout=2)
    assert not freezer.is_alive() and not requester.is_alive()
    assert responses[0]["frozen"] is True
    assert len(errors) == 1 and errors[0].retryable
    assert entered == []


def test_inline_search_thread_unregisters_without_lock_deadlock(ctx, monkeypatch):
    class InlineThread:
        def __init__(self, target, **_kwargs):
            self.target = target

        def start(self):
            self.target()

    monkeypatch.setattr(handlers.threading, "Thread", InlineThread)
    monkeypatch.setattr(handlers.SearchEngine, "search", lambda *_args, **_kwargs: [])
    assert dispatch(ctx, "search.query", {"query": "demo"})["searchId"]
    assert not ctx._search_jobs


def test_scheduler_cannot_claim_work_during_frozen_window_and_resumes_after_unfreeze(ctx, monkeypatch):
    token = freeze(ctx)["token"]
    queued = task(TaskStatus.PENDING)
    claimed = threading.Event()

    def download(current):
        with ctx.manager._lock:
            current.status = TaskStatus.COMPLETED
            ctx.manager.active_tasks.pop(current.id, None)
        claimed.set()

    monkeypatch.setattr(ctx.manager, "_download_task", download)
    with ctx.manager._lock:
        ctx.manager.tasks[queued.id] = queued
    ctx.manager.start()
    try:
        assert not claimed.wait(timeout=0.4)
        assert dispatch(ctx, "updater.unfreezeEngine", {"token": token}) == {"ok": True}
        assert claimed.wait(timeout=2)
    finally:
        ctx.manager.stop()
