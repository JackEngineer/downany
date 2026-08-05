import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  Notification,
  nativeTheme,
  net,
  protocol,
  session,
  shell,
} from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import type * as http from "node:http";

  import {
  BRIDGE_HOST,
  BRIDGE_PORT,
  startBridgeServer,
  type BridgeEnqueueItem,
  type BridgeEnqueueResult,
  type BridgeTaskStatus,
} from "./bridgeServer";
import { ClipboardWatcher, extractUrlsFromText } from "./clipboardWatcher";
import {
  PROTOCOL_SCHEME,
  extractAddsFromArgv,
  isOpenDeepLink,
  parseDeepLinkAdd,
  type DeepLinkAddPayload,
} from "./deepLink";
import {
  decideBridgeEnqueue,
  isSidecarAcceptingEnqueue,
} from "./enqueueGate";
import { buildAppMenu } from "./menu";
import { ConnectionState } from "./protocol";
import { SidecarProcess, resolveRepoRoot } from "./sidecar";
import { openSettingsWindow } from "./settingsWindow";
import { TaskTracker } from "./taskTracker";
import { TrayController } from "./tray";
import { parseWeblocUrl } from "./webloc";
import { resolveOpenablePath } from "./resolveOpenablePath";
import { patchThumbnailRequestHeaders } from "./thumbnailReferrer";
import {
  loadWindowState,
  sanitizeBounds,
  saveWindowState,
} from "./windowState";
import { checkForAppUpdates } from "./appUpdater";
import { resolveDownanyDataDir, resolveDownanyLogDir } from "./appDataDir";
import {
  buildExtractEnqueueItems,
  getExtractSession,
  openExtractWindow,
} from "./extractWindow";

/** 本地抽帧封面：sidecar 写入 Downany 数据目录 thumbnails/{taskId}.jpg */
const LOCAL_THUMB_SCHEME = "downany-thumb";

protocol.registerSchemesAsPrivileged([
  {
    scheme: LOCAL_THUMB_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      bypassCSP: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);

function downanyDataDir(): string {
  return resolveDownanyDataDir(process.env, process.platform, app.getPath("home"));
}

function installLocalThumbnailProtocol(): void {
  protocol.handle(LOCAL_THUMB_SCHEME, (request) => {
    try {
      const parsed = new URL(request.url);
      const taskId = decodeURIComponent(
        (parsed.hostname || parsed.pathname.replace(/^\/+/, "") || "").trim(),
      );
      if (!taskId || taskId.includes("..") || taskId.includes("/") || taskId.includes("\\")) {
        return new Response("bad request", { status: 400 });
      }
      const filePath = path.join(
        downanyDataDir(),
        "thumbnails",
        `${taskId}.jpg`,
      );
      if (!fs.existsSync(filePath)) {
        return new Response("not found", { status: 404 });
      }
      return net.fetch(pathToFileURL(filePath).href);
    } catch {
      return new Response("error", { status: 500 });
    }
  });
}

function installThumbnailReferrerFix(): void {
  session.defaultSession.webRequest.onBeforeSendHeaders(
    {
      urls: [
        "*://*.phncdn.com/*",
        "*://phncdn.com/*",
        "*://*.xhscdn.com/*",
        "*://xhscdn.com/*",
      ],
    },
    (details, callback) => {
      callback({
        requestHeaders: patchThumbnailRequestHeaders(
          details.url,
          details.requestHeaders as Record<string, string>,
        ),
      });
    },
  );
}

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
  enqueueFromExternal(urls.map((url) => ({ url })));
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
    if (urls.length > 0) enqueueFromExternal(urls.map((url) => ({ url })));
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
      ...(item.quality ? { quality: item.quality } : {}),
      ...(item.audio_only ? { audio_only: item.audio_only } : {}),
      ...(item.download_subtitles ? { download_subtitles: item.download_subtitles } : {}),
      ...(item.pageUrl ? { pageUrl: item.pageUrl } : {}),
      ...(item.thumbnail_url ? { thumbnail_url: item.thumbnail_url } : {}),
    });
  }
  return unique;
}

