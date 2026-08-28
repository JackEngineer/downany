"""Queue scale gates count transactions and exact results, not wall-clock limits."""
from datetime import datetime
from unittest.mock import MagicMock

from src.core.download_manager import DownloadManager
from src.core.download_task import DownloadTask, VideoInfo
from src.data.queue_store import QueueStore


def test_thousand_rows_restore_and_reorder_with_one_transaction_each(tmp_path, monkeypatch):
    store = QueueStore(str(tmp_path / "queue.db"))
    tasks = [DownloadTask(id=f"task-{index:04d}", queue_order=index,
                          created_at=datetime(2026, 8, 27),
                          video_info=VideoInfo(url=f"https://example.com/{index}", title=str(index)))
             for index in range(1000)]
    statements, connections = [], []
    real_connect = store._get_connection

    def connect():
        conn = real_connect()
        conn.set_trace_callback(statements.append)
        connections.append(conn)
        return conn

    monkeypatch.setattr(store, "_get_connection", connect)
    store.upsert_tasks(tasks)
    assert len(connections) == 1
    assert statements.count("COMMIT") == 1
    manager = DownloadManager(config=MagicMock(), db=MagicMock(), queue_store=store)
    manager.restore_tasks()
    assert len(connections) == 2
    assert statements.count("COMMIT") == 1
    assert [task.id for task in manager.get_snapshot()] == [task.id for task in tasks]
    ordered = [task.id for task in reversed(tasks)]
    manager.reorder_tasks(ordered)
    assert len(connections) == 3
    assert statements.count("COMMIT") == 2
    loaded = store.load_tasks()
    assert len(connections) == 4
    assert [task.id for task in loaded] == ordered
    assert [task.queue_order for task in loaded] == list(range(1000))
    assert [task.video_info.title for task in loaded] == [task.video_info.title for task in reversed(tasks)]
