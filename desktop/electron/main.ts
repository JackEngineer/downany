import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  Notification,
  nativeTheme,
  shell,
} from "electron";
import * as fs from "node:fs";
import * as path from "node:path";

import type * as http from "node:http";

import {
  BRIDGE_HOST,
  BRIDGE_PORT,
  startBridgeServer,
  type BridgeEnqueueItem,
  type BridgeEnqueueResult,
} from "./bridgeServer";
import { ClipboardWatcher, extractUrlsFromText } from "./clipboardWatcher";
import {
  PROTOCOL_SCHEME,
  extractUrlsFromArgv,
  parseDeepLinkCandidate,
} from "./deepLink";
import { buildAppMenu } from "./menu";
import { ConnectionState } from "./protocol";
import { SidecarProcess, resolveRepoRoot } from "./sidecar";
import { openSettingsWindow } from "./settingsWindow";
import { TaskTracker } from "./taskTracker";
import { TrayController } from "./tray";
import { parseWeblocUrl } from "./webloc";
import {
  loadWindowState,
  sanitizeBounds,
  saveWindowState,
} from "./windowState";

let mainWindow: BrowserWindow | null = null;
let sidecar: SidecarProcess | null = null;
let saveStateTimer: NodeJS.Timeout | null = null;
let sidecarReady = false;
let bridgeServer: http.Server | null = null;
let menuBarMode = false;
let isQuitting = false;
const pendingEnqueueItems: BridgeEnqueueItem[] = [];

const taskTracker = new TaskTracker();
const clipboardWatcher = new ClipboardWatcher((urls) => {
  enqueueFromExternal(urls);
});

const tray = new TrayController({
  onShowWindow: () => {
    if (!mainWindow) {
      createWindow();
    }
    focusMainWindow();
  },
  onAddFromClipboard: () => {
    const urls = extractUrlsFromText(clipboard.readText());
    if (urls.length > 0) enqueueFromExternal(urls);
  },
  onPauseAll: () => void sidecar?.request("download.pauseAll", {}),
  onResumeAll: () => void sidecar?.request("download.resumeAll", {}),
  onFocusTask: (taskId) => {
    if (!mainWindow) {
      createWindow();
    }
    focusMainWindow();
    mainWindow?.webContents.send("app:highlightTask", taskId);
  },
  onQuit: () => app.quit(),
});

function focusMainWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

function registerProtocolClient(): void {
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(PROTOCOL_SCHEME, process.execPath, [
        path.resolve(process.argv[1]),
      ]);
    }
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL_SCHEME);
  }
}

function dedupeItems(items: BridgeEnqueueItem[]): BridgeEnqueueItem[] {
  const unique: BridgeEnqueueItem[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const url = (item.url || "").trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    unique.push({
      url,
      ...(item.title ? { title: item.title } : {}),
      ...(item.headers ? { headers: item.headers } : {}),
    });
  }
  return unique;
}

function urlsFromItems(items: BridgeEnqueueItem[]): string[] {
  return items.map((item) => item.url);
}

function enqueueFromExternal(urls: string[]): void {
  const items = dedupeItems(urls.map((url) => ({ url })));
  if (items.length === 0) return;

  if (!sidecarReady || !sidecar) {
    for (const item of items) {
      if (!pendingEnqueueItems.some((p) => p.url === item.url)) {
        pendingEnqueueItems.push(item);
      }
    }
    return;
  }

  void flushEnqueueItems(items);
}

async function flushEnqueueItems(
  items: BridgeEnqueueItem[],
): Promise<BridgeEnqueueResult> {
  if (!sidecar || items.length === 0) {
    return { ok: false, error: "下载服务未就绪" };
  }
  focusMainWindow();
  const urls = urlsFromItems(items);
  try {
    await sidecar.request("download.createTasks", {
      urls,
      items: items.map((item) => ({
        url: item.url,
        title: item.title || undefined,
        headers: item.headers || undefined,
      })),
    });
    mainWindow?.webContents.send("app:navigate", "queue");
    mainWindow?.webContents.send("app:externalEnqueue", {
      count: items.length,
      urls,
    });
    void refreshDockFromSnapshot();
    return { ok: true, count: items.length };
  } catch (err) {
    process.stderr.write(`外部入队失败: ${String(err)}\n`);
    mainWindow?.webContents.send("app:externalEnqueue", {
      count: 0,
      urls,
      error: String(err),
    });
    return { ok: false, error: String(err), count: 0 };
  }
}

async function enqueueFromBridge(
  items: BridgeEnqueueItem[],
): Promise<BridgeEnqueueResult> {
  const unique = dedupeItems(items);
  if (unique.length === 0) {
    return { ok: false, error: "没有有效的 URL" };
  }
  if (!sidecarReady || !sidecar) {
    for (const item of unique) {
      if (!pendingEnqueueItems.some((p) => p.url === item.url)) {
        pendingEnqueueItems.push(item);
      }
    }
    focusMainWindow();
    return { ok: true, count: unique.length };
  }
  return flushEnqueueItems(unique);
}

