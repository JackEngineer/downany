import { describe, expect, it } from "vitest";
import { sortDownloadTasks } from "./downloadSorting";
import { taskFixture } from "../test/taskFixture";

describe("download display sorting", () => {
  const old = taskFixture({ id: "old", created_at: "2026-01-01T00:00:00Z", priority: 10 });
  const recent = taskFixture({ id: "new", created_at: "2026-02-01T00:00:00Z", queue_order: 100 });
  it("defaults to newest and switches without changing source or execution order", () => {
    const tasks = [old, recent];
    expect(sortDownloadTasks(tasks, "newest").map(t => t.id)).toEqual(["new", "old"]);
    expect(sortDownloadTasks(tasks, "oldest").map(t => t.id)).toEqual(["old", "new"]);
    expect(tasks).toEqual([old, recent]);
  });
  it("uses a stable ID tie-break independent of arrival order", () => {
    const a = taskFixture({ id: "a" }), b = taskFixture({ id: "b" });
    for (const order of ["newest", "oldest"] as const) {
      expect(sortDownloadTasks([b, a], order).map(t => t.id)).toEqual(["a", "b"]);
    }
  });
  it("puts a newly created task first and ignores status or queue changes", () => {
    const latest = taskFixture({ id: "latest", created_at: "2026-03-01T00:00:00Z" });
    const changed = { ...old, status: "downloading", queue_order: -100, completed_at: "2026-04-01T00:00:00Z" };
    expect(sortDownloadTasks([changed, recent, latest], "newest").map(t => t.id)).toEqual(["latest", "new", "old"]);
  });
  it("uses completion time only in the completed tab", () => {
    const finishedLast = { ...old, completed_at: "2026-05-01T00:00:00Z" };
    const finishedFirst = { ...recent, completed_at: "2026-04-01T00:00:00Z" };
    expect(sortDownloadTasks([finishedFirst, finishedLast], "newest", true).map(t => t.id)).toEqual(["old", "new"]);
  });
});
