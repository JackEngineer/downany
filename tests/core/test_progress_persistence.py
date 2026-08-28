"""Real SQLite checks for coalescing, retries and full/progress write races."""
import sqlite3
import threading
from unittest.mock import MagicMock

import pytest

from src.core.download_manager import DownloadManager, QueueMutationError
from src.core.download_task import DownloadTask, TaskRunIntent, TaskStatus, VideoInfo
from src.core.progress_buffer import ProgressBuffer, ProgressUpdate
from src.data.json_config import JsonConfig
from src.data.queue_store import QueueStore


@pytest.fixture
def progress_manager(tmp_path):
    manager = DownloadManager(
        config=JsonConfig(str(tmp_path / "config.json")), db=MagicMock(),
        queue_store=QueueStore(str(tmp_path / "queue.db")),
    )
    clock = [0.0]
    manager._progress_buffer = ProgressBuffer(clock=lambda: clock[0])
    return manager, clock


def _add(manager, task_id="a", status=TaskStatus.DOWNLOADING):
    task = DownloadTask(id=task_id, status=status, video_info=VideoInfo(
        url=f"https://example.com/{task_id}", title=task_id,
    ))
    manager.add_task(task)
    return task


def _progress(manager, task, value):
    with manager._lock:
        task.progress = value
        task.downloaded_bytes = int(value * 10)
        task.total_bytes = 1000
        manager._progress_buffer.put(ProgressUpdate(
            task.id, task.progress, task.downloaded_bytes, task.total_bytes,
        ))


def _trace(store, monkeypatch):
    statements, connections = [], []
    real_connect = store._get_connection

    def connect():
        conn = real_connect()
        conn.set_trace_callback(statements.append)
        connections.append(conn)
        return conn

    monkeypatch.setattr(store, "_get_connection", connect)
    return statements, connections


def test_thousand_updates_write_one_transaction_at_the_deadline(progress_manager, monkeypatch):
    manager, clock = progress_manager
    tasks = [_add(manager, str(index)) for index in range(10)]
    statements, connections = _trace(manager.queue_store, monkeypatch)
    for value in range(100):
        for task in tasks:
            _progress(manager, task, value)
        manager._flush_progress_due()
    clock[0] = 1.999
    manager._flush_progress_due()
    assert connections == []
    clock[0] = 2.0
    manager._flush_progress_due()
    assert len(connections) == 1
    assert sum(statement == "COMMIT" for statement in statements) == 1
    assert sum(statement.lstrip().startswith("UPDATE task_queue") for statement in statements) == 10
    assert all((task.progress, task.downloaded_bytes, task.total_bytes) == (99, 990, 1000)
               for task in manager.queue_store.load_tasks())


def test_failed_batch_retries_later_with_newest_values(progress_manager):
    manager, clock = progress_manager
    tasks = [_add(manager, "a"), _add(manager, "b")]
    with sqlite3.connect(manager.queue_store.db_path) as conn:
        conn.execute("CREATE TRIGGER fail_progress BEFORE UPDATE ON task_queue "
                     "WHEN NEW.id='b' BEGIN SELECT RAISE(ABORT, 'injected failure'); END")
    for task in tasks:
        _progress(manager, task, 10)
    clock[0] = 2
    manager._flush_progress_due()
    assert all(task.progress == 0 for task in manager.queue_store.load_tasks())
    _progress(manager, tasks[0], 20)
    with sqlite3.connect(manager.queue_store.db_path) as conn:
        conn.execute("DROP TRIGGER fail_progress")
    clock[0] = 3.99
    manager._flush_progress_due()
    assert all(task.progress == 0 for task in manager.queue_store.load_tasks())
    clock[0] = 4
    manager._flush_progress_due()
    assert {task.id: task.progress for task in manager.queue_store.load_tasks()} == {"a": 20, "b": 10}
    assert manager._progress_buffer.drain_due(force=True) == ()


@pytest.mark.parametrize("status", [TaskStatus.PAUSED, TaskStatus.COMPLETED,
                                    TaskStatus.FAILED, TaskStatus.CANCELLED])
def test_late_progress_for_inactive_or_removed_tasks_is_dropped(progress_manager, status):
    manager, clock = progress_manager
    task = _add(manager)
    _progress(manager, task, 99)
    task.status = status
    task.progress = 100 if status == TaskStatus.COMPLETED else 99
    manager.queue_store.upsert_task(task)
    manager._progress_buffer.put(ProgressUpdate("missing", 99, 990, 1000))
    clock[0] = 2
    manager._flush_progress_due()
    assert manager.queue_store.load_tasks()[0].progress == task.progress
    assert manager._progress_buffer.drain_due(force=True) == ()


