import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { zhCN, type MessageKey } from "./locales/zh-CN";

const directory = path.dirname(fileURLToPath(import.meta.url));
const settingsSource = readFileSync(
  path.resolve(directory, "SettingsApp.tsx"),
  "utf8",
);
const typesSource = readFileSync(
  path.resolve(directory, "lib/types.ts"),
  "utf8",
);

describe("settings output copy contract", () => {
  it("shows one truthful four-mode subtitle control", () => {
    const copy: Partial<Record<MessageKey, string>> = {
      "settings.subtitles": "字幕",
      "settings.subtitlesNone": "不下载字幕",
      "settings.subtitlesExternal": "保存独立字幕",
      "settings.subtitlesEmbedded": "写入视频",
      "settings.subtitlesBoth": "写入视频并保留独立字幕",
      "settings.subtitleHint": "如 zh-Hans,en（留空则自动选择一个可用字幕）",
    };
    for (const [key, value] of Object.entries(copy)) {
      expect(settingsSource).toContain(`t("${key}", locale)`);
      expect(zhCN[key as MessageKey]).toBe(value);
    }
    expect(settingsSource).not.toContain("<span>下载字幕</span>");
    expect(settingsSource).not.toContain("<span>内嵌字幕</span>");
  });

  it("explains the MP3 fallback and media information boundary", () => {
    expect(settingsSource).toContain('t("settings.mp3Subtitles", locale)');
    expect(zhCN["settings.mp3Subtitles"]).toBe(
      "MP3 不支持写入字幕，将保存为独立字幕文件",
    );
    expect(settingsSource).toContain('t("settings.metadata", locale)');
    expect(settingsSource).toContain('t("settings.metadataHint", locale)');
    expect(zhCN["settings.metadata"]).toBe("写入媒体信息");
    expect(zhCN["settings.metadataHint"]).toBe("来源提供时写入标题、封面和章节");
  });

  it("hides unsupported controls without deleting persisted legacy fields", () => {
    expect(settingsSource).not.toContain("<span>片段裁剪</span>");
    expect(settingsSource).not.toContain("<span>SponsorBlock 去除</span>");
    expect(typesSource).toContain("download_sections?: string;");
    expect(typesSource).toContain("sponsorblock_remove?: string;");
  });
});
