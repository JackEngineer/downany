"""QueueStore 读写与任务重建测试。"""
import json
import sqlite3
from datetime import datetime

import pytest

from src.core.download_task import (
    DownloadOptions,
    DownloadTask,
    Platform,
    TaskRunIntent,
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


def test_completion_note_roundtrip(tmp_path):
    store = QueueStore(str(tmp_path / "q.db"))
    task = _make_task()
    task.completion_note = "未找到所选语言字幕"
    store.upsert_task(task)

    loaded = store.load_tasks()[0]

    assert loaded.completion_note == "未找到所选语言字幕"
    assert loaded.to_snapshot().completion_note == "未找到所选语言字幕"


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


def test_same_database_reload_preserves_grouped_output_fields(tmp_path):
    db_path = tmp_path / "queue.db"
    output_root = tmp_path / "downloads"
    output_root.mkdir()
    grouped_file = output_root / "合集" / "002 - 第二集.mp4"
    grouped_file.parent.mkdir()
    grouped_file.write_bytes(b"grouped-output")
    ordinary_file = output_root / "普通视频.mp4"
    ordinary_file.write_bytes(b"ordinary-output")

    downloading = _make_task(TaskStatus.DOWNLOADING)
    downloading.video_info.url = "https://example.com/playlist/1"
    downloading.group_id = "group-one"
    downloading.group_title = "合集"
    downloading.playlist_index = 1
    downloading.completion_note = "字幕已保存为独立文件"

    grouped_completed = _make_task(TaskStatus.COMPLETED)
    grouped_completed.video_info.url = "https://example.com/playlist/2"
    grouped_completed.group_id = "group-one"
    grouped_completed.group_title = "合集"
    grouped_completed.playlist_index = 2
    grouped_completed.file_path = str(grouped_file)

    ordinary_completed = _make_task(TaskStatus.COMPLETED)
    ordinary_completed.video_info.url = "https://example.com/ordinary"
    ordinary_completed.file_path = str(ordinary_file)

    store = QueueStore(str(db_path))
    for task in (downloading, grouped_completed, ordinary_completed):
        store.upsert_task(task)

    expected = {
        task.id: (
            task.status,
            task.group_id,
            task.group_title,
            task.playlist_index,
            task.file_path,
            task.completion_note,
        )
        for task in (downloading, grouped_completed, ordinary_completed)
    }

    for _ in range(2):
        reopened = QueueStore(str(db_path))
        loaded = {task.id: task for task in reopened.load_tasks()}
        assert {
            task_id: (
                task.status,
                task.group_id,
                task.group_title,
                task.playlist_index,
                task.file_path,
                task.completion_note,
            )
            for task_id, task in loaded.items()
        } == expected


@pytest.mark.parametrize("legacy_status,expected_intent", [("pending", "run"), ("paused", "pause"), ("downloading", "run")])
def test_group_columns_migrate_from_legacy_schema(tmp_path, legacy_status, expected_intent):
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
                legacy_status,
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
    assert loaded[0].completion_note == ""
    assert loaded[0].run_intent is TaskRunIntent(expected_intent)
    assert loaded[0].status is TaskStatus(legacy_status)
    assert loaded[0].started_at is None
    assert loaded[0].completed_at is None
    assert QueueStore(str(db_path)).load_tasks()[0].run_intent is TaskRunIntent(expected_intent)


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


def _raw_rows(store):
    with sqlite3.connect(store.db_path) as conn:
        return conn.execute("SELECT * FROM task_queue ORDER BY id").fetchall()


def _seed_batch(store):
    tasks = [_make_task(), _make_task()]
    for order, (task, task_id) in enumerate(zip(tasks, ("a", "b"))):
        task.id = task_id
        task.queue_order = order
        store.upsert_task(task)
    return tasks


def test_recovery_intent_and_timestamps_roundtrip(tmp_path):
    store = QueueStore(str(tmp_path / "queue.db"))
    task = _make_task(TaskStatus.PAUSED)
    task.run_intent = TaskRunIntent.PAUSE
    task.started_at = datetime(2026, 8, 27, 12, 0, 1)
    task.completed_at = datetime(2026, 8, 27, 12, 1, 2)
    task.priority, task.queue_order = 2, 7
    task.group_id, task.group_title, task.playlist_index = "group-one", "合集", 3
    store.upsert_task(task)
    restored = QueueStore(store.db_path).load_tasks()[0]
    assert restored.run_intent is TaskRunIntent.PAUSE
    assert restored.started_at == datetime(2026, 8, 27, 12, 0, 1)
    assert restored.completed_at == datetime(2026, 8, 27, 12, 1, 2)
    assert (restored.priority, restored.queue_order, restored.group_id,
            restored.group_title, restored.playlist_index) == (2, 7, "group-one", "合集", 3)


@pytest.mark.parametrize("raw", ["", "future-intent"])
def test_bad_optional_recovery_fields_do_not_drop_the_task(tmp_path, raw):
    store = QueueStore(str(tmp_path / "queue.db"))
    task = _make_task(TaskStatus.PAUSED)
    store.upsert_task(task)
    with sqlite3.connect(store.db_path) as conn:
        conn.execute(
            "UPDATE task_queue SET run_intent=?, started_at='invalid', completed_at=''",
            (raw,),
        )
    restored = store.load_tasks()
    assert len(restored) == 1
    assert restored[0].run_intent is TaskRunIntent.PAUSE
    assert restored[0].started_at is None
    assert restored[0].completed_at is None


@pytest.mark.parametrize("operation", ["upsert", "delete", "order", "progress"])
def test_batch_rolls_back_every_row_when_second_write_fails(tmp_path, operation):
    store = QueueStore(str(tmp_path / "queue.db"))
    tasks = _seed_batch(store)
    before = _raw_rows(store)
    event, predicate = ("DELETE", "OLD.id='b'") if operation == "delete" else ("UPDATE", "NEW.id='b'")
    with sqlite3.connect(store.db_path) as conn:
        conn.execute(
            f"CREATE TRIGGER fail_second BEFORE {event} ON task_queue "
            f"WHEN {predicate} BEGIN SELECT RAISE(ABORT, 'injected batch failure'); END"
        )
    tasks[0].priority = tasks[1].priority = 2
    with pytest.raises(sqlite3.IntegrityError, match="injected batch failure"):
        if operation == "upsert":
            store.upsert_tasks(tasks)
        elif operation == "delete":
            store.remove_tasks(["a", "b"])
        elif operation == "order":
            store.rewrite_queue_order(["a", "b"])
        else:
            store.update_progress_many([("a", 20, 200, 1000), ("b", 40, 400, 1000)])
    assert _raw_rows(store) == before


@pytest.mark.parametrize("ordered_ids", [["a", "a"], ["a", "missing"], ["a"], [], ["", "b"]])
def test_invalid_reorder_is_rejected_before_any_update(tmp_path, ordered_ids, monkeypatch):
    store = QueueStore(str(tmp_path / "queue.db"))
    _seed_batch(store)
    before = _raw_rows(store)
    statements = []
    real_connect = store._get_connection

    def connect():
        conn = real_connect()
        conn.set_trace_callback(statements.append)
        return conn

    monkeypatch.setattr(store, "_get_connection", connect)
    with pytest.raises(ValueError):
        store.rewrite_queue_order(ordered_ids)
    assert not any(statement.lstrip().upper().startswith("UPDATE ") for statement in statements)
    assert _raw_rows(store) == before


def test_reorder_excludes_terminal_rows(tmp_path):
    store = QueueStore(str(tmp_path / "queue.db"))
    _seed_batch(store)
    completed = _make_task(TaskStatus.COMPLETED)
    completed.id, completed.queue_order = "done", 70
    store.upsert_task(completed)
    store.rewrite_queue_order(["b", "a"])
    tasks = {task.id: task for task in store.load_tasks()}
    assert (tasks["b"].queue_order, tasks["a"].queue_order, tasks["done"].queue_order) == (0, 1, 70)
    with pytest.raises(ValueError):
        store.rewrite_queue_order(["b", "a", "done"])


@pytest.mark.parametrize("operation", ["upsert", "delete", "progress"])
@pytest.mark.parametrize("task_ids", [["a", "a"], ["a", ""]])
def test_batch_rejects_invalid_ids_without_partial_mutation(tmp_path, operation, task_ids):
    store = QueueStore(str(tmp_path / "queue.db"))
    _seed_batch(store)
    before = _raw_rows(store)
    with pytest.raises(ValueError):
        if operation == "upsert":
            tasks = [_make_task(), _make_task()]
            for task, task_id in zip(tasks, task_ids):
                task.id = task_id
            store.upsert_tasks(tasks)
        elif operation == "delete":
            store.remove_tasks(task_ids)
        else:
            store.update_progress_many([(task_id, 1, 1, 100) for task_id in task_ids])
    assert _raw_rows(store) == before


@pytest.mark.parametrize("operation", ["delete", "progress"])
def test_missing_id_rolls_back_whole_batch(tmp_path, operation):
    store = QueueStore(str(tmp_path / "queue.db"))
    _seed_batch(store)
    before = _raw_rows(store)
    with pytest.raises(ValueError):
        if operation == "delete":
            store.remove_tasks(["a", "missing"])
        else:
            store.update_progress_many([("a", 1, 1, 100), ("missing", 2, 2, 100)])
    assert _raw_rows(store) == before


def test_progress_batch_preserves_recovery_and_error_fields(tmp_path):
    store = QueueStore(str(tmp_path / "queue.db"))
    task = _make_task(TaskStatus.PAUSED)
    task.run_intent = TaskRunIntent.PAUSE
    task.error_message, task.error_code, task.completion_note = "暂时断开", "network_error", "字幕已保存"
    task.completed_at = datetime(2026, 8, 27, 12, 1, 2)
    store.upsert_task(task)
    store.update_progress_many([(task.id, 50, 150, 300)])
    got = store.load_tasks()[0]
    assert (got.progress, got.downloaded_bytes, got.total_bytes) == (50, 150, 300)
    assert (got.status, got.run_intent) == (TaskStatus.PAUSED, TaskRunIntent.PAUSE)
    assert (got.error_message, got.error_code, got.completion_note) == ("暂时断开", "network_error", "字幕已保存")
    assert got.completed_at == datetime(2026, 8, 27, 12, 1, 2)


def test_each_batch_uses_one_connection_and_one_commit(tmp_path, monkeypatch):
    store = QueueStore(str(tmp_path / "queue.db"))
    tasks = _seed_batch(store)
    connections, statements = [], []
    real_connect = store._get_connection

    def connect():
        conn = real_connect()
        connections.append(conn)
        conn.set_trace_callback(statements.append)
        return conn

    monkeypatch.setattr(store, "_get_connection", connect)
    store.upsert_tasks(tasks)
    store.update_progress_many([("a", 1, 1, 100), ("b", 2, 2, 100)])
    store.rewrite_queue_order(["b", "a"])
    store.remove_tasks(["a", "b"])
    assert len(connections) == 4
    assert sum(statement == "COMMIT" for statement in statements) == 4
    assert _raw_rows(store) == []


@pytest.mark.parametrize("status", [TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED])
def test_stale_progress_batch_cannot_rewrite_terminal_facts(tmp_path, status):
    store = QueueStore(str(tmp_path / "queue.db"))
    task = _make_task(status)
    task.progress, task.downloaded_bytes, task.total_bytes = 100, 300, 300
    store.upsert_task(task)
    before = _raw_rows(store)
    store.update_progress_many([(task.id, 99, 297, 300)])
    assert _raw_rows(store) == before
