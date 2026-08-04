"""QueueStore 读写与任务重建测试。"""
import json

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
            http_headers={"Referer": "https://example.com/", "Cookie": "a=1"},
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
    assert got.options.http_headers == {
        "Referer": "https://example.com/",
        "Cookie": "a=1",
    }
    assert got.status == TaskStatus.PENDING
    assert got.progress == 33.0
    assert got.downloaded_bytes == 100
    assert got.total_bytes == 300


def test_error_code_roundtrip(tmp_path):
    store = QueueStore(str(tmp_path / "q.db"))
    task = _make_task()
    task.error_code = "need_login"
    store.upsert_task(task)
    loaded = store.load_tasks()[0]
    assert loaded.error_code == "need_login"


def test_postprocessing_list_deserializes_to_string_and_pipeline(tmp_path):
    store = QueueStore(str(tmp_path / "q.db"))
    task = _make_task()
    task.options.postprocessing = "mp4"
    store.upsert_task(task)

    conn = store._get_connection()
    row = conn.execute("SELECT options_json FROM task_queue WHERE id = ?", (task.id,)).fetchone()
    opts = json.loads(row["options_json"])
    opts["postprocessing"] = ["mp4", "mp3"]
    conn.execute(
        "UPDATE task_queue SET options_json = ? WHERE id = ?",
        (json.dumps(opts), task.id),
    )
    conn.commit()

    loaded = store.load_tasks()[0]
    assert loaded.options.postprocessing == "mp4"
    assert loaded.options.postprocessing_pipeline == ["mp4", "mp3"]


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


def test_queue_order_roundtrip(tmp_path):
    store = QueueStore(str(tmp_path / "q.db"))
    task = _make_task()
    task.queue_order = 7
    store.upsert_task(task)
    loaded = store.load_tasks()[0]
    assert loaded.queue_order == 7


def test_group_fields_roundtrip(tmp_path):
    store = QueueStore(str(tmp_path / "q.db"))
    task = _make_task()
    task.group_id = "g-playlist-1"
    task.group_title = "我的合集"
    task.playlist_index = 12
    store.upsert_task(task)
    loaded = store.load_tasks()[0]
    assert loaded.group_id == "g-playlist-1"
    assert loaded.group_title == "我的合集"
    assert loaded.playlist_index == 12


def test_group_columns_migrate_from_legacy_schema(tmp_path):
    import sqlite3

    db_path = tmp_path / "legacy.db"
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            """
            CREATE TABLE task_queue (
                id TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                progress REAL NOT NULL DEFAULT 0,
                downloaded_bytes INTEGER NOT NULL DEFAULT 0,
                total_bytes INTEGER NOT NULL DEFAULT 0,
                error_message TEXT NOT NULL DEFAULT '',
                file_path TEXT NOT NULL DEFAULT '',
                video_info_json TEXT NOT NULL,
                options_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            INSERT INTO task_queue
            (id, status, progress, downloaded_bytes, total_bytes, error_message,
             file_path, video_info_json, options_json, created_at, updated_at)
            VALUES (?, ?, 0, 0, 0, '', '', ?, ?, ?, ?)
            """,
            (
                "legacy-1",
                "pending",
                json.dumps(
                    {
                        "url": "https://example.com/v",
                        "title": "旧任务",
                        "platform": "youtube",
                    },
                    ensure_ascii=False,
                ),
                json.dumps({"quality": "best", "output_path": "/tmp"}, ensure_ascii=False),
                "2024-01-01T00:00:00",
                "2024-01-01T00:00:00",
            ),
        )
        conn.commit()

    store = QueueStore(str(db_path))
    loaded = store.load_tasks()
    assert len(loaded) == 1
    assert loaded[0].group_id == ""
    assert loaded[0].group_title == ""
    assert loaded[0].playlist_index == 0


def test_load_tasks_sorted_by_queue_order(tmp_path):
    store = QueueStore(str(tmp_path / "q.db"))
    first = _make_task()
    second = _make_task()
    first.queue_order = 2
    second.queue_order = 1
    store.upsert_task(first)
    store.upsert_task(second)
    loaded = store.load_tasks()
    assert [t.id for t in loaded] == [second.id, first.id]
