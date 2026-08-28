"""Seed sanitized v0.2.1-format data without importing any current product model.

Schema and serialized task shape were captured from the local v0.2.1 tag.
See tests/fixtures/upgrades/v0.2.1/provenance.json for the source identity.
Only empty, caller-owned directories and loopback URLs are accepted.
"""
from __future__ import annotations

from copy import deepcopy
import hashlib
import json
from pathlib import Path
import sqlite3
from urllib.parse import urlsplit


FIXTURE_ROOT = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "upgrades" / "v0.2.1"
STATUSES = ("pending", "downloading", "paused", "completed", "failed", "cancelled")
CREATED_AT = "2026-08-20T00:00:00"
COMPLETED_CONTENT = b"Downany v0.2.1 upgrade preservation fixture. Not a media playback sample.\n"


def _insert(conn: sqlite3.Connection, table: str, row: dict) -> None:
    columns = ", ".join(row)
    placeholders = ", ".join("?" for _ in row)
    conn.execute(f"INSERT INTO {table} ({columns}) VALUES ({placeholders})", tuple(row.values()))


def seed_legacy_upgrade_data(
    root: Path, *, source_url: str = "http://127.0.0.1:9/legacy-upgrade.mp4",
) -> dict:
    """Return paths and expectations for source and packaged migration gates."""
    parsed = urlsplit(source_url)
    if parsed.scheme != "http" or parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
        raise ValueError("Legacy upgrade fixture requires an HTTP loopback URL")
    root = root.resolve()
    if root.exists() and any(root.iterdir()):
        raise ValueError("Legacy upgrade fixture requires an empty directory")
    root.mkdir(parents=True, exist_ok=True)
    output = root / "output"
    output.mkdir()
    config = json.loads((FIXTURE_ROOT / "config.json").read_text(encoding="utf-8"))
    config["download_dir"] = str(output)
    config_path = root / "config.json"
    config_path.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    template = json.loads((FIXTURE_ROOT / "queue-task.json").read_text(encoding="utf-8"))
    database = root / "history.db"
    completed_files = {}
    history_ids = ["legacy-completed", "legacy-delivery-failed-download", "legacy-delivery-uncertain-download"]
    for task_id in history_ids:
        target = output / f"{task_id}.bin"
        target.write_bytes(COMPLETED_CONTENT)
        completed_files[task_id] = target
    task_ids = [f"legacy-{status}" for status in STATUSES]

    with sqlite3.connect(database) as conn:
        conn.executescript((FIXTURE_ROOT / "schema.sql").read_text(encoding="utf-8"))
        for index, status in enumerate(STATUSES):
            row = deepcopy(template)
            row.update(id=task_ids[index], status=status, queue_order=index)
            row["video_info_json"].update(url=source_url, title=f"旧版本任务 {status}")
            row["options_json"]["output_path"] = str(output)
            if status in {"pending", "downloading"}:
                row.update(priority=1, group_id="legacy-collection", group_title="旧版本合集", playlist_index=index + 1)
            if status == "completed":
                row.update(file_path=str(completed_files["legacy-completed"]), progress=100,
                           downloaded_bytes=len(COMPLETED_CONTENT), total_bytes=len(COMPLETED_CONTENT))
            elif status in {"downloading", "paused"}:
                row.update(progress=25, downloaded_bytes=25, total_bytes=100)
            elif status == "failed":
                row.update(error_code="network", error_message="Synthetic legacy network failure")
            for field in ("video_info_json", "options_json"):
                row[field] = json.dumps(row[field], ensure_ascii=False)
            _insert(conn, "task_queue", row)

        for index, (task_id, delivery_status) in enumerate(zip(history_ids, ("sent", "failed", "uncertain"))):
            target = completed_files[task_id]
            _insert(conn, "download_history", {
                "id": task_id, "url": source_url, "title": f"旧版本成品 {index + 1}", "platform": "unknown",
                "duration": 1, "thumbnail_url": "", "uploader": "Fixture", "status": "completed",
                "file_path": str(target), "file_size": target.stat().st_size, "created_at": CREATED_AT,
                "started_at": CREATED_AT, "completed_at": CREATED_AT, "error_message": "",
                "output_state": "ready", "output_ready_at": CREATED_AT + "Z", "output_recovery_safe": 1,
            })
            _insert(conn, "telegram_delivery_queue", {
                "id": f"legacy-delivery-{delivery_status}", "task_id": task_id,
                "account_id": "421", "target_chat_id": "-100421", "target_chat_type": "supergroup",
                "target_chat_title": "Upgrade fixture", "source_url": source_url, "title": f"旧版本成品 {index + 1}",
                "file_path": str(target), "file_size": target.stat().st_size,
                "file_mtime_ns": str(target.stat().st_mtime_ns), "media_kind": "document", "status": delivery_status,
                "attempt_count": index + 1, "telegram_message_id": "9007199254740995" if delivery_status == "sent" else None,
                "last_error_code": "" if delivery_status == "sent" else "SYNTHETIC_TEST_FAILURE",
                "last_error_message": "" if delivery_status == "sent" else "Synthetic delivery outcome",
                "created_at": CREATED_AT + "Z", "updated_at": CREATED_AT + "Z",
                "sent_at": CREATED_AT + "Z" if delivery_status == "sent" else None,
            })
        _insert(conn, "search_history", {"platform": "youtube", "query": "旧版本搜索示例", "searched_at": CREATED_AT})
        _insert(conn, "telegram_delivery_target_blocks", {
            "account_id": "421", "target_chat_id": "-100999", "error_code": "CHAT_WRITE_FORBIDDEN",
            "error_message": "Synthetic blocked target", "blocked_at": CREATED_AT + "Z",
        })
    return {
        "root": root, "database": database, "config": config_path, "output": output,
        "settings": config, "task_ids": task_ids, "history_ids": history_ids,
        "completed_path": completed_files["legacy-completed"], "completed_files": completed_files,
        "completed_sha256": hashlib.sha256(COMPLETED_CONTENT).hexdigest(),
        "expected_statuses": dict(zip(task_ids, STATUSES)),
        "source_commit": json.loads((FIXTURE_ROOT / "provenance.json").read_text(encoding="utf-8"))["commit"],
    }
