"""Visible queue order must survive persistence and match actual scheduling."""
import sqlite3
from copy import deepcopy
from datetime import datetime, timedelta
from unittest.mock import MagicMock

import pytest

from src.core.download_manager import DownloadManager, QueueMutationError
from src.core.download_task import DownloadTask, TaskStatus, VideoInfo
from src.core.task_actions import TaskAction
from src.data.queue_store import QueueStore


def _manager(tmp_path):
    config = MagicMock()
    config.get_concurrent_downloads.return_value = 1
    return DownloadManager(config=config, db=MagicMock(), queue_store=QueueStore(str(tmp_path / "queue.db")))


def _task(task_id, order, *, priority=0, group="", index=0, status=TaskStatus.PENDING):
    return DownloadTask(
        id=task_id,
        video_info=VideoInfo(url=f"https://example.com/{task_id}", title=task_id),
        queue_order=order,
        priority=priority,
        group_id=group,
        playlist_index=index,
        status=status,
        created_at=datetime(2026, 8, 27, 12),
    )


def _seed(manager):
    tasks = [
        _task("high", 0, priority=1),
        _task("a1", 1, group="a", index=1),
        _task("a2", 2, group="a", index=2, status=TaskStatus.PAUSED),
        _task("solo", 3),
        _task("b1", 4, group="b", index=1),
        _task("b2", 5, group="b", index=2),
        _task("done", 90, status=TaskStatus.COMPLETED),
    ]
    manager.tasks.update({task.id: task for task in tasks})
    manager.queue_store.upsert_tasks(tasks)
    return tasks


def _rows(manager):
    with sqlite3.connect(manager.queue_store.db_path) as conn:
        return conn.execute("SELECT * FROM task_queue ORDER BY id").fetchall()


def test_scheduler_key_uses_priority_then_order_creation_and_id(tmp_path):
    manager = _manager(tmp_path)
    tasks = [_task("z", 7, priority=1), _task("a", 7, priority=1), _task("low", 0)]
    manager.tasks.update({task.id: task for task in tasks})
    assert manager._pick_next_pending_locked().id == "a"
    tasks[0].created_at -= timedelta(seconds=1)
    assert manager._pick_next_pending_locked().id == "z"
    tasks[1].queue_order = 6
    assert manager._pick_next_pending_locked().id == "a"


def test_valid_reorder_survives_a_fresh_manager_and_returns_full_snapshots(tmp_path):
    manager = _manager(tmp_path)
    _seed(manager)
    ordered = ["high", "b1", "b2", "solo", "a1", "a2"]

    snapshots = manager.reorder_tasks(ordered)

    assert [task.id for task in snapshots] == ordered + ["done"]
    assert manager.get_task("done").queue_order == 90
    restored = _manager(tmp_path)
    restored.restore_tasks()
    assert [task.id for task in restored.get_snapshot()] == ordered + ["done"]
    assert [task.id for task in manager.queue_store.load_tasks()] == ordered + ["done"]


@pytest.mark.parametrize("ordered", [
    [], ["high", "a1", "a2", "solo", "b1", "b1"],
    ["high", "a1", "a2", "solo", "b1", "missing"],
    ["high", "a1", "a2", "solo", "b1"],
    ["high", "a1", "solo", "a2", "b1", "b2"],
    ["high", "a2", "a1", "solo", "b1", "b2"],
    ["a1", "a2", "high", "solo", "b1", "b2"],
    ["high", "a1", "a2", "solo", "b1", "b2", "done"],
    ["high", "a1", "a2", "solo", "b1", ""],
    ["high", "a1", "a2", "solo", "b1", 2], "high",
])
def test_invalid_reorder_does_not_change_any_object_or_database_row(tmp_path, ordered):
    manager = _manager(tmp_path)
    tasks = _seed(manager)
    originals = deepcopy(tasks)
    before = _rows(manager)
    events = []
    manager.events.subscribe(lambda *args: events.append(args))

    with pytest.raises(ValueError):
        manager.reorder_tasks(ordered)

    assert tasks == originals
    assert all(manager.get_task(task.id) is task for task in tasks)
    assert _rows(manager) == before
    assert events == []


