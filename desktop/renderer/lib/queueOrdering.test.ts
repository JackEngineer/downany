import { describe, expect, it } from "vitest";

import { taskFixture } from "../test/taskFixture";
import { buildQueueUnits, compareQueueTasks, moveQueueUnit } from "./queueOrdering";

function fixture() {
  return [
    taskFixture({ id: "solo", queue_order: 0 }),
    taskFixture({ id: "a2", group_id: "a", playlist_index: 2, queue_order: 1 }),
    taskFixture({ id: "high", priority: 1, queue_order: 9 }),
    taskFixture({ id: "a1", group_id: "a", playlist_index: 1, queue_order: 2 }),
    taskFixture({ id: "last", queue_order: 3, status: "paused" }),
    taskFixture({ id: "completed", status: "completed" }),
    taskFixture({ id: "failed", status: "failed" }),
    taskFixture({ id: "cancelled", status: "cancelled" }),
  ];
}

describe("queue ordering", () => {
  it("matches priority, queue position, creation time and id in that order", () => {
    const tasks = [
      taskFixture({ id: "z", priority: 1, queue_order: 2 }),
      taskFixture({ id: "a", priority: 1, queue_order: 2 }),
      taskFixture({ id: "low", queue_order: 0 }),
      taskFixture({ id: "early", priority: 1, queue_order: 2, created_at: "2026-08-15T00:00:00Z" }),
    ];
    expect(tasks.sort(compareQueueTasks).map((task) => task.id)).toEqual(["early", "a", "z", "low"]);
  });

  it("builds one contiguous, playlist-ordered unit per active group without modifying input", () => {
    const tasks = fixture();
    const before = JSON.stringify(tasks);
    expect(buildQueueUnits(tasks)).toEqual([
      { kind: "task", key: "task:high", taskIds: ["high"], priority: 1 },
      { kind: "task", key: "task:solo", taskIds: ["solo"], priority: 0 },
      { kind: "group", key: "group:a", taskIds: ["a1", "a2"], priority: 0 },
      { kind: "task", key: "task:last", taskIds: ["last"], priority: 0 },
    ]);
    expect(JSON.stringify(tasks)).toBe(before);
  });

  it.each([
    ["group:a", "up", ["high", "a1", "a2", "solo", "last"]],
    ["group:a", "down", ["high", "solo", "last", "a1", "a2"]],
    ["task:last", "top", ["high", "last", "solo", "a1", "a2"]],
    ["task:solo", "up", ["high", "solo", "a1", "a2", "last"]],
    ["task:high", "down", ["high", "solo", "a1", "a2", "last"]],
    ["task:last", "down", ["high", "solo", "a1", "a2", "last"]],
  ] as const)("moves %s %s only inside its priority band", (key, move, expected) => {
    const units = buildQueueUnits(fixture());
    const before = JSON.stringify(units);
    expect(moveQueueUnit(units, key, move)).toEqual(expected);
    expect(JSON.stringify(units)).toBe(before);
  });

  it("rejects a stale unit instead of constructing a shortened payload", () => {
    expect(() => moveQueueUnit(buildQueueUnits(fixture()), "task:missing", "up")).toThrow();
  });

  it("flattens 1000 tasks without losing duplicates, hidden members, or group sequence", () => {
    const tasks = Array.from({ length: 1000 }, (_, index) => taskFixture({
      id: String(index), queue_order: index,
      group_id: `group-${Math.floor(index / 5)}`, playlist_index: index % 5 + 1,
    }));
    const units = buildQueueUnits(tasks);
    expect(units).toHaveLength(200);
    const ordered = moveQueueUnit(units, "group:group-199", "top");
    expect(ordered.slice(0, 5)).toEqual(["995", "996", "997", "998", "999"]);
    expect(ordered).toHaveLength(1000);
    expect(new Set(ordered).size).toBe(1000);
  });
});
