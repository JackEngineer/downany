"""Repeated crash-boundary/restart scenarios use independent real databases."""
import hashlib
import threading
from collections import Counter
from datetime import datetime
from pathlib import Path

import pytest

from src.core.download_task import TaskRunIntent, TaskStatus
from src.core.downloader import DownloadCancelled
from src.core.task_actions import TaskActionOutcome


@pytest.mark.parametrize("round_index", range(20))
def test_crash_snapshot_recovery_keeps_ids_groups_order_and_completed_bytes(queue_download_harness, round_index):
    harness = queue_download_harness
    manager = harness.manager(f"restart-{round_index}")
    rows = [
        ("a1", TaskStatus.DOWNLOADING, TaskRunIntent.RUN, "group-a", 1, 2),
        ("a2", TaskStatus.PAUSED, TaskRunIntent.RUN, "group-a", 2, 2),
        ("a3", TaskStatus.COMPLETED, TaskRunIntent.RUN, "group-a", 3, 2),
        ("b1", TaskStatus.PAUSED, TaskRunIntent.PAUSE, "group-b", 1, 0),
        ("b2", TaskStatus.PENDING, TaskRunIntent.RUN, "group-b", 2, 0),
        ("b3", TaskStatus.FAILED, TaskRunIntent.RUN, "group-b", 3, 0),
        ("solo-run", TaskStatus.DOWNLOADING, TaskRunIntent.RUN, "", 0, 0),
        ("solo-pause", TaskStatus.PAUSED, TaskRunIntent.PAUSE, "", 0, 0),
        ("solo-fail", TaskStatus.FAILED, TaskRunIntent.RUN, "", 0, 0),
        ("solo-cancel", TaskStatus.CANCELLED, TaskRunIntent.PAUSE, "", 0, 0),
    ]
    tasks = [harness.task(manager, task_id, status=status, run_intent=intent,
                          group_id=group, group_title=group, playlist_index=index,
                          priority=priority, queue_order=order,
                          created_at=datetime(2026, 8, 27, 12, 0, order))
             for order, (task_id, status, intent, group, index, priority) in enumerate(rows)]
    completed = tasks[2]
    existing = Path(manager.config.get_download_dir()) / "already-completed.mp4"
    existing.parent.mkdir(parents=True, exist_ok=True)
    existing.write_bytes(b"previously verified output")
    before_hash = hashlib.sha256(existing.read_bytes()).hexdigest()
    completed.file_path, completed.progress = str(existing), 100
    completed.downloaded_bytes = completed.total_bytes = existing.stat().st_size
    completed.completed_at = datetime(2026, 8, 27, 12, 1, 0)
    tasks[-2].error_code, tasks[-2].error_message = "network_error", "网络暂时不可用"
    # This is the exact durable boundary left by a vanished process. No old
    # manager is started and no old worker/finally can race the restored one.
    manager.queue_store.upsert_tasks(tasks)
    manager.restore_tasks()
    restored = manager.get_all_tasks()
    assert set(restored) == {task.id for task in tasks}
    for previous in tasks:
        current = restored[previous.id]
        expected_status = previous.status
        if previous.status in {TaskStatus.DOWNLOADING, TaskStatus.PAUSED} and previous.run_intent == TaskRunIntent.RUN:
            expected_status = TaskStatus.PENDING
        assert (current.status, current.run_intent) == (expected_status, previous.run_intent)
        assert (current.group_id, current.group_title, current.playlist_index, current.priority, current.queue_order) == (
            previous.group_id, previous.group_title, previous.playlist_index, previous.priority, previous.queue_order,
        )
        assert current.options == previous.options
        assert current.created_at == previous.created_at
    assert restored[completed.id].to_snapshot() == completed.to_snapshot()
    for task_id in ("b3", "solo-fail", "solo-cancel"):
        assert manager.retry_task(task_id).outcome is TaskActionOutcome.APPLIED
    for task_id in ("b1", "solo-pause"):
        assert manager.resume_task(task_id).outcome is TaskActionOutcome.APPLIED
    manager.start()
    try:
        harness.wait_for(lambda: all(task.status == TaskStatus.COMPLETED
                                    for task in manager.get_all_tasks().values()))
    finally:
        manager.stop(join_timeout=5)
    persisted = manager.queue_store.load_tasks()
    assert len(persisted) == len({task.id for task in persisted}) == 10
    assert harness.starts == Counter({task.id: 1 for task in tasks if task.id != completed.id})
    assert all(count == 1 for count in harness.peak_per_id.values())
    assert len({task.file_path for task in persisted}) == 10
    assert len(list(existing.parent.rglob("*.mp4"))) == 10
    assert hashlib.sha256(existing.read_bytes()).hexdigest() == before_hash
    for task in persisted:
        assert task.status is TaskStatus.COMPLETED and task.progress == 100
        if task.id != completed.id:
            assert Path(task.file_path).read_bytes() == b"local-media:" + task.id.encode()