async function flushPendingEnqueue(): Promise<void> {
  if (pendingEnqueueItems.length === 0) return;
  const items = pendingEnqueueItems.splice(0, pendingEnqueueItems.length);
  await flushEnqueueItems(items);
}

function startBridge(): void {
  if (bridgeServer) return;
  try {
    bridgeServer = startBridgeServer({ enqueue: enqueueFromBridge });
    process.stderr.write(
      `扩展桥已监听 http://${BRIDGE_HOST}:${BRIDGE_PORT}/enqueue\n`,
    );
  } catch (err) {
    process.stderr.write(`扩展桥启动失败: ${String(err)}\n`);
  }
}

function stopBridge(): void {
  if (!bridgeServer) return;
  bridgeServer.close();
  bridgeServer = null;
}

function handleDeepLinkRaw(raw: string): void {
  const url = parseDeepLinkCandidate(raw);
  if (url) enqueueFromExternal([url]);
}

function handleArgv(argv: readonly string[]): void {
  const urls = extractUrlsFromArgv(argv);
  if (urls.length > 0) enqueueFromExternal(urls);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, commandLine) => {
    focusMainWindow();
    handleArgv(commandLine);
  });
}

// macOS：协议打开（可早于 ready）
app.on("open-url", (event, url) => {
  event.preventDefault();
  handleDeepLinkRaw(url);
});

// macOS：拖到 Dock 图标的 .webloc / URL 文件
app.on("open-file", (event, filePath) => {
  event.preventDefault();
  try {
    if (filePath.toLowerCase().endsWith(".webloc")) {
      const content = fs.readFileSync(filePath, "utf-8");
      const url = parseWeblocUrl(content);
      if (url) {
        focusMainWindow();
        enqueueFromExternal([url]);
      }
    } else {
      process.stderr.write(`open-file 收到未支持的文件: ${filePath}\n`);
    }
  } catch (err) {
    process.stderr.write(`open-file 处理失败: ${String(err)}\n`);
  }
});

registerProtocolClient();
// 冷启动：部分平台把协议 URL 放在 argv
handleArgv(process.argv);

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
    minWidth: 720,
    minHeight: 480,
    title: "视频下载器",
    show: false,
    titleBarStyle: "hiddenInset",
    vibrancy: "under-window",
    transparent: true,
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
  mainWindow.on("close", (event) => {
    // 菜单栏模式：关闭主窗口只隐藏，应用继续驻留
    if (menuBarMode && !isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
      return;
    }
    if (mainWindow) saveWindowState(mainWindow);
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function broadcastState(state: ConnectionState): void {
  broadcastAll("sidecar:state", state);
}

function broadcastAll(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, ...args);
  }
}

function showSettingsWindow(): void {
  openSettingsWindow(path.join(__dirname, "preload.js"));
}

function isWindowFocused(): boolean {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused());
}

function notifyTaskResult(kind: "completed" | "failed", title: string, taskId: string): void {
  if (isWindowFocused()) return;
  if (!Notification.isSupported()) return;
  const n = new Notification({
    title: kind === "completed" ? "下载完成" : "下载失败",
    body: title || "任务已更新",
    ...(kind === "failed" ? { actions: [{ type: "button" as const, text: "重试" }] } : {}),
  });
  n.on("click", () => {
    focusMainWindow();
    mainWindow?.webContents.send("app:highlightTask", taskId);
  });
  if (kind === "failed") {
    n.on("action", () => {
      void sidecar?.request("download.retry", { taskId });
      focusMainWindow();
      mainWindow?.webContents.send("app:highlightTask", taskId);
    });
  }
  n.show();
}

let dockProgressEnabled = true;

/** 由 TaskTracker 驱动 Dock 角标 + 进度条 + 托盘菜单（进度事件频繁时跳过菜单重建）。 */
function updateDockUi(rebuildMenu = true): void {
  const active = taskTracker.activeCount();
  if (process.platform === "darwin" && app.dock) {
    app.dock.setBadge(active > 0 ? String(active) : "");
  }
  mainWindow?.setProgressBar(
    dockProgressEnabled ? taskTracker.aggregateProgress() : -1,
  );
  if (rebuildMenu && tray.enabled) {
    tray.update(active, taskTracker.recent());
  }
}

function syncMenuBarMode(enabled: boolean): void {
  menuBarMode = enabled;
  if (process.platform !== "darwin") return;
  if (enabled) {
    tray.enable();
    tray.update(taskTracker.activeCount(), taskTracker.recent());
    app.dock.hide();
  } else {
    tray.disable();
    app.dock.show();
  }
}

