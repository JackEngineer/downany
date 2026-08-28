"""队列持久化接入与重启恢复测试。"""
from copy import deepcopy
from datetime import datetime
from unittest.mock import MagicMock

import pytest

from src.core.download_manager import DownloadManager
from src.core.download_task import DownloadOptions, DownloadTask, TaskRunIntent, TaskStatus, VideoInfo
from src.core.task_actions import TaskAction, TaskActionOutcome
from src.data.queue_store import QueueStore


def _make_task(status=TaskStatus.PENDING, title="t"):
    return DownloadTask(
        video_info=VideoInfo(url="https://example.com/a", title=title),
        options=DownloadOptions(output_path="/tmp"),
        status=status,
    )


def _make_manager(store):
    config = MagicMock()
    config.get_concurrent_downloads.return_value = 1
    return DownloadManager(config=config, db=MagicMock(), queue_store=store)


def test_add_task_persists(tmp_path):
    store = QueueStore(str(tmp_path / "q.db"))
    manager = _make_manager(store)
    task = _make_task()
    manager.add_task(task)
    assert [t.id for t in store.load_tasks()] == [task.id]


def test_status_change_persists(tmp_path):
    store = QueueStore(str(tmp_path / "q.db"))
    manager = _make_manager(store)
    task = _make_task(status=TaskStatus.DOWNLOADING)
    with manager._lock:
        manager.tasks[task.id] = task
    store.upsert_task(task)

    manager.pause_task(task.id)
    assert store.load_tasks()[0].status == TaskStatus.PAUSED


def test_remove_task_removes_row(tmp_path):
    store = QueueStore(str(tmp_path / "q.db"))
    manager = _make_manager(store)
    task = _make_task(status=TaskStatus.COMPLETED)
    with manager._lock:
        manager.tasks[task.id] = task
    store.upsert_task(task)

    assert manager.remove_task(task.id) is True
    assert store.load_tasks() == []


def test_restore_reenqueues_interrupted_running_download(tmp_path):
    store = QueueStore(str(tmp_path / "q.db"))
    store.upsert_task(_make_task(status=TaskStatus.DOWNLOADING, title="was-downloading"))
    store.upsert_task(_make_task(status=TaskStatus.COMPLETED, title="done"))

    manager = _make_manager(store)
    manager.restore_tasks()

    statuses = {t.video_info.title: t.status for t in manager.get_all_tasks().values()}
    assert statuses["was-downloading"] == TaskStatus.PENDING
    assert statuses["done"] == TaskStatus.COMPLETED
    # 恢复后的状态要写回数据库，后续启动不会重复执行迁移。
    persisted = {t.video_info.title: t.status for t in store.load_tasks()}
    assert persisted["was-downloading"] == TaskStatus.PENDING


def test_restore_reenqueues_pending(tmp_path):
    store = QueueStore(str(tmp_path / "q.db"))
    store.upsert_task(_make_task(status=TaskStatus.PENDING, title="waiting"))

    manager = _make_manager(store)
    manager.restore_tasks()

    # 恢复后处于等待状态，可被优先级调度器选中
    picked = manager._pick_next_pending_locked()
    assert picked is not None
    assert picked.video_info.title == "waiting"


def test_manager_without_store_still_works():
    config = MagicMock()
    config.get_concurrent_downloads.return_value = 1
    manager = DownloadManager(config=config, db=MagicMock())
    task = _make_task()
    manager.add_task(task)
    manager.restore_tasks()  # 无存储时为空操作
    assert task.id in manager.get_all_tasks()


def test_stop_marks_downloading_as_paused_not_cancelled(tmp_path):
    """规格 8.3：退出不取消任何任务，下载中转为已暂停并持久化。"""
    store = QueueStore(str(tmp_path / "q.db"))
    manager = _make_manager(store)
    task = _make_task(status=TaskStatus.DOWNLOADING)
    with manager._lock:
        manager.tasks[task.id] = task
    store.upsert_task(task)

    manager.stop(join_timeout=1)

    assert task.status == TaskStatus.PAUSED
    assert store.load_tasks()[0].status == TaskStatus.PAUSED


@pytest.mark.parametrize(
    "status,intent,expected",
    [
        ("downloading", "run", "pending"), ("downloading", "pause", "paused"),
        ("paused", "run", "pending"), ("paused", "pause", "paused"),
        ("pending", "pause", "paused"), ("pending", "run", "pending"),
        ("failed", "run", "failed"), ("cancelled", "pause", "cancelled"),
        ("completed", "run", "completed"),
    ],
)
def test_repeated_restore_obeys_persisted_user_intent(tmp_path, status, intent, expected):
    store = QueueStore(str(tmp_path / "queue.db"))
    task = _make_task(TaskStatus(status))
    task.run_intent = TaskRunIntent(intent)
    store.upsert_task(task)
    for _ in range(3):
        manager = _make_manager(QueueStore(store.db_path))
        manager.restore_tasks()
        got = manager.get_task(task.id)
        assert (got.status.value, got.run_intent.value) == (expected, intent)
        persisted = store.load_tasks()[0]
        assert (persisted.status.value, persisted.run_intent.value) == (expected, intent)


