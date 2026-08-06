import { BrowserWindow } from "electron";
import * as path from "node:path";

import { windowChromeOptions } from "./windowChrome";

let settingsWindow: BrowserWindow | null = null;

export function openSettingsWindow(preloadPath: string): BrowserWindow {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
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
    void settingsWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}settings.html`);
  } else {
    void settingsWindow.loadFile(path.join(__dirname, "../dist/settings.html"));
  }

  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
  return settingsWindow;
}

export function getSettingsWindow(): BrowserWindow | null {
  return settingsWindow;
}