function urlsFromItems(items: BridgeEnqueueItem[]): string[] {
  return items.map((item) => item.url);
}

function queuePendingItems(items: BridgeEnqueueItem[]): void {
  for (const item of items) {
    if (!pendingEnqueueItems.some((p) => p.url === item.url)) {
      pendingEnqueueItems.push(item);
    }
  }
}

function markSidecarReady(ready: boolean): void {
  sidecarReady = ready;
  if (ready) {
    void flushPendingEnqueue();
  }
}

function payloadToItem(payload: DeepLinkAddPayload): BridgeEnqueueItem {
  return {
    url: payload.url,
    ...(payload.quality ? { quality: payload.quality } : {}),
    ...(payload.audioOnly ? { audio_only: true } : {}),
    ...(payload.downloadSubtitles ? { download_subtitles: true } : {}),
  };
}

function enqueueFromExternal(items: BridgeEnqueueItem[]): void {
  const unique = dedupeItems(items);
  if (unique.length === 0) return;

  if (!sidecarReady || !sidecar) {
    queuePendingItems(unique);
    return;
  }

  void flushEnqueueItems(unique);
}

function extractTaskIds(result: unknown): string[] {
  if (!result || typeof result !== "object") return [];
  const raw = (result as { taskIds?: unknown; task_ids?: unknown }).taskIds
    ?? (result as { task_ids?: unknown }).task_ids;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    .map((id) => id.trim());
}

function trackedToBridgeStatus(t: {
  id: string;
  title: string;
  status: string;
  progress: number;
  errorMessage: string;
}): BridgeTaskStatus {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    progress: t.progress,
    error: t.errorMessage,
  };
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
    const created = await sidecar.request("download.createTasks", {
      urls,
      items: items.map((item) => ({
        url: item.url,
        title: item.title || undefined,
        headers: item.headers || undefined,
        quality: item.quality || undefined,
        audio_only: item.audio_only || undefined,
        download_subtitles: item.download_subtitles || undefined,
        pageUrl: item.pageUrl || undefined,
        thumbnail_url: item.thumbnail_url || undefined,
      })),
    });
    const taskIds = extractTaskIds(created);
    mainWindow?.webContents.send("app:navigate", "queue");
    mainWindow?.webContents.send("app:externalEnqueue", {
      count: items.length,
      urls,
      taskIds,
    });
    await refreshDockFromSnapshot();
    // 快照尚未含新任务时，先种子化 pending，避免扩展立刻 /tasks 得到 unknown
    for (let i = 0; i < taskIds.length; i++) {
      const id = taskIds[i];
      if (taskTracker.getByIds([id])[0]?.status === "unknown") {
        taskTracker.applyEvent({
          event: "task.updated",
          payload: {
            task: {
              id,
              title: items[i]?.title || items[0]?.title || "",
              status: "pending",
              progress: 0,
            },
          },
        });
      }
    }
    return { ok: true, count: items.length, taskIds };
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
  const connected =
    Boolean(sidecar) &&
    isSidecarAcceptingEnqueue(sidecar!.getConnectionState());
  const decision = decideBridgeEnqueue(sidecarReady && connected);
  if (decision.kind === "defer") {
    // 不暂存：扩展会等桥就绪后自行重试，避免与 pending flush 重复入队
    focusMainWindow();
    return { ok: false, error: decision.error, count: 0 };
  }
  return flushEnqueueItems(unique);
}