def test_reorder_write_failure_does_not_publish_or_mutate_memory(tmp_path):
    manager = _manager(tmp_path)
    tasks = _seed(manager)
    before, originals = _rows(manager), deepcopy(tasks)
    with sqlite3.connect(manager.queue_store.db_path) as conn:
        conn.execute("CREATE TRIGGER fail_reorder BEFORE UPDATE ON task_queue "
                     "WHEN NEW.id='b1' BEGIN SELECT RAISE(ABORT, 'injected write failure'); END")
    events = []
    manager.events.subscribe(lambda *args: events.append(args))

    with pytest.raises(QueueMutationError):
        manager.reorder_tasks(["high", "b1", "b2", "solo", "a1", "a2"])

    assert tasks == originals
    assert _rows(manager) == before
    assert events == []


def test_priority_change_updates_all_unfinished_group_members_once(tmp_path, monkeypatch):
    manager = _manager(tmp_path)
    tasks = [
        _task("a", 0, group="group"),
        _task("b", 1, group="group", status=TaskStatus.PAUSED),
        _task("c", 2, group="group", status=TaskStatus.FAILED),
        _task("d", 3, group="group", status=TaskStatus.CANCELLED),
        _task("done", 4, group="group", status=TaskStatus.COMPLETED),
        _task("outside", 5),
    ]
    manager.tasks.update({task.id: task for task in tasks})
    manager.queue_store.upsert_tasks(tasks)
    connect = manager.queue_store._get_connection
    statements, connections = [], []

    def traced_connection():
        conn = connect()
        conn.set_trace_callback(statements.append)
        connections.append(conn)
        return conn

    monkeypatch.setattr(manager.queue_store, "_get_connection", traced_connection)
    assert manager.update_task("a", priority=2) is tasks[0]
    assert [task.priority for task in tasks] == [2, 2, 2, 2, 0, 0]
    assert len(connections) == 1
    assert sum(statement.strip().upper() == "COMMIT" for statement in statements) == 1
    assert {task.id: task.priority for task in manager.queue_store.load_tasks()} == {
        "a": 2, "b": 2, "c": 2, "d": 2, "done": 0, "outside": 0,
    }


def test_priority_group_failure_rolls_back_title_options_and_each_original_object(tmp_path):
    manager = _manager(tmp_path)
    tasks = _seed(manager)
    before, originals = _rows(manager), deepcopy(tasks)
    with sqlite3.connect(manager.queue_store.db_path) as conn:
        conn.execute("CREATE TRIGGER fail_priority BEFORE UPDATE ON task_queue "
                     "WHEN NEW.id='a2' BEGIN SELECT RAISE(ABORT, 'injected write failure'); END")
    events = []
    manager.events.subscribe(lambda *args: events.append(args))

    with pytest.raises(QueueMutationError):
        manager.update_task("a1", priority=2, title="new", quality="720p")

    assert tasks == originals
    assert _rows(manager) == before
    assert events == []


def test_completed_priority_is_a_historical_fact(tmp_path):
    manager = _manager(tmp_path)
    _seed(manager)
    before = _rows(manager)
    with pytest.raises(ValueError, match="已完成"):
        manager.update_task("done", priority=3)
    assert _rows(manager) == before


def test_store_loads_high_priority_before_lower_queue_position(tmp_path):
    manager = _manager(tmp_path)
    manager.queue_store.upsert_tasks([_task("low", 0), _task("high", 30, priority=1)])
    assert [task.id for task in manager.queue_store.load_tasks()] == ["high", "low"]


def test_restore_normalizes_legacy_split_groups_without_changing_completed_history(tmp_path):
    manager = _manager(tmp_path)
    tasks = [
        _task("a2", 0, group="group", index=2),
        _task("solo", 1),
        _task("a1", 2, group="group", index=1, priority=1),
        _task("failed", 80, group="group", status=TaskStatus.FAILED),
        _task("done", 90, group="group", status=TaskStatus.COMPLETED, priority=7),
    ]
    manager.queue_store.upsert_tasks(tasks)

    manager.restore_tasks()

    restored = manager.get_all_tasks()
    assert (restored["a1"].priority, restored["a2"].priority, restored["failed"].priority) == (1, 1, 1)
    active = [task.id for task in manager.get_snapshot() if task.status in ("pending", "downloading", "paused")]
    assert active == ["a1", "a2", "solo"]
    assert (restored["done"].priority, restored["done"].queue_order) == (7, 90)
    before = _rows(manager)
    manager.restore_tasks()
    assert _rows(manager) == before


def test_retry_rejoins_its_group_without_splitting_the_visible_scheduler_order(tmp_path):
    manager = _manager(tmp_path)
    tasks = [
        _task("a2", 0, group="group", index=2),
        _task("solo", 1),
        _task("a1", 8, group="group", index=1, status=TaskStatus.FAILED),
    ]
    manager.tasks.update({task.id: task for task in tasks})
    manager.queue_store.upsert_tasks(tasks)

    manager.apply_task_action("a1", TaskAction.RETRY)

    assert [task.id for task in manager.get_snapshot()] == ["a1", "a2", "solo"]
    assert [task.id for task in manager.queue_store.load_tasks()] == ["a1", "a2", "solo"]
    assert manager._pick_next_pending_locked().id == "a1"


