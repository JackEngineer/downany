"""Atomic queue actions use real SQLite transactions and original worker objects."""
import sqlite3
import threading
from copy import deepcopy
from unittest.mock import MagicMock

import pytest

from src.core.download_manager import DownloadManager, QueueMutationError
from src.core.download_task import DownloadTask, TaskRunIntent, TaskStatus, VideoInfo
from src.core.task_actions import TaskAction, TaskActionOutcome
from src.data.json_config import JsonConfig
from src.data.queue_store import QueueStore


def _manager(tmp_path):
    store = QueueStore(str(tmp_path / "queue.db"))
    return DownloadManager(
        config=JsonConfig(str(tmp_path / "config.json")),
        db=MagicMock(),
        queue_store=store,
    )


def _add(manager, task_id, status, group_id="group"):
    task = DownloadTask(
        id=task_id,
        video_info=VideoInfo(url=f"https://example.com/{task_id}", title=task_id),
        status=status,
        run_intent=TaskRunIntent.PAUSE if status == TaskStatus.PAUSED else TaskRunIntent.RUN,
        group_id=group_id,
    )
    manager.add_task(task)
    return task


def _rows(manager):
    with sqlite3.connect(manager.queue_store.db_path) as conn:
        return conn.execute("SELECT * FROM task_queue ORDER BY id").fetchall()


def _abort_second_write(manager, event="UPDATE"):
    row = "OLD" if event == "DELETE" else "NEW"
    with sqlite3.connect(manager.queue_store.db_path) as conn:
        conn.execute(
            f"CREATE TRIGGER fail_second BEFORE {event} ON task_queue "
            f"WHEN {row}.id='b' BEGIN SELECT RAISE(ABORT, 'injected batch failure'); END"
        )


@pytest.mark.parametrize(
    "action,applied,deferred",
    [
        (TaskAction.PAUSE, ("pending", "downloading"), ()),
        (TaskAction.RESUME, (), ("paused",)),
        (TaskAction.CANCEL, ("pending", "downloading", "paused"), ()),
        (TaskAction.RETRY, ("failed",), ("cancelled",)),
    ],
)
def test_mixed_group_report_matches_durable_changes(tmp_path, action, applied, deferred):
    manager = _manager(tmp_path)
    tasks = {status.value: _add(manager, status.value, status) for status in TaskStatus}
    outside = _add(manager, "outside", TaskStatus.PENDING, "other")
    manager.active_tasks["paused"] = threading.Thread()
    manager.active_tasks["cancelled"] = threading.Thread()
    events = []
    manager.events.subscribe(lambda name, payload: events.append((name, payload)))

    result = manager.apply_group_action("group", action)

    assert result.action is action
    assert tuple(entry.task_id for entry in result.applied) == applied
    assert tuple(entry.task_id for entry in result.deferred) == deferred
    assert {entry.task_id for entry in result.skipped} == set(tasks) - set(applied + deferred)
    persisted = {task.id: task for task in manager.queue_store.load_tasks()}
    for entry in result.applied + result.deferred:
        assert entry.status is tasks[entry.task_id].status
        assert persisted[entry.task_id].status is entry.status
        assert persisted[entry.task_id].run_intent is tasks[entry.task_id].run_intent
    assert outside.status is TaskStatus.PENDING
    assert {payload["task_id"] for _, payload in events} == set(applied + deferred)


def test_all_pause_includes_waiting_tasks_and_commits_once(tmp_path, monkeypatch):
    manager = _manager(tmp_path)
    _add(manager, "pending", TaskStatus.PENDING)
    _add(manager, "downloading", TaskStatus.DOWNLOADING)
    _add(manager, "completed", TaskStatus.COMPLETED)
    statements = []
    connections = []
    connect = manager.queue_store._get_connection

    def traced_connection():
        conn = connect()
        conn.set_trace_callback(statements.append)
        connections.append(conn)
        return conn

    monkeypatch.setattr(manager.queue_store, "_get_connection", traced_connection)
    result = manager.apply_all_action(TaskAction.PAUSE)

    assert {entry.task_id for entry in result.applied} == {"pending", "downloading"}
    assert [entry.task_id for entry in result.skipped] == ["completed"]
    assert len(connections) == 1
    assert sum(statement.strip().upper() == "COMMIT" for statement in statements) == 1
    assert manager._pick_next_pending_locked() is None


def test_failed_batch_rolls_back_every_original_object_and_row(tmp_path):
    manager = _manager(tmp_path)
    first = _add(manager, "a", TaskStatus.FAILED)
    second = _add(manager, "b", TaskStatus.FAILED)
    originals = deepcopy([first, second])
    before = _rows(manager)
    _abort_second_write(manager)
    events = []
    manager.events.subscribe(lambda *args: events.append(args))

    with pytest.raises(QueueMutationError, match="无法保存任务更改"):
        manager.apply_group_action("group", TaskAction.RETRY)

    assert manager.get_task("a") is first and manager.get_task("b") is second
    assert [first, second] == originals
    assert _rows(manager) == before
    assert events == []


