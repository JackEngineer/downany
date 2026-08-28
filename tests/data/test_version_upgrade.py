"""Characterize current migrations against an independently captured v0.2.1 schema."""
import hashlib
import json
import sqlite3

import pytest

from scripts.legacy_upgrade_fixture import FIXTURE_ROOT, seed_legacy_upgrade_data
from src.core.download_manager import DownloadManager
from src.core.download_task import TaskRunIntent, TaskStatus
from src.data.database import HistoryDB
from src.data.json_config import JsonConfig
from src.data.queue_store import QueueStore
from src.data.telegram_delivery_store import TelegramDeliveryStore


@pytest.fixture
def legacy(tmp_path, monkeypatch):
    monkeypatch.setattr(HistoryDB, "_instance", None)
    return seed_legacy_upgrade_data(tmp_path)


def _table_rows(database, table):
    with sqlite3.connect(database) as conn:
        return conn.execute(f"SELECT * FROM {table} ORDER BY rowid").fetchall()


def test_fixture_is_real_old_schema_and_has_no_new_queue_fields(legacy):
    provenance = json.loads((FIXTURE_ROOT / "provenance.json").read_text(encoding="utf-8"))
    assert provenance["commit"] == "0dbaeb7fb0394887be51f6dea773aaa79ae38546"
    with sqlite3.connect(legacy["database"]) as conn:
        columns = {row[1] for row in conn.execute("PRAGMA table_info(task_queue)")}
        assert len(columns) == 17
        assert not columns & {"run_intent", "started_at", "completed_at", "completion_note"}
        assert {row[0] for row in conn.execute("SELECT status FROM task_queue")} == set(legacy["expected_statuses"].values())


def test_old_queue_migrates_idempotently_without_losing_task_options(legacy):
    for _ in range(3):
        tasks = QueueStore(str(legacy["database"])).load_tasks()
        assert {task.id: task.status.value for task in tasks} == legacy["expected_statuses"]
        for task in tasks:
            assert task.options.output_path == str(legacy["output"])
            assert task.options.quality == "720p"
            assert task.options.download_subtitles is True
            assert task.options.embed_subs is True
            assert task.options.subtitle_langs == "zh-Hans,en"
            assert task.options.concurrent_fragments == 7
            assert task.completion_note == ""
            assert task.run_intent is (TaskRunIntent.PAUSE if task.status is TaskStatus.PAUSED else TaskRunIntent.RUN)
        assert [(task.id, task.priority, task.group_id, task.playlist_index) for task in tasks[:2]] == [
            ("legacy-pending", 1, "legacy-collection", 1), ("legacy-downloading", 1, "legacy-collection", 2),
        ]


def test_old_crashed_queue_restores_without_restarting_paused_or_terminal_tasks(legacy):
    config = JsonConfig(str(legacy["config"]))
    db = HistoryDB(db_path=str(legacy["database"]))
    expected = {**legacy["expected_statuses"], "legacy-downloading": "pending"}
    for _ in range(5):
        store = QueueStore(str(legacy["database"]))
        manager = DownloadManager(config=config, db=db, queue_store=store)
        manager.restore_tasks()  # No scheduler or network is started by this data test.
        assert {key: task.status.value for key, task in manager.get_all_tasks().items()} == expected
        assert {task.id: task.status.value for task in store.load_tasks()} == expected
        assert manager.get_task("legacy-paused").run_intent is TaskRunIntent.PAUSE
        assert [task.id for task in store.load_tasks()] == legacy["task_ids"]
        assert manager.scheduler_thread is None
    assert hashlib.sha256(legacy["completed_path"].read_bytes()).hexdigest() == legacy["completed_sha256"]


def test_old_settings_preserve_unknown_fields_routing_and_exact_offset_after_save(legacy):
    config = JsonConfig(str(legacy["config"]))
    config.update_from_dict({"concurrent_downloads": 4})
    reopened = JsonConfig(str(legacy["config"]))
    actual = reopened.to_dict()
    assert actual == {**legacy["settings"], "concurrent_downloads": 4}
    assert actual["telegram_next_update_offset"] == "9007199254740993"
    assert actual["fixture_unknown_preference"] == {"retain": True}
    assert reopened.build_download_options().output_path == str(legacy["output"])
    assert reopened.build_download_options().quality == "720p"
    assert reopened.build_download_options().proxy is None


def test_old_history_and_delivery_outcomes_remain_independent_and_do_not_auto_retry(legacy):
    before = _table_rows(legacy["database"], "telegram_delivery_queue")
    blocks_before = _table_rows(legacy["database"], "telegram_delivery_target_blocks")
    searches_before = _table_rows(legacy["database"], "search_history")
    for _ in range(3):
        db = HistoryDB(db_path=str(legacy["database"]))
        deliveries = TelegramDeliveryStore(str(legacy["database"]))
        recovery = deliveries.recover_delivery_leases("2026-08-27T00:00:00Z")
        assert recovery.requeued_count == recovery.uncertain_count == 0
        assert deliveries.claim_next(account_id="421", now="2026-08-27T00:00:00Z", lease_id="fixture", lease_expires_at="2026-08-27T00:01:00Z") is None
        page = deliveries.list_deliveries()
        assert page.total == 3
        assert {record.status for record in page.items} == {"sent", "failed", "uncertain"}
        assert next(record for record in page.items if record.status == "sent").telegram_message_id == "9007199254740995"
        for task_id, target in legacy["completed_files"].items():
            record = db.get_download_record(task_id)
            assert record is not None
            assert record.status == "completed" and record.output_state == "ready"
            assert record.file_path == str(target) and record.file_size == target.stat().st_size
            assert hashlib.sha256(target.read_bytes()).hexdigest() == legacy["completed_sha256"]
    assert _table_rows(legacy["database"], "telegram_delivery_queue") == before
    assert _table_rows(legacy["database"], "telegram_delivery_target_blocks") == blocks_before
    assert _table_rows(legacy["database"], "search_history") == searches_before


def test_fixture_refuses_existing_data_and_external_network_urls(tmp_path):
    marker = tmp_path / "keep.txt"
    marker.write_text("user-owned", encoding="utf-8")
    with pytest.raises(ValueError, match="empty"):
        seed_legacy_upgrade_data(tmp_path)
    with pytest.raises(ValueError, match="loopback"):
        seed_legacy_upgrade_data(tmp_path / "unused", source_url="https://example.com/video")
    assert marker.read_text(encoding="utf-8") == "user-owned"
    assert list(tmp_path.iterdir()) == [marker]