def test_new_group_member_inherits_priority_and_stays_with_existing_members(tmp_path):
    manager = _manager(tmp_path)
    tasks = [_task("a2", 0, group="group", index=2, priority=1), _task("solo", 1)]
    manager.tasks.update({task.id: task for task in tasks})
    manager.queue_store.upsert_tasks(tasks)
    new = _task("a1", 0, group="group", index=1)

    manager.add_task(new)

    assert new.priority == 1
    assert [task.id for task in manager.get_snapshot()] == ["a1", "a2", "solo"]
    assert [task.id for task in manager.queue_store.load_tasks()] == ["a1", "a2", "solo"]


def test_retry_rejoin_failure_rolls_back_untargeted_members_too(tmp_path):
    manager = _manager(tmp_path)
    tasks = [
        _task("a2", 0, group="group", index=2), _task("solo", 1),
        _task("a1", 8, group="group", index=1, status=TaskStatus.FAILED),
    ]
    manager.tasks.update({task.id: task for task in tasks})
    manager.queue_store.upsert_tasks(tasks)
    before, originals = _rows(manager), deepcopy(tasks)
    with sqlite3.connect(manager.queue_store.db_path) as conn:
        conn.execute("CREATE TRIGGER fail_rejoin BEFORE UPDATE ON task_queue "
                     "WHEN NEW.id='solo' BEGIN SELECT RAISE(ABORT, 'injected write failure'); END")
    with pytest.raises(QueueMutationError):
        manager.apply_task_action("a1", TaskAction.RETRY)
    assert tasks == originals
    assert _rows(manager) == before


def _priority_rejoin_scenario(manager):
    tasks = [
        _task("g1", 0, group="group", index=1),
        _task("g2", 1, group="group", index=2),
        _task("g3", 2, group="group", index=3),
        _task("solo", 3),
    ]
    manager.tasks.update({task.id: task for task in tasks})
    manager.queue_store.upsert_tasks(tasks)
    manager.apply_task_actions(["g2", "g3"], TaskAction.CANCEL)
    manager.update_task("g1", priority=1)
    manager.reorder_tasks(["g1", "solo"])
    manager.apply_task_actions(["g2", "g3"], TaskAction.RETRY)
    return tasks


def test_lowering_retried_group_priority_keeps_scheduler_and_restart_order_contiguous(tmp_path, monkeypatch):
    manager = _manager(tmp_path)
    _priority_rejoin_scenario(manager)
    connect = manager.queue_store._get_connection
    statements = []

    def traced_connection():
        connection = connect()
        connection.set_trace_callback(statements.append)
        return connection

    monkeypatch.setattr(manager.queue_store, "_get_connection", traced_connection)
    events = []
    manager.events.subscribe(lambda event, payload: events.append((event, payload)))

    manager.update_task("g1", priority=0)

    assert [task.id for task in manager.get_snapshot()] == ["g1", "g2", "g3", "solo"]
    assert sum(statement.strip().upper() == "COMMIT" for statement in statements) == 1
    assert {payload["task_id"] for _, payload in events} == {"g1", "g2", "g3", "solo"}
    before_restart = _rows(manager)
    restored = _manager(tmp_path)
    restored.restore_tasks()
    assert [task.id for task in restored.get_snapshot()] == ["g1", "g2", "g3", "solo"]
    assert _rows(restored) == before_restart


def test_priority_rejoin_normalization_failure_rolls_back_outside_order_and_group(tmp_path):
    manager = _manager(tmp_path)
    tasks = _priority_rejoin_scenario(manager)
    before, originals = _rows(manager), deepcopy(tasks)
    with sqlite3.connect(manager.queue_store.db_path) as connection:
        connection.execute("CREATE TRIGGER fail_outside_order BEFORE UPDATE ON task_queue "
                           "WHEN NEW.id='solo' BEGIN SELECT RAISE(ABORT, 'injected write failure'); END")
    events = []
    manager.events.subscribe(lambda *args: events.append(args))

    with pytest.raises(QueueMutationError):
        manager.update_task("g1", priority=0)

    assert tasks == originals and _rows(manager) == before
    assert all(manager.get_task(task.id) is task for task in tasks)
    assert events == []