def test_batch_holds_scheduler_out_until_every_task_is_paused(tmp_path, monkeypatch):
    manager = _manager(tmp_path)
    _add(manager, "a", TaskStatus.PENDING)
    _add(manager, "b", TaskStatus.PENDING)
    writing = threading.Event()
    release = threading.Event()
    errors = []
    selected = []
    connect = manager.queue_store._get_connection

    def trace(statement):
        if statement.lstrip().upper().startswith("INSERT ") and not writing.is_set():
            writing.set()
            if not release.wait(3):
                errors.append("write barrier timed out")

    def blocked_connection():
        conn = connect()
        conn.set_trace_callback(trace)
        return conn

    def pause():
        try:
            manager.apply_all_action(TaskAction.PAUSE)
        except Exception as exc:
            errors.append(exc)

    monkeypatch.setattr(manager.queue_store, "_get_connection", blocked_connection)
    monkeypatch.setattr(manager, "_download_task", lambda task: selected.append(task.id))
    writer = threading.Thread(target=pause)
    scheduler = threading.Thread(target=manager._scheduler_loop)
    manager.running = True
    try:
        writer.start()
        assert writing.wait(2)
        scheduler.start()
        assert selected == []
        release.set()
        writer.join(3)
        assert not writer.is_alive()
        with manager._lock:
            assert manager._pick_next_pending_locked() is None
    finally:
        release.set()
        writer.join(3)
        manager.stop(join_timeout=1)
        if scheduler.ident is not None:
            scheduler.join(2)
    assert errors == []
    assert selected == []


def test_missing_task_is_skipped_without_affecting_valid_members(tmp_path):
    manager = _manager(tmp_path)
    task = _add(manager, "a", TaskStatus.PENDING)
    result = manager.apply_task_actions(["a", "missing"], TaskAction.PAUSE)
    assert result.applied[0].task_id == task.id
    assert result.skipped[0].reason == "task_not_found"
    assert result.skipped[0].status is None


@pytest.mark.parametrize("task_ids", [["a", "a"], ["a", ""], ["a", 3], "a"])
def test_invalid_batch_ids_are_rejected_without_writes(tmp_path, task_ids):
    manager = _manager(tmp_path)
    _add(manager, "a", TaskStatus.PENDING)
    before = _rows(manager)
    with pytest.raises(ValueError):
        manager.apply_task_actions(task_ids, TaskAction.PAUSE)
    assert _rows(manager) == before
    assert manager.get_task("a").status is TaskStatus.PENDING


def test_group_delete_failure_keeps_tasks_and_files(tmp_path):
    manager = _manager(tmp_path)
    first = _add(manager, "a", TaskStatus.COMPLETED)
    second = _add(manager, "b", TaskStatus.PENDING)
    path = tmp_path / "finished.mp4"
    path.write_bytes(b"verified-output")
    first.file_path = str(path)
    manager.queue_store.upsert_task(first)
    _abort_second_write(manager, "DELETE")
    before = _rows(manager)

    with pytest.raises(QueueMutationError):
        manager.remove_group("group", delete_files=True)

    assert path.read_bytes() == b"verified-output"
    assert manager.get_task("a") is first and manager.get_task("b") is second
    assert second.status is TaskStatus.PENDING
    assert _rows(manager) == before


def test_group_delete_reports_file_failure_after_durable_removal(tmp_path, monkeypatch):
    manager = _manager(tmp_path)
    task = _add(manager, "a", TaskStatus.COMPLETED)
    path = tmp_path / "finished.mp4"
    path.write_bytes(b"verified-output")
    task.file_path = str(path)
    manager.queue_store.upsert_task(task)
    observed = []

    def refuse_file_delete(file_path):
        observed.append((file_path, manager.get_all_tasks(), _rows(manager)))
        return False

    monkeypatch.setattr(manager, "_delete_task_file", refuse_file_delete)
    result = manager.remove_group("group", delete_files=True)

    assert result.removed == ("a",)
    assert len(result.file_delete_failures) == 1
    assert result.file_delete_failures[0].task_id == "a"
    assert str(path) not in str(result.file_delete_failures)
    assert observed == [(str(path), {}, [])]
    assert path.is_file()


def test_pause_overrides_a_deferred_resume(tmp_path):
    manager = _manager(tmp_path)
    task = _add(manager, "a", TaskStatus.PAUSED)
    manager.active_tasks[task.id] = threading.Thread()
    assert manager.resume_task(task.id).outcome is TaskActionOutcome.DEFERRED

    result = manager.apply_all_action(TaskAction.PAUSE)

    assert len(result.applied) == 1
    assert (task.status, task.run_intent) == (TaskStatus.PAUSED, TaskRunIntent.PAUSE)
    restored = manager.queue_store.load_tasks()[0]
    assert (restored.status, restored.run_intent) == (TaskStatus.PAUSED, TaskRunIntent.PAUSE)


def test_already_missing_file_is_not_reported_as_a_deletion_failure(tmp_path):
    manager = _manager(tmp_path)
    task = _add(manager, "a", TaskStatus.COMPLETED)
    task.file_path = str(tmp_path / "already-removed.mp4")
    manager.queue_store.upsert_task(task)

    result = manager.remove_group("group", delete_files=True)

    assert result.removed == (task.id,)
    assert result.file_delete_failures == ()
