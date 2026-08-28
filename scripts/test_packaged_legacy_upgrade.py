"""Verify a Windows Sidecar against independently captured v0.2.1-format data.

Run with python -m scripts.test_packaged_legacy_upgrade. The old format comes
from old source, not an old installed application. All URLs are loopback; data,
synthetic preservation files and logs stay in a newly owned temporary directory.
Actual media/old-package recovery is tested separately by the queue gate.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import sys
import tempfile
import threading

from scripts.legacy_upgrade_fixture import seed_legacy_upgrade_data
from scripts.test_packaged_queue_recovery import MediaServer, Sidecar, database, digest, wait_until


PRESERVED_TABLES = ("download_history", "telegram_delivery_queue", "telegram_delivery_target_blocks", "search_history")


def table_rows(data: Path, table: str) -> list[dict]:
    assert table in PRESERVED_TABLES
    with database(data) as connection:
        return [dict(row) for row in connection.execute(f"SELECT * FROM {table} ORDER BY rowid")]


def assert_task_states(tasks: dict, fixture: dict) -> None:
    assert set(tasks) == set(fixture["task_ids"]), "Legacy queue IDs were lost or duplicated"
    for task_id, expected in fixture["expected_statuses"].items():
        allowed = {"pending", "downloading"} if expected in {"pending", "downloading"} else {expected}
        assert tasks[task_id]["status"] in allowed, (task_id, tasks[task_id]["status"], allowed)


def run_gate(executable: Path, expected_version: str, root: Path, rounds: int = 3) -> dict:
    logs = root / "logs"
    logs.mkdir()
    # Send only a prefix and stall: this gate checks migration, not media playback.
    server = MediaServer(bytes(1024 * 1024))
    server.release.clear()
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    data = root / "data"
    try:
        fixture = seed_legacy_upgrade_data(data, source_url=f"http://127.0.0.1:{server.server_port}/legacy-upgrade.mp4")
        before = {table: table_rows(data, table) for table in PRESERVED_TABLES}
        with database(data) as connection:
            assert len(list(connection.execute("PRAGMA table_info(task_queue)"))) == 17
            original_options = {row["id"]: json.loads(row["options_json"]) for row in connection.execute("SELECT * FROM task_queue")}
        evidence = []
        for index in range(rounds):
            with Sidecar(executable, expected_version, data, logs) as client:
                tasks = wait_until(client.tasks, lambda value: len(value) == 6, "six legacy tasks restored")
                assert_task_states(tasks, fixture)
                assert tasks["legacy-completed"]["file_path"] == str(fixture["completed_path"])
                for member, playlist_index in (("legacy-pending", 1), ("legacy-downloading", 2)):
                    assert tasks[member]["group_id"] == "legacy-collection"
                    assert tasks[member]["priority"] == 1 and tasks[member]["playlist_index"] == playlist_index
                settings = client.request("settings.get")
                assert all(settings.get(key) == value for key, value in fixture["settings"].items()), "Legacy settings changed"
                telegram = client.request("telegram.getConfig")
                assert telegram["nextUpdateOffset"] == "9007199254740993"
                assert telegram["accountId"] == "421" and telegram["targetChatId"] == "-100421"
                assert telegram["autoSendEnabled"] is False
                client.request("settings.update", {"theme_mode": settings["theme_mode"]})
                # Abrupt termination is intentional and targets only this child.
                # A stalled HTTP body must never require an OS restart or UI click.
                client.crash()
            persisted = json.loads(fixture["config"].read_text(encoding="utf-8"))
            assert all(persisted.get(key) == value for key, value in fixture["settings"].items())
            with database(data) as connection:
                rows = {row["id"]: dict(row) for row in connection.execute("SELECT * FROM task_queue")}
                assert set(rows) == set(fixture["task_ids"])
                assert rows["legacy-paused"]["status"] == "paused"
                assert rows["legacy-paused"]["run_intent"] in ("", "pause")
                assert {key: json.loads(row["options_json"]) for key, row in rows.items()} == original_options
            for table, expected_rows in before.items():
                actual = table_rows(data, table)
                # The current schema may add columns, never mutate old outcomes.
                assert len(actual) == len(expected_rows), (table, len(actual), len(expected_rows))
                assert [{key: row[key] for key in old} for row, old in zip(actual, expected_rows)] == expected_rows, table
            assert all(digest(file) == fixture["completed_sha256"] for file in fixture["completed_files"].values())
            evidence.append({"round": index + 1, "tasks": 6, "history": 3, "deliveryStatuses": ["sent", "failed", "uncertain"], "originalDataRetained": True})
            print(json.dumps(evidence[-1]), flush=True)
        report = {
            "result": "passed", "version": expected_version, "sidecarSHA256": digest(executable),
            "fixtureSourceVersion": "0.2.1", "fixtureSourceCommit": fixture["source_commit"],
            "fixtureKind": "old-source-format; not an old packaged application", "dataRoot": str(root),
            "rounds": evidence, "completedFileSHA256": fixture["completed_sha256"],
            "preservedFilesAreSynthetic": True, "userDataTouched": False, "manualInstallationOrOSReboot": False,
        }
        (root / "result.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return report
    finally:
        server.release.set()
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--executable", type=Path, required=True)
    parser.add_argument("--expected-version", default="0.3.0")
    parser.add_argument("--rounds", type=int, default=3)
    args = parser.parse_args(argv)
    if sys.platform != "win32":
        parser.error("This gate targets Windows packages only")
    if not args.executable.is_absolute() or not args.executable.is_file():
        parser.error("executable must name an existing absolute file")
    if not re.fullmatch(r"\d+\.\d+\.\d+", args.expected_version) or not 1 <= args.rounds <= 10:
        parser.error("Expected major.minor.patch and between 1 and 10 rounds")
    root = Path(tempfile.mkdtemp(prefix="downany-packaged-legacy-"))
    print(f"Owned isolated evidence directory: {root}", flush=True)
    run_gate(args.executable.resolve(), args.expected_version, root, args.rounds)
    print(f"Packaged legacy-format gate passed. Evidence: {root / 'result.json'}", flush=True)


if __name__ == "__main__":
    main()