@pytest.mark.parametrize("first", ["progress", "complete"])
def test_full_write_and_progress_flush_serialize_in_both_orders(progress_manager, monkeypatch, first):
    manager, clock = progress_manager
    task = _add(manager)
    _progress(manager, task, 99)
    clock[0] = 2
    entered, release, second_attempted = threading.Event(), threading.Event(), threading.Event()
    errors = []
    method = "update_progress_many" if first == "progress" else "upsert_task"
    original = getattr(manager.queue_store, method)

    def held_write(*args):
        entered.set()
        assert release.wait(5)
        return original(*args)

    monkeypatch.setattr(manager.queue_store, method, held_write)

    def complete():
        with manager._lock:
            task.status, task.progress = TaskStatus.COMPLETED, 100
            task.downloaded_bytes = task.total_bytes = 1000
            assert manager._persist(task)

    def run(operation, second=False):
        if second:
            second_attempted.set()
        try:
            operation()
        except BaseException as exc:
            errors.append(exc)

    operations = [manager._flush_progress_due, complete]
    if first == "complete":
        operations.reverse()
    threads = [threading.Thread(target=run, args=(operation, index == 1))
               for index, operation in enumerate(operations)]
    threads[0].start()
    try:
        assert entered.wait(5)
        threads[1].start()
        assert second_attempted.wait(5)
    finally:
        release.set()
        for thread in threads:
            if thread.ident is not None:
                thread.join(timeout=5)
    assert not errors
    assert all(not thread.is_alive() for thread in threads)
    stored = manager.queue_store.load_tasks()[0]
    assert (stored.status, stored.progress, stored.downloaded_bytes) == (TaskStatus.COMPLETED, 100, 1000)
    assert manager._progress_buffer.drain_due(force=True) == ()


def test_stop_saves_latest_progress_in_one_full_transaction_and_clears_buffer(progress_manager, monkeypatch):
    manager, _ = progress_manager
    tasks = [_add(manager, str(index)) for index in range(10)]
    for task in tasks:
        _progress(manager, task, 42)
    before_threads = set(threading.enumerate())
    statements, connections = _trace(manager.queue_store, monkeypatch)
    manager.stop()
    assert len(connections) == 1
    assert sum(statement == "COMMIT" for statement in statements) == 1
    assert manager._progress_buffer.drain_due(force=True) == ()
    assert set(threading.enumerate()) <= before_threads
    assert all((task.status, task.run_intent, task.progress) ==
               (TaskStatus.PAUSED, TaskRunIntent.RUN, 42)
               for task in manager.queue_store.load_tasks())


def test_stop_failure_still_clears_buffer_and_reports_failure(progress_manager):
    manager, _ = progress_manager
    task = _add(manager)
    _progress(manager, task, 42)
    with sqlite3.connect(manager.queue_store.db_path) as conn:
        conn.execute("CREATE TRIGGER fail_stop BEFORE UPDATE ON task_queue "
                     "BEGIN SELECT RAISE(ABORT, 'injected failure'); END")
    with pytest.raises(QueueMutationError):
        manager.stop()
    assert manager.running is False
    assert manager._progress_buffer.drain_due(force=True) == ()


def test_stale_worker_cannot_overwrite_a_new_task_with_the_same_id(progress_manager):
    manager, _ = progress_manager
    old = _add(manager)
    manager.remove_task(old.id, force=True)
    current = _add(manager)
    current.video_info.title = "new task"
    manager.queue_store.upsert_task(current)
    old.status, old.progress = TaskStatus.COMPLETED, 100
    assert manager._persist(old) is False
    assert manager.queue_store.load_tasks()[0].video_info.title == "new task"


def test_full_persist_and_force_remove_cannot_resurrect_the_row(progress_manager, monkeypatch):
    manager, _ = progress_manager
    task = _add(manager)
    entered, release, removing = threading.Event(), threading.Event(), threading.Event()
    errors = []
    original = manager.queue_store.upsert_task

    def held_write(value):
        entered.set()
        assert release.wait(5)
        original(value)

    def run(operation):
        try:
            operation()
        except BaseException as exc:
            errors.append(exc)

    def remove():
        removing.set()
        manager.remove_task(task.id, force=True)

    monkeypatch.setattr(manager.queue_store, "upsert_task", held_write)
    writer = threading.Thread(target=run, args=(lambda: manager._persist(task),))
    remover = threading.Thread(target=run, args=(remove,))
    writer.start()
    held_manager_lock = False
    try:
        assert entered.wait(5)
        held_manager_lock = not manager._lock.acquire(blocking=False)
        if not held_manager_lock:
            manager._lock.release()
        remover.start()
        assert removing.wait(5)
    finally:
        release.set()
        writer.join(timeout=5)
        if remover.ident is not None:
            remover.join(timeout=5)
    assert not errors
    assert held_manager_lock
    assert not writer.is_alive() and not remover.is_alive()
    assert manager.queue_store.load_tasks() == []


def test_progress_failures_do_not_log_response_bodies_or_urls(progress_manager, monkeypatch, caplog):
    manager, clock = progress_manager
    _progress(manager, _add(manager), 1)

    def fail(_rows):
        raise OSError("https://secret.example/video Cookie=private-body")

    monkeypatch.setattr(manager.queue_store, "update_progress_many", fail)
    clock[0] = 2
    with caplog.at_level("WARNING", logger="DownloadManager"):
        manager._flush_progress_due()
    assert "OSError" in caplog.text
    assert "secret.example" not in caplog.text
    assert "Cookie" not in caplog.text
