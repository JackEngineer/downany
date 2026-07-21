"""队列持久化接入与重启恢复测试。"""
from unittest.mock import MagicMock

from src.core.download_manager import DownloadManager
from src.core.download_task import DownloadOptions, DownloadTask, TaskStatus, VideoInfo
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


def test_restore_downgrades_downloading_to_paused(tmp_path):
    store = QueueStore(str(tmp_path / "q.db"))
    store.upsert_task(_make_task(status=TaskStatus.DOWNLOADING, title="was-downloading"))
    store.upsert_task(_make_task(status=TaskStatus.COMPLETED, title="done"))

    manager = _make_manager(store)
    manager.restore_tasks()

    statuses = {t.video_info.title: t.status for t in manager.get_all_tasks().values()}
    assert statuses["was-downloading"] == TaskStatus.PAUSED
    assert statuses["done"] == TaskStatus.COMPLETED
    # 降级后的状态要写回数据库
    persisted = {t.video_info.title: t.status for t in store.load_tasks()}
    assert persisted["was-downloading"] == TaskStatus.PAUSED


def test_restore_reenqueues_pending(tmp_path):
    store = QueueStore(str(tmp_path / "q.db"))
    store.upsert_task(_make_task(status=TaskStatus.PENDING, title="waiting"))

    manager = _make_manager(store)
    manager.restore_tasks()

    assert manager.task_queue.qsize() == 1


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
