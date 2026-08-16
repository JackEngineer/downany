import { describe, expect, it } from "vitest";

import { MAIN_WINDOW_GEOMETRY, windowChromeOptions } from "./windowChrome";

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
    });
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
