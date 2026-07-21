"""QueueStore 读写与任务重建测试。"""
from src.core.download_task import (
    DownloadOptions,
    DownloadTask,
    Platform,
    TaskStatus,
    VideoInfo,
)
from src.data.queue_store import QueueStore


def _make_task(status=TaskStatus.PENDING):
    return DownloadTask(
        video_info=VideoInfo(
            url="https://example.com/v",
            title="示例",
            duration=120,
            uploader="up",
            platform=Platform.BILIBILI,
            file_size=999,
        ),
        options=DownloadOptions(
            quality="1080p",
            download_subtitles=True,
            output_path="/tmp/dl",
            speed_limit=1024,
            proxy="http://127.0.0.1:7890",
        ),
        status=status,
        progress=33.0,
        downloaded_bytes=100,
        total_bytes=300,
    )


def test_upsert_and_load_roundtrip(tmp_path):
    store = QueueStore(str(tmp_path / "q.db"))
    task = _make_task()
    store.upsert_task(task)

    loaded = store.load_tasks()
    assert len(loaded) == 1
    got = loaded[0]
    assert got.id == task.id
    assert got.video_info.url == "https://example.com/v"
    assert got.video_info.title == "示例"
    assert got.video_info.platform == Platform.BILIBILI
    assert got.options.quality == "1080p"
    assert got.options.download_subtitles is True
    assert got.options.output_path == "/tmp/dl"
    assert got.options.speed_limit == 1024
    assert got.options.proxy == "http://127.0.0.1:7890"
    assert got.status == TaskStatus.PENDING
    assert got.progress == 33.0
    assert got.downloaded_bytes == 100
    assert got.total_bytes == 300


def test_upsert_twice_keeps_single_row(tmp_path):
    store = QueueStore(str(tmp_path / "q.db"))
    task = _make_task()
    store.upsert_task(task)
    task.status = TaskStatus.PAUSED
    store.upsert_task(task)

    loaded = store.load_tasks()
    assert len(loaded) == 1
    assert loaded[0].status == TaskStatus.PAUSED


def test_update_progress(tmp_path):
    store = QueueStore(str(tmp_path / "q.db"))
    task = _make_task()
    store.upsert_task(task)
    store.update_progress(task.id, 80.0, 240, 300)

    got = store.load_tasks()[0]
    assert got.progress == 80.0
    assert got.downloaded_bytes == 240


def test_remove_task(tmp_path):
    store = QueueStore(str(tmp_path / "q.db"))
    task = _make_task()
    store.upsert_task(task)
    store.remove_task(task.id)
    assert store.load_tasks() == []


def test_shares_db_file_with_history(tmp_path):
    """与历史库共用同一个 SQLite 文件不冲突。"""
    db_file = str(tmp_path / "history.db")
    from src.data.database import HistoryDB

    HistoryDB._instance = None
    HistoryDB(db_path=db_file)
    store = QueueStore(db_file)
    store.upsert_task(_make_task())
    assert len(store.load_tasks()) == 1
    HistoryDB._instance = None
