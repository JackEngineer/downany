"""Contracts for isolated package gates; these tests never launch a package."""
import inspect
from pathlib import Path

import pytest

from scripts import test_packaged_queue_recovery as queue_gate
from scripts import test_packaged_legacy_upgrade as legacy_gate
from scripts.legacy_upgrade_fixture import seed_legacy_upgrade_data


def test_queue_gate_keeps_historical_version_defaults():
    parameters = inspect.signature(queue_gate.run_gate).parameters
    assert parameters["expected_version"].default == "0.2.5"
    assert parameters["previous_version"].default == "0.2.4"


def test_queue_cli_forwards_explicit_versions_without_launching_a_process(tmp_path, monkeypatch):
    previous, current = tmp_path / "previous.exe", tmp_path / "current.exe"
    previous.write_bytes(b"test-only placeholder")
    current.write_bytes(b"test-only placeholder")
    calls = []

    def run(*args, **kwargs):
        calls.append((args, kwargs))
        return {"rounds": [1]}

    monkeypatch.setattr(queue_gate, "run_gate", run)
    monkeypatch.setattr(queue_gate.sys, "platform", "win32")
    monkeypatch.setattr(queue_gate.tempfile, "mkdtemp", lambda **_: str(tmp_path / "owned-data"))
    queue_gate.main([
        "--executable", str(current), "--previous-executable", str(previous),
        "--rounds", "1", "--expected-version", "0.3.0", "--previous-version", "0.2.5",
    ])
    assert calls == [((current.resolve(), previous.resolve(), 1, Path(tmp_path / "owned-data")), {
        "expected_version": "0.3.0", "previous_version": "0.2.5",
    })]


def legacy_tasks(fixture):
    return {key: {"id": key, "status": status} for key, status in fixture["expected_statuses"].items()}


def test_packaged_legacy_state_check_allows_scheduler_progress_but_not_duplicate_or_lost_tasks(tmp_path):
    fixture = seed_legacy_upgrade_data(tmp_path)
    tasks = legacy_tasks(fixture)
    tasks["legacy-downloading"]["status"] = "pending"
    legacy_gate.assert_task_states(tasks, fixture)
    with pytest.raises(AssertionError):
        legacy_gate.assert_task_states({**tasks, "extra": tasks["legacy-pending"]}, fixture)
    with pytest.raises(AssertionError):
        legacy_gate.assert_task_states({key: task for key, task in tasks.items() if key != "legacy-completed"}, fixture)


@pytest.mark.parametrize("task_id", ["legacy-paused", "legacy-completed", "legacy-failed", "legacy-cancelled"])
def test_packaged_legacy_state_check_rejects_restarting_paused_or_terminal_tasks(tmp_path, task_id):
    fixture = seed_legacy_upgrade_data(tmp_path)
    tasks = legacy_tasks(fixture)
    tasks[task_id]["status"] = "downloading"
    with pytest.raises(AssertionError):
        legacy_gate.assert_task_states(tasks, fixture)
