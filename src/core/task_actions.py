"""Side-effect-free task actions and restart normalization."""

from dataclasses import dataclass
from enum import Enum

from src.core.download_task import TaskRunIntent, TaskStatus


class TaskAction(str, Enum):
    PAUSE = "pause"
    RESUME = "resume"
    CANCEL = "cancel"
    RETRY = "retry"


class TaskActionOutcome(str, Enum):
    APPLIED = "applied"
    DEFERRED = "deferred"
    SKIPPED = "skipped"


@dataclass(frozen=True)
class TaskActionDecision:
    outcome: TaskActionOutcome
    next_status: TaskStatus
    next_intent: TaskRunIntent
    reset_for_retry: bool = False
    reason: str = ""


def decide_task_action(
    status: TaskStatus,
    intent: TaskRunIntent,
    action: TaskAction,
    *,
    worker_active: bool,
) -> TaskActionDecision:
    if action == TaskAction.PAUSE and (
        status in (TaskStatus.PENDING, TaskStatus.DOWNLOADING)
        or (status == TaskStatus.PAUSED and intent == TaskRunIntent.RUN)
    ):
        return TaskActionDecision(
            TaskActionOutcome.APPLIED, TaskStatus.PAUSED, TaskRunIntent.PAUSE,
        )
    if action == TaskAction.RESUME and status == TaskStatus.PAUSED:
        return TaskActionDecision(
            TaskActionOutcome.DEFERRED if worker_active else TaskActionOutcome.APPLIED,
            TaskStatus.PAUSED if worker_active else TaskStatus.PENDING,
            TaskRunIntent.RUN,
        )
    if action == TaskAction.CANCEL and status in (
        TaskStatus.PENDING, TaskStatus.DOWNLOADING, TaskStatus.PAUSED,
    ):
        return TaskActionDecision(
            TaskActionOutcome.APPLIED, TaskStatus.CANCELLED, TaskRunIntent.PAUSE,
        )
    if action == TaskAction.RETRY and status in (TaskStatus.FAILED, TaskStatus.CANCELLED):
        return TaskActionDecision(
            TaskActionOutcome.DEFERRED if worker_active else TaskActionOutcome.APPLIED,
            TaskStatus.PAUSED if worker_active else TaskStatus.PENDING,
            TaskRunIntent.RUN,
            reset_for_retry=True,
        )
    return TaskActionDecision(
        TaskActionOutcome.SKIPPED, status, intent, reason="incompatible_status",
    )


def parse_stored_run_intent(status: TaskStatus, raw: object) -> TaskRunIntent:
    if isinstance(raw, str):
        try:
            return TaskRunIntent(raw)
        except ValueError:
            pass
    return TaskRunIntent.PAUSE if status == TaskStatus.PAUSED else TaskRunIntent.RUN


def normalize_restored_state(
    status: TaskStatus, intent: TaskRunIntent,
) -> tuple[TaskStatus, TaskRunIntent]:
    if status in (TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED):
        return status, intent
    return (
        TaskStatus.PAUSED if intent == TaskRunIntent.PAUSE else TaskStatus.PENDING,
        intent,
    )