def test_user_pause_and_shutdown_have_different_recovery_intents(tmp_path):
    store = QueueStore(str(tmp_path / "queue.db"))
    manager = _make_manager(store)
    user_paused = _make_task(title="user-paused")
    running = _make_task(TaskStatus.DOWNLOADING, title="keep-running")
    manager.add_task(user_paused)
    manager.add_task(running)
    manager.pause_task(user_paused.id)
    manager.stop()
    restored = _make_manager(QueueStore(store.db_path))
    restored.restore_tasks()
    assert restored.get_task(user_paused.id).status is TaskStatus.PAUSED
    assert restored.get_task(user_paused.id).run_intent is TaskRunIntent.PAUSE
    assert restored.get_task(running.id).status is TaskStatus.PENDING
    assert restored.get_task(running.id).run_intent is TaskRunIntent.RUN


@pytest.mark.parametrize("status", [TaskStatus.FAILED, TaskStatus.CANCELLED])
def test_retry_refreshes_only_recovery_settings_and_clears_attempt_fields(tmp_path, status):
    store = QueueStore(str(tmp_path / "queue.db"))
    manager = _make_manager(store)
    manager.config.build_download_options.return_value = DownloadOptions(
        proxy="http://127.0.0.1:9000", cookies_from_browser="firefox",
        speed_limit=524288, concurrent_fragments=16,
    )
    task = _make_task(status)
    task.group_id, task.group_title, task.playlist_index = "g1", "合集", 2
    task.queue_order, task.priority = 8, 3
    task.options = DownloadOptions(
        output_path=str(tmp_path / "output"), quality="720p", format_id="chosen",
        audio_only=True, postprocessing="mp3", http_headers={"Referer": "https://example.com/"},
        cookiefile="per-task-cookies.txt", proxy="old", cookies_from_browser="old",
        speed_limit=10, concurrent_fragments=4,
    )
    task.error_message, task.error_code, task.completion_note = "failed", "network_error", "old"
    task.progress, task.downloaded_bytes, task.total_bytes = 40, 400, 1000
    task.started_at = task.completed_at = datetime(2026, 8, 26, 1, 2, 3)
    manager.tasks[task.id] = task
    store.upsert_task(task)
    result = manager.apply_task_action(task.id, TaskAction.RETRY)
    assert result.outcome is TaskActionOutcome.APPLIED
    assert (task.status, task.run_intent) == (TaskStatus.PENDING, TaskRunIntent.RUN)
    assert (task.error_message, task.error_code, task.completion_note) == ("", "", "")
    assert (task.progress, task.downloaded_bytes, task.total_bytes) == (0, 0, 0)
    assert task.started_at is None and task.completed_at is None
    assert (task.group_id, task.group_title, task.playlist_index, task.queue_order, task.priority) == ("g1", "合集", 2, 8, 3)
    assert (task.options.proxy, task.options.cookies_from_browser, task.options.speed_limit,
            task.options.concurrent_fragments) == ("http://127.0.0.1:9000", "firefox", 524288, 16)
    assert (task.options.output_path, task.options.quality, task.options.format_id,
            task.options.audio_only, task.options.postprocessing) == (
        str(tmp_path / "output"), "720p", "chosen", True, "mp3",
    )
    assert task.options.http_headers == {"Referer": "https://example.com/"}
    assert task.options.cookiefile == "per-task-cookies.txt"
    assert store.load_tasks()[0] == task


@pytest.mark.parametrize("status,action", [(TaskStatus.PENDING, TaskAction.PAUSE), (TaskStatus.FAILED, TaskAction.RETRY)])
def test_failed_action_write_restores_the_same_task_object(tmp_path, monkeypatch, status, action):
    store = QueueStore(str(tmp_path / "queue.db"))
    manager = _make_manager(store)
    manager.config.build_download_options.return_value = DownloadOptions(proxy="new")
    task = _make_task(status)
    task.error_message, task.progress = "keep", 31
    manager.add_task(task)
    checkpoint = deepcopy(task)
    events = []
    manager.events.subscribe(lambda event, payload: events.append((event, payload)))

    def fail_write(_tasks):
        raise OSError("injected queue write failure")

    monkeypatch.setattr(store, "upsert_tasks", fail_write)
    with pytest.raises(RuntimeError, match="保存"):
        manager.apply_task_action(task.id, action)
    assert manager.get_task(task.id) is task
    assert task == checkpoint
    assert QueueStore(store.db_path).load_tasks()[0] == checkpoint
    assert events == []


def test_skipped_action_never_writes_or_emits_success(tmp_path, monkeypatch):
    store = QueueStore(str(tmp_path / "queue.db"))
    manager = _make_manager(store)
    completed = _make_task(TaskStatus.COMPLETED)
    manager.add_task(completed)
    events = []
    manager.events.subscribe(lambda event, payload: events.append((event, payload)))

    def unexpected_write(_tasks):
        raise AssertionError("skipped action must not write")

    monkeypatch.setattr(store, "upsert_tasks", unexpected_write)
    missing = manager.apply_task_action("missing", TaskAction.PAUSE)
    skipped = manager.apply_task_action(completed.id, TaskAction.RETRY)
    assert (missing.outcome, missing.status, missing.reason) == (TaskActionOutcome.SKIPPED, None, "task_not_found")
    assert (skipped.outcome, skipped.status, skipped.reason) == (TaskActionOutcome.SKIPPED, TaskStatus.COMPLETED, "incompatible_status")
    assert events == []
