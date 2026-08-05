import { describe, expect, it } from "vitest";

import { TaskTracker } from "./taskTracker";

describe("TaskTracker", () => {
  it("aggregates progress of active tasks", () => {
    const tracker = new TaskTracker();
    tracker.hydrate([
      { id: "1", title: "a", status: "downloading", progress: 40 },
      { id: "2", title: "b", status: "downloading", progress: 80 },
      { id: "3", title: "c", status: "completed", progress: 100 },
    ]);
    expect(tracker.activeCount()).toBe(2);
    expect(tracker.aggregateProgress()).toBeCloseTo(0.6);
  });

  it("returns -1 when nothing active", () => {
    const tracker = new TaskTracker();
    tracker.hydrate([{ id: "1", status: "completed", progress: 100 }]);
    expect(tracker.aggregateProgress()).toBe(-1);
  });

  it("applies progress and removal events", () => {
    const tracker = new TaskTracker();
    tracker.hydrate([{ id: "1", title: "a", status: "downloading", progress: 0 }]);
    tracker.applyEvent({
      event: "task.progress",
      payload: { taskId: "1", progress: { progress: 55 } },
    });
    expect(tracker.aggregateProgress()).toBeCloseTo(0.55);
    tracker.applyEvent({ event: "task.removed", payload: { taskId: "1" } });
    expect(tracker.activeCount()).toBe(0);
  });

  it("keeps most recently active tasks last", () => {
    const tracker = new TaskTracker();
    tracker.hydrate([
      { id: "1", title: "old", status: "completed", progress: 100 },
      { id: "2", title: "new", status: "downloading", progress: 10 },
    ]);
    expect(tracker.recent(1)[0].title).toBe("new");
  });

  it("tracks error_message and getByIds returns unknown for misses", () => {
    const tracker = new TaskTracker();
    tracker.hydrate([
      {
        id: "1",
        title: "fail",
        status: "failed",
        progress: 0,
        error_message: "需要登录 Cookie",
      },
    ]);
    tracker.applyEvent({
      event: "task.updated",
      payload: {
        task: {
          id: "1",
          title: "fail",
          status: "failed",
          progress: 0,
          error_message: "登录已过期",
        },
      },
    });
    expect(tracker.getByIds(["1", "missing"])).toEqual([
      {
        id: "1",
        title: "fail",
        status: "failed",
        progress: 0,
        errorMessage: "登录已过期",
      },
      {
        id: "missing",
        title: "",
        status: "unknown",
        progress: 0,
        errorMessage: "",
      },
    ]);
  });
});
