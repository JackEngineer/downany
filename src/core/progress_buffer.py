"""Coalesce progress for every task in one timer-free persistence window."""
from __future__ import annotations

import math
import threading
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass


@dataclass(frozen=True)
class ProgressUpdate:
    task_id: str
    progress: float
    downloaded_bytes: int
    total_bytes: int


class ProgressBuffer:
    def __init__(
        self, interval_seconds: float = 2.0, *, clock: Callable[[], float] = time.monotonic,
    ):
        if not math.isfinite(interval_seconds) or interval_seconds <= 0:
            raise ValueError("progress interval must be finite and positive")
        self._interval = interval_seconds
        self._clock = clock
        self._lock = threading.Lock()
        self._latest: dict[str, ProgressUpdate] = {}
        self._next_flush_at: float | None = None

    def put(self, update: ProgressUpdate) -> None:
        with self._lock:
            self._latest[update.task_id] = update
            if self._next_flush_at is None:
                self._next_flush_at = self._clock() + self._interval

    def drain_due(self, *, force: bool = False) -> tuple[ProgressUpdate, ...]:
        with self._lock:
            if not self._latest:
                return ()
            if not force and self._clock() < self._next_flush_at:
                return ()
            updates = tuple(self._latest.values())
            self._latest.clear()
            self._next_flush_at = None
            return updates

    def requeue(self, updates: Sequence[ProgressUpdate]) -> None:
        if not updates:
            return
        with self._lock:
            for update in updates:
                self._latest.setdefault(update.task_id, update)
            self._next_flush_at = self._clock() + self._interval

    def discard(self, task_id: str) -> None:
        with self._lock:
            self._latest.pop(task_id, None)
            if not self._latest:
                self._next_flush_at = None

    def clear(self) -> None:
        with self._lock:
            self._latest.clear()
            self._next_flush_at = None
