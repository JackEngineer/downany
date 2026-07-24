import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
} from "electron";
import * as path from "node:path";

import { ConnectionState } from "./protocol";
import { SidecarProcess, resolveRepoRoot } from "./sidecar";

let mainWindow: BrowserWindow | null = null;
let sidecar: SidecarProcess | null = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 800,
    minHeight: 560,
    title: "视频下载器",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function broadcastState(state: ConnectionState): void {
  mainWindow?.webContents.send("sidecar:state", state);
}

async function startSidecar(): Promise<void> {
  const repoRoot = resolveRepoRoot(__dirname);
  sidecar = new SidecarProcess({ repoRoot });
  sidecar.on("state", (state: ConnectionState) => broadcastState(state));
  sidecar.on("event", (event) => {
    mainWindow?.webContents.send("sidecar:event", event);
  });
  sidecar.on("log", (chunk: string) => {
    process.stderr.write(chunk);
  });
  sidecar.on("reconnected", () => {
    void sidecar?.request("app.getSnapshot", {}).then((snap) => {
      mainWindow?.webContents.send("sidecar:event", {
        event: "sidecar.health",
        payload: { snapshot: snap },
      });
    });
  });
  await sidecar.start();
}

function registerIpc(): void {
  ipcMain.handle("sidecar:request", async (_evt, method: string, payload: unknown) => {
    if (!sidecar) {
      throw new Error("Sidecar 未启动");
    }
    return sidecar.request(method, (payload as Record<string, unknown>) || {});
  });

  ipcMain.handle("sidecar:getState", async () => {
    return sidecar?.getConnectionState() ?? "disconnected";
  });

  ipcMain.handle("sidecar:getLogDir", async () => {
    const home = app.getPath("home");
    return path.join(home, "Library", "Logs", "VideoDownloader");
  });

  ipcMain.handle("app:openPath", async (_evt, target: string) => {
    return shell.openPath(target);
  });

  ipcMain.handle("app:showItemInFolder", async (_evt, target: string) => {
    shell.showItemInFolder(target);
  });

  ipcMain.handle("app:selectDirectory", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle("app:quit", async () => {
    app.quit();
  });
}

app.whenReady().then(async () => {
  registerIpc();
  createWindow();
  try {
    await startSidecar();
  } catch (err) {
    process.stderr.write(`Sidecar 启动失败: ${String(err)}\n`);
    broadcastState("failed");
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on("before-quit", () => {
  void sidecar?.stop();
});