async function flushPendingEnqueue(): Promise<void> {
  if (pendingEnqueueItems.length === 0) return;
  if (!sidecarReady || !sidecar) return;
  const items = pendingEnqueueItems.splice(0, pendingEnqueueItems.length);
  await flushEnqueueItems(items);
}

  function startBridge(): void {
  if (bridgeServer) return;
  try {
    bridgeServer = startBridgeServer({
      enqueue: enqueueFromBridge,
      getStatus: () => ({
        sidecarReady:
          sidecarReady &&
          Boolean(sidecar) &&
          isSidecarAcceptingEnqueue(sidecar!.getConnectionState()),
      }),
      getTasks: (ids) => taskTracker.getByIds(ids).map(trackedToBridgeStatus),
    });
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
  if (isOpenDeepLink(raw)) {
    if (mainWindow) {
      focusMainWindow();
    } else if (app.isReady()) {
      createWindow();
      focusMainWindow();
    }
    // ready 之前由 open-url 触发：whenReady 里 createWindow 即可
    return;
  }
  const payload = parseDeepLinkAdd(raw);
  if (payload) enqueueFromExternal([payloadToItem(payload)]);
}

function handleArgv(argv: readonly string[]): void {
  for (const arg of argv) {
    if (isOpenDeepLink(arg)) {
      if (mainWindow) focusMainWindow();
      break;
    }
  }
  const adds = extractAddsFromArgv(argv);
  if (adds.length > 0) enqueueFromExternal(adds.map(payloadToItem));
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
        enqueueFromExternal([{ url }]);
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
    title: "百纳",
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
  sidecar.on("state", (state: ConnectionState) => {
    broadcastState(state);
    // 与真实连接态同步：重连成功后自动冲刷 pending；失联后拒收假成功
    if (isSidecarAcceptingEnqueue(state)) {
      markSidecarReady(true);
    } else if (!isQuitting) {
      sidecarReady = false;
    }
  });
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
    markSidecarReady(true);
    void sidecar?.request("app.getSnapshot", {}).then((snap) => {
      broadcastAll("sidecar:event", {
        event: "sidecar.health",
        payload: { snapshot: snap },
      });
      void refreshDockFromSnapshot();
    });
  });
  await sidecar.start();
  markSidecarReady(true);
  void refreshDockFromSnapshot();

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
    return resolveDownanyLogDir(process.env, process.platform, app.getPath("home"));
  });

  ipcMain.handle("app:openPath", async (_evt, target: string) => {
    return shell.openPath(resolveOpenablePath(String(target || "")));
  });

  ipcMain.handle("app:showItemInFolder", async (_evt, target: string) => {
    shell.showItemInFolder(resolveOpenablePath(String(target || "")));
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

  ipcMain.handle("app:checkUpdate", async () => {
    return checkForAppUpdates(app.getVersion());
  });

  ipcMain.handle("app:openExternal", async (_evt, target: string) => {
    const url = String(target || "").trim();
    if (!/^https?:\/\//i.test(url)) {
      throw new Error("仅允许打开 http(s) 链接");
    }
    await shell.openExternal(url);
  });

  ipcMain.handle("app:openExtractWindow", async (_evt, url: string) => {
    openExtractWindow(String(url || ""));
  });

  ipcMain.handle(
    "app:showTaskContextMenu",
    async (
      evt,
      template: Array<{ id: string; label: string; enabled?: boolean; type?: string }>,
    ) => {
      const win = BrowserWindow.fromWebContents(evt.sender);
      return new Promise<string | null>((resolve) => {
        let settled = false;
        const finish = (id: string | null) => {
          if (settled) return;
          settled = true;
          resolve(id);
        };
        const built = (template || []).map((item) => {
          if (item.type === "separator") {
            return { type: "separator" as const };
          }
          return {
            label: item.label,
            enabled: item.enabled !== false,
            click: () => finish(item.id),
          };
        });
        const menu = Menu.buildFromTemplate(built);
        menu.popup({
          window: win ?? undefined,
          callback: () => finish(null),
        });
      });
    },
  );

  ipcMain.handle(
    "extract:enqueue",
    async (_evt, payload: { items?: Array<{ url: string; title?: string }> }) => {
      const items = Array.isArray(payload?.items) ? payload.items : [];
      if (items.length === 0) {
        return { ok: false, error: "未选择媒体", count: 0 };
      }
      const ses = getExtractSession();
      const bridgeItems = await buildExtractEnqueueItems(ses, items);
      return flushEnqueueItems(bridgeItems);
    },
  );
}

app.whenReady().then(async () => {
  installLocalThumbnailProtocol();
  installThumbnailReferrerFix();
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
