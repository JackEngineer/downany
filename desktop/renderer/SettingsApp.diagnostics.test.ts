import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const source = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "SettingsApp.tsx"),
  "utf8",
);

describe("settings diagnostics copy contract", () => {
  it("explains the useful contents and the privacy boundary before export", () => {
    expect(source).toContain(
      "诊断包只包含应用版本、系统环境、错误类型和日志数量；不会包含下载链接、内容标题、日志正文或账号信息。",
    );
    expect(source).not.toContain("导出日志、yt-dlp / ffmpeg 版本与失败任务摘要");
  });

  it("shows a stable retry action without rendering the internal exception", () => {
    expect(source).toContain('title: "诊断包导出失败，请稍后重试。"');
    expect(source).not.toContain("`导出失败：${String(err)}`");
  });
});