@pytest.mark.parametrize("round_index", range(20))
def test_active_pause_resume_waits_for_the_old_worker_and_pending_pause_stays_stopped(queue_download_harness, round_index):
    harness = queue_download_harness
    manager = harness.manager(f"pause-{round_index}")
    active = harness.task(manager, "active")
    waiting = harness.task(manager, "waiting")
    manager.add_task(active)
    manager.add_task(waiting)
    manager.pause_task(waiting.id)
    entered, release = threading.Event(), threading.Event()

    def drain_first_worker(task_id, attempt, _progress):
        if task_id == active.id and attempt == 1:
            entered.set()
            assert release.wait(10), "old worker was not released"
            raise DownloadCancelled("paused by the test user")

    harness.before_download = drain_first_worker
    manager.start()
    try:
        assert entered.wait(5)
        manager.pause_task(active.id)
        assert manager.resume_task(active.id).outcome is TaskActionOutcome.DEFERRED
        assert active.status is TaskStatus.PAUSED and active.run_intent is TaskRunIntent.RUN
        assert harness.starts[active.id] == 1
        assert len(manager.active_tasks) == 1
        release.set()
        harness.wait_for(lambda: active.status == TaskStatus.COMPLETED)
    finally:
        release.set()
        manager.stop(join_timeout=5)
    assert harness.starts == Counter({active.id: 2})
    assert harness.peak_per_id[active.id] == 1
    stored = {task.id: task for task in manager.queue_store.load_tasks()}
    assert stored[active.id].status is TaskStatus.COMPLETED
    assert (stored[waiting.id].status, stored[waiting.id].run_intent) == (TaskStatus.PAUSED, TaskRunIntent.PAUSE)
    assert len(list(Path(manager.config.get_download_dir()).rglob("*.mp4"))) == 1


def test_network_failure_stays_failed_through_twenty_restarts_until_explicit_retry(queue_download_harness):
    harness = queue_download_harness
    initial = harness.manager("failed")
    task = harness.task(initial, "network", status=TaskStatus.FAILED,
                        error_code="network_error", error_message="网络暂时不可用", progress=42)
    task.options.http_headers = {"Referer": "https://example.com/source", "Cookie": "test-cookie"}
    task.options.cookiefile = "per-task-cookiefile.txt"
    task.options.quality, task.options.postprocessing = "720p", "mp4"
    initial.queue_store.upsert_task(task)
    for _ in range(20):
        current = harness.manager("failed")
        current.restore_tasks()
        assert current.get_task(task.id).to_snapshot() == task.to_snapshot()
        assert current._pick_next_pending_locked() is None
        assert not current.active_tasks
    current.config.update_from_dict({"proxy_enabled": True, "proxy_url": "http://127.0.0.1:9000",
                                     "cookies_from_browser": "firefox", "speed_limit": 524288,
                                     "concurrent_fragments": 16})
    assert current.retry_task(task.id).outcome is TaskActionOutcome.APPLIED
    options = current.get_task(task.id).options
    assert (options.proxy, options.cookies_from_browser, options.speed_limit, options.concurrent_fragments) == (
        "http://127.0.0.1:9000", "firefox", 524288, 16,
    )
    assert options.http_headers == task.options.http_headers
    assert options.cookiefile == task.options.cookiefile
    assert (options.quality, options.postprocessing, options.output_path) == (
        task.options.quality, task.options.postprocessing, task.options.output_path,
    )
    assert current.get_task(task.id).progress == 0
    assert not harness.starts


@pytest.mark.parametrize("status", [TaskStatus.PENDING, TaskStatus.CANCELLED])
def test_old_worker_never_starts_or_removes_the_replacement_worker(queue_download_harness, status):
    harness = queue_download_harness
    manager = harness.manager()
    old = harness.task(manager, "reused-id", status=status)
    replacement = harness.task(manager, "reused-id")
    manager.add_task(replacement)
    replacement_worker = threading.Thread()
    manager.active_tasks[replacement.id] = replacement_worker
    manager._download_task(old)
    assert not harness.starts
    assert manager.active_tasks.get(replacement.id) is replacement_worker
    assert manager.get_task(replacement.id) is replacement
    assert replacement.status is TaskStatus.PENDING
