import type { BrowserWindowConstructorOptions } from "electron";

type WindowChromeOptions = Pick<
  BrowserWindowConstructorOptions,
  "titleBarStyle" | "vibrancy" | "transparent" | "frame"
>;

export const MAIN_WINDOW_GEOMETRY = {
  width: 1120,
  height: 760,
  minWidth: 760,
  minHeight: 560,
} as const;

export function windowChromeOptions(
  platform: NodeJS.Platform = process.platform,
): WindowChromeOptions {
  if (platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset",
      vibrancy: "under-window",
      transparent: true,
    };
  }
  return {
    frame: true,
    transparent: false,
  };
}
