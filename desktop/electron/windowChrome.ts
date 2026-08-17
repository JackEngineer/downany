import type { BrowserWindowConstructorOptions } from "electron";

type WindowChromeOptions = Pick<
  BrowserWindowConstructorOptions,
  "titleBarStyle" | "vibrancy" | "transparent" | "frame" | "backgroundColor"
>;

export type WindowThemeSource = "light" | "dark" | "system";

export interface WindowBackgroundTarget {
  setBackgroundColor(color: string): void;
}

export const DARK_WINDOW_BACKGROUND = "#0b0d10";
export const LIGHT_WINDOW_BACKGROUND = "#f2f3f5";

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
    backgroundColor: DARK_WINDOW_BACKGROUND,
  };
}

export function resolveWindowBackground(
  source: WindowThemeSource,
  nativeDark: boolean,
): string {
  const dark = source === "dark" || (source === "system" && nativeDark);
  return dark ? DARK_WINDOW_BACKGROUND : LIGHT_WINDOW_BACKGROUND;
}

export function syncWindowBackgrounds(
  windows: readonly WindowBackgroundTarget[],
  source: WindowThemeSource,
  nativeDark: boolean,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === "darwin") return;
  const background = resolveWindowBackground(source, nativeDark);
  for (const window of windows) {
    window.setBackgroundColor(background);
  }
}
