import type { BrowserWindowConstructorOptions } from "electron";

type WindowChromeOptions = Pick<
  BrowserWindowConstructorOptions,
  "titleBarStyle" | "vibrancy" | "transparent" | "frame"
>;

export function windowChromeOptions(): WindowChromeOptions {
  if (process.platform === "darwin") {
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