async function refreshDockFromSnapshot(): Promise<void> {
  if (!sidecar) return;
  try {
    const snap = (await sidecar.request("app.getSnapshot", {})) as {
      tasks?: Array<{ id?: string; title?: string; status?: string; progress?: number }>;
    };
    taskTracker.hydrate(snap.tasks || []);
    updateDockUi();
  } catch {
    // ignore
  }
}

function installMenu(): void {
  const menu = buildAppMenu(() => mainWindow, showSettingsWindow);
  Menu.setApplicationMenu(menu);
}

function syncClipboardWatcher(enabled: boolean): void {
  if (enabled) {
    clipboardWatcher.start();
  } else {
    clipboardWatcher.stop();
  }
}

async function startSidecar(): Promise<void> {
  const repoRoot = resolveRepoRoot(__dirname);
  sidecar = new SidecarProcess({ repoRoot });
  sidecar.on("state", (state: ConnectionState) => broadcastState(state));
  sidecar.on("event", (event: { event: string; payload: Record<string, unknown> }) => {
    broadcastAll("sidecar:event", event);
    const name = event.event;
    if (name === "settings.changed") {
      const settings = event.payload.settings as
        | { clipboard_monitor?: boolean; menu_bar_mode?: boolean; dock_progress?: boolean }
        | undefined;
      syncClipboardWatcher(Boolean(settings?.clipboard_monitor));
      syncMenuBarMode(Boolean(settings?.menu_bar_mode));
      dockProgressEnabled = settings?.dock_progress !== false;
      updateDockUi(false);
    }
    if (
      name === "task.added" ||
      name === "task.updated" ||
      name === "task.completed" ||
      name === "task.failed" ||
      name === "task.removed"
    ) {
      taskTracker.applyEvent(event);
      updateDockUi();
    } else if (name === "task.progress") {
      taskTracker.applyEvent(event);
      updateDockUi(false);
    }
    if (name === "task.completed" || name === "task.failed") {
      const task = event.payload.task as { title?: string } | undefined;
      const title = task?.title || String(event.payload.taskId || "");
      notifyTaskResult(
        name === "task.completed" ? "completed" : "failed",
        title,
        String(event.payload.taskId || ""),
      );
    }
  });
  sidecar.on("log", (chunk: string) => {
    process.stderr.write(chunk);
  });
  sidecar.on("reconnected", () => {
    void sidecar?.request("app.getSnapshot", {}).then((snap) => {
      broadcastAll("sidecar:event", {
        event: "sidecar.health",
        payload: { snapshot: snap },
      });
      void refreshDockFromSnapshot();
    });
  });
  await sidecar.start();
  sidecarReady = true;
  void refreshDockFromSnapshot();
  await flushPendingEnqueue();

  try {
    const snap = (await sidecar.request("app.getSnapshot", {})) as {
      settings?: { clipboard_monitor?: boolean; menu_bar_mode?: boolean; dock_progress?: boolean };
      tasks?: Array<{ id?: string; title?: string; status?: string; progress?: number }>;
    };
    taskTracker.hydrate(snap.tasks || []);
    dockProgressEnabled = snap.settings?.dock_progress !== false;
    updateDockUi();
    syncClipboardWatcher(Boolean(snap.settings?.clipboard_monitor));
    syncMenuBarMode(Boolean(snap.settings?.menu_bar_mode));
  } catch {
    // ignore
  }

  // 显式再拉一次迁移状态，供设置窗口展示（服务端启动时已跑过，通常为 skipped）
  try {
    const migration = await sidecar.request("app.runMigration", {});
    broadcastAll("app:migration", migration);
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

  ipcMain.handle("app:setThemeSource", async (_evt, mode: string) => {
    if (mode === "system" || mode === "light" || mode === "dark") {
      nativeTheme.themeSource = mode;
    }
  });

  ipcMain.handle("app:openSettings", async () => {
    showSettingsWindow();
  });

  ipcMain.handle("app:readClipboard", async () => {
    return clipboard.readText();
  });

  ipcMain.handle("app:quit", async () => {
    app.quit();
  });
}

app.whenReady().then(async () => {
  registerIpc();
  installMenu();
  createWindow();
  startBridge();

  nativeTheme.on("updated", () => {
    broadcastAll(
      "app:nativeTheme",
      nativeTheme.shouldUseDarkColors ? "dark" : "light",
    );
  });

  try {
    await startSidecar();
  } catch (err) {
    process.stderr.write(`Sidecar 启动失败: ${String(err)}\n`);
    sidecarReady = false;
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
  isQuitting = true;
  if (mainWindow) saveWindowState(mainWindow);
  sidecarReady = false;
  clipboardWatcher.stop();
  tray.disable();
  stopBridge();
  void sidecar?.stop();
});
