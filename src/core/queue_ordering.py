"""Pure queue normalization shared by recovery, enqueue and retry boundaries."""
from collections.abc import Sequence
from datetime import datetime

from src.core.download_task import DownloadTask, TaskStatus


SCHEDULABLE_STATUSES = frozenset({TaskStatus.PENDING, TaskStatus.DOWNLOADING, TaskStatus.PAUSED})


def queue_sort_key(task: DownloadTask) -> tuple[int, int, datetime, str]:
    return (-task.priority, task.queue_order, task.created_at, task.id)


def playlist_sort_key(task: DownloadTask) -> tuple[int, datetime, str]:
    return (task.playlist_index, task.created_at, task.id)


def queue_normalization(tasks: Sequence[DownloadTask]) -> dict[str, tuple[int, int]]:
    """Return only changed (priority, order) pairs; never modify task objects.

    Old per-item group priorities converge on the highest unfinished priority.
    Completed results are excluded from both priority and position changes.
    """
    group_priorities: dict[str, int] = {}
    for task in tasks:
        group_id = (task.group_id or "").strip()
        if group_id and task.status != TaskStatus.COMPLETED:
            group_priorities[group_id] = max(group_priorities.get(group_id, task.priority), task.priority)
    priorities = {
        task.id: group_priorities.get((task.group_id or "").strip(), task.priority)
        if task.status != TaskStatus.COMPLETED else task.priority
        for task in tasks
    }
    active = sorted(
        (task for task in tasks if task.status in SCHEDULABLE_STATUSES),
        key=lambda task: (-priorities[task.id], task.queue_order, task.created_at, task.id),
    )
    units: dict[tuple[str, str], list[DownloadTask]] = {}
    for task in active:
        group_id = (task.group_id or "").strip()
        key = ("group", group_id) if group_id else ("task", task.id)
        units.setdefault(key, []).append(task)
    normalized = []
    for (kind, _), members in units.items():
        normalized.extend(sorted(members, key=playlist_sort_key) if kind == "group" else members)
    positions = {task.id: task.queue_order for task in tasks}
    if [task.id for task in active] != [task.id for task in normalized]:
        positions.update({task.id: order for order, task in enumerate(normalized)})
    return {
        task.id: (priorities[task.id], positions[task.id])
        for task in tasks
        if (task.priority, task.queue_order) != (priorities[task.id], positions[task.id])
    }
