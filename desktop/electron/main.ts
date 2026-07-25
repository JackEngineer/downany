import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  nativeTheme,
  shell,
} from "electron";
import * as path from "node:path";

import { buildAppMenu } from "./menu";
import { ConnectionState } from "./protocol";
import { SidecarProcess, resolveRepoRoot } from "./sidecar";
import {
  loadWindowState,
  sanitizeBounds,
  saveWindowState,
} from "./windowState";

let mainWindow: BrowserWindow | null = null;
let sidecar: SidecarProcess | null = null;
let saveStateTimer: NodeJS.Timeout | null = null;

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

function scheduleSaveWindowState(): void {
  if (!mainWindow) return;
  if (saveStateTimer) clearTimeout(saveStateTimer);
  saveStateTimer = setTimeout(() => {
    if (mainWindow) saveWindowState(mainWindow);
  }, 400);
}

function createWindow(): void {
  const raw = loadWindowState();
  const state = sanitizeBounds(raw);

  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 800,
    minHeight: 560,
    title: "视频下载器",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (state.isMaximized) {
    mainWindow.maximize();
  }

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  mainWindow.on("resize", scheduleSaveWindowState);
  mainWindow.on("move", scheduleSaveWindowState);
  mainWindow.on("close", () => {
    if (mainWindow) saveWindowState(mainWindow);
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function broadcastState(state: ConnectionState): void {
  mainWindow?.webContents.send("sidecar:state", state);
}

function isWindowFocused(): boolean {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused());
}

function notifyTaskResult(kind: "completed" | "failed", title: string): void {
  if (isWindowFocused()) return;
  if (!Notification.isSupported()) return;
  const n = new Notification({
    title: kind === "completed" ? "下载完成" : "下载失败",
    body: title || "任务已更新",
  });
  n.on("click", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      mainWindow.webContents.send("app:navigate", "queue");
    }
  });
  n.show();
}

function updateDockBadge(count: number): void {
  if (process.platform === "darwin" && app.dock) {
    app.dock.setBadge(count > 0 ? String(count) : "");
  }
}

async function refreshDockFromSnapshot(): Promise<void> {
  if (!sidecar) return;
  try {
    const snap = (await sidecar.request("app.getSnapshot", {})) as {
      tasks?: Array<{ status?: string }>;
    };
    const active = (snap.tasks || []).filter(
      (t) => t.status === "downloading" || t.status === "pending",
    ).length;
    updateDockBadge(active);
  } catch {
    // ignore
  }
}

function installMenu(): void {
  const menu = buildAppMenu(() => mainWindow);
  Menu.setApplicationMenu(menu);
}

async function startSidecar(): Promise<void> {
  const repoRoot = resolveRepoRoot(__dirname);
  sidecar = new SidecarProcess({ repoRoot });
  sidecar.on("state", (state: ConnectionState) => broadcastState(state));
  sidecar.on("event", (event: { event: string; payload: Record<string, unknown> }) => {
    mainWindow?.webContents.send("sidecar:event", event);
    const name = event.event;
    if (name === "task.completed" || name === "task.failed") {
      const task = event.payload.task as { title?: string } | undefined;
      const title = task?.title || String(event.payload.taskId || "");
      notifyTaskResult(name === "task.completed" ? "completed" : "failed", title);
    }
    if (
      name === "task.added" ||
      name === "task.updated" ||
      name === "task.completed" ||
      name === "task.failed" ||
      name === "task.removed" ||
      name === "task.progress"
    ) {
      void refreshDockFromSnapshot();
    }
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
      void refreshDockFromSnapshot();
    });
  });
  await sidecar.start();
  void refreshDockFromSnapshot();

  // 显式再拉一次迁移状态，供设置页展示（服务端启动时已跑过，通常为 skipped）
  try {
    const migration = await sidecar.request("app.runMigration", {});
    mainWindow?.webContents.send("app:migration", migration);
  } catch (err) {
    process.stderr.write(`迁移查询失败: ${String(err)}\n`);
  }
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

  ipcMain.handle("app:getNativeTheme", async () => {
    return nativeTheme.shouldUseDarkColors ? "dark" : "light";
  });

  ipcMain.handle("app:quit", async () => {
    app.quit();
  });
}

app.whenReady().then(async () => {
  registerIpc();
  installMenu();
  createWindow();

  nativeTheme.on("updated", () => {
    mainWindow?.webContents.send(
      "app:nativeTheme",
      nativeTheme.shouldUseDarkColors ? "dark" : "light",
    );
  });

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
  if (mainWindow) saveWindowState(mainWindow);
  void sidecar?.stop();
});
