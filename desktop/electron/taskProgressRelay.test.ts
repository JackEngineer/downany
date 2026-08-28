import { describe, expect, it, vi } from "vitest";

import { TaskProgressRelay, taskProgressPatch } from "./taskProgressRelay";

function event(taskId: string, progress: number) {
  return {
    event: "task.progress",
    payload: {
      taskId,
      task: { id: taskId, status: "downloading", title: "private title", url: "private URL",
        progress, downloaded_bytes: progress * 10, total_bytes: 1000, speed: "10 B/s", eta: "10s" },
      progress: { progress: progress - 1, _speed_str: "older speed" },
    },
  };
}

function harness() {
  let nextId = 0;
  const callbacks = new Map<number, () => void>();
  const onFlush = vi.fn();
  const schedule = vi.fn((callback: () => void, _delay: number) => {
    const id = ++nextId;
    callbacks.set(id, callback);
    return id;
  });
  const cancel = vi.fn((id: unknown) => callbacks.delete(id as number));
  const relay = new TaskProgressRelay(onFlush, schedule, cancel);
  const tick = () => {
    const pending = [...callbacks.values()];
    callbacks.clear();
    for (const callback of pending) callback();
  };
  return { relay, onFlush, schedule, cancel, callbacks, tick };
}

describe("TaskProgressRelay", () => {
  it("coalesces 1000 events into one batch of ten latest progress-only patches", () => {
    const { relay, schedule, onFlush, tick } = harness();
    for (let value = 0; value < 100; value += 1) {
      for (let index = 0; index < 10; index += 1) relay.enqueue(event(String(index), value));
    }
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule.mock.calls[0][1]).toBe(100);
    expect(onFlush).not.toHaveBeenCalled();
    tick();
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush.mock.calls[0][0]).toEqual(Array.from({ length: 10 }, (_, index) => ({
      taskId: String(index), progress: 99, downloaded_bytes: 990, total_bytes: 1000,
      speed: "10 B/s", eta: "10s",
    })));
    expect(JSON.stringify(onFlush.mock.calls)).not.toMatch(/private|url|title|status/);
  });

  it("merges partial legacy progress without losing the latest byte count", () => {
    const { relay, tick, onFlush } = harness();
    relay.enqueue({ event: "task.progress", payload: { taskId: "a", progress: { progress: 10, downloaded_bytes: 100 } } });
    relay.enqueue({ event: "task.progress", payload: { taskId: "a", progress: { progress: 20, _speed_str: "2 B/s" } } });
    tick();
    expect(onFlush).toHaveBeenCalledWith([{ taskId: "a", progress: 20, downloaded_bytes: 100, speed: "2 B/s" }]);
  });

  it("drops terminal/removed tasks without delaying remaining progress", () => {
    const { relay, tick, onFlush, schedule } = harness();
    relay.enqueue(event("a", 99));
    relay.enqueue(event("b", 40));
    relay.drop("a");
    tick();
    expect(onFlush.mock.calls[0][0].map((patch: { taskId: string }) => patch.taskId)).toEqual(["b"]);
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it("cancels the only pending callback when the last task is dropped", () => {
    const { relay, tick, onFlush, cancel, callbacks } = harness();
    relay.enqueue(event("a", 99));
    relay.drop("a");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(callbacks.size).toBe(0);
    tick();
    expect(onFlush).not.toHaveBeenCalled();
  });

  it("explicit flush cancels its timer and allows a fresh window", () => {
    const { relay, tick, onFlush, callbacks, schedule } = harness();
    relay.enqueue(event("a", 1));
    relay.flush();
    expect(callbacks.size).toBe(0);
    relay.enqueue(event("a", 2));
    tick();
    expect(onFlush).toHaveBeenCalledTimes(2);
    expect(schedule).toHaveBeenCalledTimes(2);
  });

  it("clears reconnect leftovers without disabling future updates", () => {
    const { relay, tick, onFlush } = harness();
    relay.enqueue(event("a", 99));
    relay.clear();
    relay.enqueue(event("a", 1));
    tick();
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush.mock.calls[0][0][0].progress).toBe(1);
  });

  it("dispose releases values and ignores future enqueue or stale callbacks", () => {
    const { relay, callbacks, onFlush } = harness();
    relay.enqueue(event("a", 99));
    const stale = [...callbacks.values()][0];
    relay.dispose();
    relay.enqueue(event("b", 1));
    stale();
    relay.flush();
    expect(callbacks.size).toBe(0);
    expect(onFlush).not.toHaveBeenCalled();
  });

  it("does not drop updates enqueued by the flush consumer", () => {
    const { relay, tick, onFlush, callbacks } = harness();
    onFlush.mockImplementationOnce(() => relay.enqueue(event("b", 2)));
    relay.enqueue(event("a", 1));
    tick();
    expect(callbacks.size).toBe(1);
    tick();
    expect(onFlush).toHaveBeenCalledTimes(2);
  });

  it("ignores invalid/empty progress, terminal snapshots and non-progress events", () => {
    const { relay, schedule } = harness();
    relay.enqueue({ event: "task.updated", payload: { taskId: "a", progress: { progress: 99 } } });
    relay.enqueue({ event: "task.progress", payload: { taskId: "a", progress: { progress: NaN, total_bytes: Infinity } } });
    relay.enqueue({ event: "task.progress", payload: { task: { id: "a", status: "completed", progress: 100 } } });
    relay.enqueue({ event: "task.progress", payload: {} });
    expect(schedule).not.toHaveBeenCalled();
  });
});

describe("taskProgressPatch", () => {
  it("uses a coherent task ID and copies only valid progress fields", () => {
    expect(taskProgressPatch({ event: "task.progress", payload: {
      task_id: "a", progress: { progress: 10, total_bytes: 200, _eta_str: "2s", status: "completed" },
    } })).toEqual({ taskId: "a", progress: 10, total_bytes: 200, eta: "2s" });
    expect(taskProgressPatch({ event: "task.progress", payload: {
      taskId: "a", task: { id: "other", progress: 10 },
    } })).toBeNull();
  });
});
