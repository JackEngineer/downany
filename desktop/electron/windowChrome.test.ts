import { describe, expect, it, vi } from "vitest";

import {
  DARK_WINDOW_BACKGROUND,
  LIGHT_WINDOW_BACKGROUND,
  MAIN_WINDOW_GEOMETRY,
  resolveWindowBackground,
  syncWindowBackgrounds,
  windowChromeOptions,
} from "./windowChrome";

describe("window chrome contract", () => {
  it("uses hidden inset vibrancy on macOS", () => {
    expect(windowChromeOptions("darwin")).toEqual({
      titleBarStyle: "hiddenInset",
      vibrancy: "under-window",
      transparent: true,
    });
  });

  it("keeps the native Windows frame", () => {
    expect(windowChromeOptions("win32")).toEqual({
      frame: true,
      transparent: false,
      backgroundColor: DARK_WINDOW_BACKGROUND,
    });
  });

  it("keeps macOS vibrancy transparent while giving solid platforms a dark first frame", () => {
    expect(windowChromeOptions("darwin")).not.toHaveProperty("backgroundColor");
    expect(windowChromeOptions("linux")).toMatchObject({
      transparent: false,
      backgroundColor: DARK_WINDOW_BACKGROUND,
    });
  });

  it.each([
    ["dark", false, DARK_WINDOW_BACKGROUND],
    ["light", true, LIGHT_WINDOW_BACKGROUND],
    ["system", true, DARK_WINDOW_BACKGROUND],
    ["system", false, LIGHT_WINDOW_BACKGROUND],
  ] as const)("resolves %s against native dark=%s", (source, nativeDark, expected) => {
    expect(resolveWindowBackground(source, nativeDark)).toBe(expected);
  });

  it("synchronizes every solid window but preserves macOS transparent material", () => {
    const first = { setBackgroundColor: vi.fn() };
    const second = { setBackgroundColor: vi.fn() };

    syncWindowBackgrounds([first, second], "light", true, "win32");
    expect(first.setBackgroundColor).toHaveBeenCalledWith(LIGHT_WINDOW_BACKGROUND);
    expect(second.setBackgroundColor).toHaveBeenCalledWith(LIGHT_WINDOW_BACKGROUND);

    syncWindowBackgrounds([first, second], "dark", true, "darwin");
    expect(first.setBackgroundColor).toHaveBeenCalledTimes(1);
    expect(second.setBackgroundColor).toHaveBeenCalledTimes(1);
  });

  it("publishes approved main-window geometry", () => {
    expect(MAIN_WINDOW_GEOMETRY).toEqual({
      width: 1120,
      height: 760,
      minWidth: 760,
      minHeight: 560,
    });
  });
});
