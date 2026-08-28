"""A single deterministic progress window coalesces all active downloads."""
from dataclasses import FrozenInstanceError

import pytest

from src.core.progress_buffer import ProgressBuffer, ProgressUpdate


class Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


def _update(task_id="a", progress=1.0):
    return ProgressUpdate(task_id, progress, int(progress * 10), 1000)


def test_thousand_callbacks_share_one_window_with_ten_latest_values():
    clock = Clock()
    buffer = ProgressBuffer(clock=clock)
    for progress in range(100):
        for index in range(10):
            buffer.put(_update(str(index), progress))
    clock.now = 1.999
    assert buffer.drain_due() == ()
    clock.now = 2.0
    assert buffer.drain_due() == tuple(_update(str(index), 99) for index in range(10))
    assert buffer.drain_due(force=True) == ()


def test_new_window_starts_with_first_update_not_last_flush():
    clock = Clock()
    buffer = ProgressBuffer(clock=clock)
    buffer.put(_update())
    clock.now = 2
    assert buffer.drain_due() == (_update(),)
    clock.now = 100
    buffer.put(_update(progress=2))
    assert buffer.drain_due() == ()
    clock.now = 102
    assert buffer.drain_due() == (_update(progress=2),)


def test_requeue_keeps_newer_values_and_defers_retry_for_one_interval():
    clock = Clock()
    buffer = ProgressBuffer(clock=clock)
    buffer.put(_update("a", 1))
    buffer.put(_update("b", 1))
    clock.now = 2
    drained = buffer.drain_due()
    buffer.put(_update("a", 2))
    clock.now = 2.2
    buffer.requeue(drained)
    clock.now = 4.199
    assert buffer.drain_due() == ()
    clock.now = 4.2
    assert {update.task_id: update for update in buffer.drain_due()} == {
        "a": _update("a", 2), "b": _update("b", 1),
    }


def test_discard_one_task_does_not_delay_the_other_tasks():
    clock = Clock()
    buffer = ProgressBuffer(clock=clock)
    buffer.put(_update("a"))
    buffer.put(_update("b"))
    clock.now = 1
    buffer.discard("a")
    clock.now = 2
    assert buffer.drain_due() == (_update("b"),)


@pytest.mark.parametrize("reset", ["clear", "discard", "force"])
def test_empty_buffer_drops_old_deadline(reset):
    clock = Clock()
    buffer = ProgressBuffer(clock=clock)
    buffer.put(_update())
    clock.now = 1
    if reset == "clear":
        buffer.clear()
    elif reset == "discard":
        buffer.discard("a")
    else:
        assert buffer.drain_due(force=True) == (_update(),)
    assert buffer.drain_due(force=True) == ()
    clock.now = 10
    buffer.put(_update(progress=2))
    clock.now = 11.99
    assert buffer.drain_due() == ()
    clock.now = 12
    assert buffer.drain_due() == (_update(progress=2),)


def test_empty_requeue_and_unknown_discard_are_noops():
    clock = Clock()
    buffer = ProgressBuffer(clock=clock)
    buffer.put(_update())
    clock.now = 1
    buffer.requeue(())
    buffer.discard("missing")
    clock.now = 2
    assert buffer.drain_due() == (_update(),)


@pytest.mark.parametrize("interval", [0, -1, float("nan"), float("inf")])
def test_interval_must_be_finite_and_positive(interval):
    with pytest.raises(ValueError):
        ProgressBuffer(interval_seconds=interval)


def test_updates_cannot_be_mutated_after_they_are_buffered():
    update = _update()
    with pytest.raises(FrozenInstanceError):
        update.progress = 99
