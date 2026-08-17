import { describe, expect, it } from "vitest";

import { taskFixture } from "../../test/taskFixture";
import { presentTask, toTaskVisualState } from "./taskPresentation";

describe("task presentation", () => {
  it.each([
    ["pending", "等待中", "neutral", null],
    ["downloading", "下载中", "active", "pause"],
    ["paused", "已暂停", "warning", "resume"],
    ["completed", "已完成", "success", "open"],
    ["failed", "下载失败", "danger", "retry"],
    ["cancelled", "已取消", "neutral", "retry"],
  ] as const)("maps %s", (status, label, tone, primaryAction) => {
    const result = presentTask(
      taskFixture({
        status,
        file_path: status === "completed" ? "/tmp/a.mp4" : "",
      }),
      new Date("2026-08-16T12:00:00Z"),
    );
    expect(result).toMatchObject({ status, label, tone, primaryAction });
  });

  it("falls back safely for an unknown runtime state", () => {
    expect(toTaskVisualState("mystery")).toBe("unknown");
    expect(presentTask(taskFixture({ status: "mystery" })).label).toBe("状态未知");
  });

  it("builds completed metadata without a progress line", () => {
    const result = presentTask(
      taskFixture({
        status: "completed",
        quality: "1080p",
        total_bytes: 128_600_000,
        completed_at: "2026-08-16T11:32:00Z",
        file_path: "/tmp/a.mp4",
      }),
      new Date("2026-08-16T12:00:00Z"),
    );
    expect(result.meta).toEqual(expect.arrayContaining(["YouTube", "1080p", "122.6 MB"]));
    expect(result.showProgress).toBe(false);
  });
});
