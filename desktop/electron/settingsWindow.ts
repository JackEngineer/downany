import { BrowserWindow, nativeTheme } from "electron";
import * as path from "node:path";

import {
  resolveWindowBackground,
  windowChromeOptions,
  type WindowThemeSource,
} from "./windowChrome";
import type { SettingsFocus } from "./preload";

let settingsWindow: BrowserWindow | null = null;

export function openSettingsWindow(
  preloadPath: string,
  focus?: SettingsFocus,
): BrowserWindow {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    if (focus) settingsWindow.webContents.send("app:settingsFocus", focus);
    return settingsWindow;
  }

  settingsWindow = new BrowserWindow({
    width: 640,
    height: 660,
    minWidth: 540,
    minHeight: 480,
    title: "设置",
    show: false,
    ...windowChromeOptions(),
    ...(process.platform === "darwin"
      ? {}
      : {
          backgroundColor: resolveWindowBackground(
            nativeTheme.themeSource as WindowThemeSource,
            nativeTheme.shouldUseDarkColors,
          ),
        }),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  settingsWindow.once("ready-to-show", () => {
    settingsWindow?.show();
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    const url = new URL("settings.html", process.env.VITE_DEV_SERVER_URL);
    if (focus) url.searchParams.set("focus", focus);
    void settingsWindow.loadURL(url.toString());
  } else {
    void settingsWindow.loadFile(path.join(__dirname, "../dist/settings.html"), {
      query: focus ? { focus } : undefined,
    });
  }

  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
  return settingsWindow;
}

export function getSettingsWindow(): BrowserWindow | null {
  return settingsWindow;
}
