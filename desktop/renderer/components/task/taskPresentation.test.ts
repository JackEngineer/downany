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

  it.each([
    ["need_login", "需要登录后才能下载，请选择浏览器登录状态后重试"],
    ["private", "此内容为私密内容，请登录有访问权限的账号后重试"],
    ["geo_blocked", "此内容在当前地区不可用，请检查网络设置后重试"],
    ["network", "网络连接失败，请检查网络或代理后重试"],
    ["ytdlp_outdated", "下载工具需要更新，更新后即可重试"],
    ["need_po_token", "页面需要额外验证，请改用网页识别"],
    ["unsupported", "暂不支持直接下载此页面，请改用网页识别"],
    ["removed", "此内容已被删除或不可用"],
    ["output_path_invalid", "下载位置或文件名不可用，请检查下载位置和命名设置"],
    ["media_tools_missing", "媒体工具不完整，请重新安装 Downany"],
    ["output_verification_failed", "成品无法验证，请导出诊断后重试"],
    ["unexpected_code", "下载未完成，请重试或改用网页识别"],
  ] as const)("uses a safe recovery message for %s", (errorCode, detail) => {
    const raw = "ERROR Cookie: secret-token C:\\Users\\private\\response.json";
    const result = presentTask(
      taskFixture({
        status: "failed",
        error_code: errorCode,
        error_message: raw,
      }),
    );

    expect(result.detail).toBe(detail);
    expect(result.detail).not.toContain("secret-token");
  });

  it("does not offer a blind retry for removed content", () => {
    expect(
      presentTask(
        taskFixture({ status: "failed", error_code: "removed" }),
      ),
    ).toMatchObject({ primaryAction: null, primaryLabel: "" });
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

  it("shows the persisted completion note for a completed task", () => {
    const raw = "https://secret.invalid token C:\\Users\\private\\probe.json";
    const result = presentTask(
      taskFixture({
        status: "completed",
        file_path: "/tmp/a.mp4",
        completion_note: "未找到所选语言字幕",
        error_message: raw,
      }),
    );

    expect(result.detail).toBe("未找到所选语言字幕");
    expect(result.detail).not.toContain("secret.invalid");
    expect(result.detail).not.toContain("private");
  });
});
