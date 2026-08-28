"""Durable user intent must not change the public task-state contract."""

import pytest

from src.core.download_task import TaskRunIntent, TaskStatus
from src.core.task_actions import (
    TaskAction,
    TaskActionOutcome,
    decide_task_action,
    normalize_restored_state,
    parse_stored_run_intent,
)


@pytest.mark.parametrize(
    "status,intent,action,active,outcome,next_status,next_intent,reset",
    [
        ("pending", "run", "pause", False, "applied", "paused", "pause", False),
        ("downloading", "run", "pause", True, "applied", "paused", "pause", False),
        ("paused", "run", "pause", True, "applied", "paused", "pause", False),
        ("paused", "run", "pause", False, "applied", "paused", "pause", False),
        ("paused", "pause", "resume", False, "applied", "pending", "run", False),
        ("paused", "pause", "resume", True, "deferred", "paused", "run", False),
        ("paused", "run", "resume", True, "deferred", "paused", "run", False),
        ("failed", "run", "retry", False, "applied", "pending", "run", True),
        ("cancelled", "pause", "retry", False, "applied", "pending", "run", True),
        ("cancelled", "pause", "retry", True, "deferred", "paused", "run", True),
        ("failed", "run", "retry", True, "deferred", "paused", "run", True),
        ("pending", "run", "cancel", False, "applied", "cancelled", "pause", False),
        ("downloading", "run", "cancel", True, "applied", "cancelled", "pause", False),
        ("paused", "pause", "cancel", False, "applied", "cancelled", "pause", False),
        ("paused", "run", "cancel", True, "applied", "cancelled", "pause", False),
    ],
)
def test_compatible_actions_preserve_the_requested_run_intent(
    status, intent, action, active, outcome, next_status, next_intent, reset
):
    decision = decide_task_action(
        TaskStatus(status), TaskRunIntent(intent), TaskAction(action),
        worker_active=active,
    )
    assert decision.outcome is TaskActionOutcome(outcome)
    assert decision.next_status is TaskStatus(next_status)
    assert decision.next_intent is TaskRunIntent(next_intent)
    assert decision.reset_for_retry is reset
    assert decision.reason == ""


@pytest.mark.parametrize(
    "status,action",
    [
        ("completed", "pause"), ("completed", "resume"),
        ("completed", "cancel"), ("completed", "retry"),
        ("pending", "resume"), ("pending", "retry"),
        ("downloading", "resume"), ("downloading", "retry"),
        ("paused", "retry"),
        ("failed", "pause"), ("failed", "resume"), ("failed", "cancel"),
        ("cancelled", "pause"), ("cancelled", "resume"), ("cancelled", "cancel"),
    ],
)
@pytest.mark.parametrize("intent", [TaskRunIntent.RUN, TaskRunIntent.PAUSE])
def test_incompatible_action_cannot_mutate_status_or_intent(status, action, intent):
    decision = decide_task_action(
        TaskStatus(status), intent, TaskAction(action), worker_active=False,
    )
    assert decision.outcome is TaskActionOutcome.SKIPPED
    assert decision.next_status is TaskStatus(status)
    assert decision.next_intent is intent
    assert decision.reason == "incompatible_status"
    assert decision.reset_for_retry is False


def test_repeating_an_explicit_pause_is_skipped():
    decision = decide_task_action(
        TaskStatus.PAUSED, TaskRunIntent.PAUSE, TaskAction.PAUSE, worker_active=True,
    )
    assert decision.outcome is TaskActionOutcome.SKIPPED
    assert decision.next_intent is TaskRunIntent.PAUSE


@pytest.mark.parametrize(
    "status,intent,restored_status",
    [
        ("downloading", "run", "pending"),
        ("downloading", "pause", "paused"),
        ("paused", "run", "pending"),
        ("paused", "pause", "paused"),
        ("pending", "pause", "paused"),
        ("pending", "run", "pending"),
        ("completed", "run", "completed"),
        ("completed", "pause", "completed"),
        ("failed", "run", "failed"),
        ("failed", "pause", "failed"),
        ("cancelled", "run", "cancelled"),
        ("cancelled", "pause", "cancelled"),
    ],
)
def test_restore_only_requeues_interrupted_work_with_run_intent(
    status, intent, restored_status
):
    normalized = normalize_restored_state(TaskStatus(status), TaskRunIntent(intent))
    assert normalized == (TaskStatus(restored_status), TaskRunIntent(intent))
    assert normalize_restored_state(*normalized) == normalized


@pytest.mark.parametrize("raw", [None, "", "future-value", 3, {}, []])
@pytest.mark.parametrize(
    "status,expected",
    [
        ("paused", "pause"), ("pending", "run"), ("downloading", "run"),
        ("failed", "run"), ("cancelled", "run"), ("completed", "run"),
    ],
)
def test_legacy_or_unknown_intent_does_not_start_a_user_paused_task(raw, status, expected):
    assert parse_stored_run_intent(TaskStatus(status), raw) is TaskRunIntent(expected)


@pytest.mark.parametrize("status", list(TaskStatus))
@pytest.mark.parametrize("raw,expected", [("run", TaskRunIntent.RUN), ("pause", TaskRunIntent.PAUSE)])
def test_explicit_stored_intent_wins_over_legacy_default(status, raw, expected):
    assert parse_stored_run_intent(status, raw) is expected
