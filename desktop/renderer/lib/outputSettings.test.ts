import { describe, expect, it } from "vitest";

import {
  subtitleModeFromSettings,
  subtitleModePatch,
} from "./outputSettings";

describe("subtitle output settings", () => {
  it.each([
    [{ download_subtitles: false, embed_subs: false }, "none"],
    [{ download_subtitles: true, embed_subs: false }, "external"],
    [{ download_subtitles: false, embed_subs: true }, "embedded"],
    [{ download_subtitles: true, embed_subs: true }, "both"],
  ] as const)("maps persisted subtitle booleans", (settings, mode) => {
    expect(subtitleModeFromSettings(settings)).toBe(mode);
    expect(subtitleModeFromSettings(subtitleModePatch(mode))).toBe(mode);
  });
});
