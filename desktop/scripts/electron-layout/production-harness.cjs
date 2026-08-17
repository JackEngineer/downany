const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { app, BrowserWindow, ipcMain } = require("electron");

const { runBestEffortCleanup } = require("./cleanup.cjs");
const { createFixtureSnapshot } = require("./fixture.cjs");

const HANDLERS = [
  "layout-fixture:request",
  "layout-fixture:getConnectionState",
  "layout-fixture:getLogDir",
  "layout-fixture:getNativeTheme",
  "layout-fixture:noop",
];

function createProductionLayoutHarness() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "downany-layout-"));
  const originalUserData = app.getPath("userData");
  const snapshot = createFixtureSnapshot(tempDir);
  let handlersInstalled = false;
  let win = null;

  app.setPath("userData", path.join(tempDir, "user-data"));

  function installHandlers() {
    if (handlersInstalled) return;
    handlersInstalled = true;
    ipcMain.handle("layout-fixture:request", (_event, method) => {
      if (method === "app.getSnapshot") return snapshot;
      return {};
    });
    ipcMain.handle("layout-fixture:getConnectionState", () => "connected");
    ipcMain.handle("layout-fixture:getLogDir", () => path.join(tempDir, "logs"));
    ipcMain.handle("layout-fixture:getNativeTheme", () => "dark");
    ipcMain.handle("layout-fixture:noop", () => undefined);
  }

  async function open(width, height) {
    installHandlers();
    win = new BrowserWindow({
      width,
      height,
      useContentSize: true,
      show: false,
      backgroundColor: "#0b0d10",
      ...(process.platform === "darwin"
        ? {
            titleBarStyle: "hiddenInset",
            trafficLightPosition: { x: 14, y: 14 },
            transparent: true,
          }
        : {}),
      webPreferences: {
        preload: path.join(__dirname, "production-preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    await win.loadFile(path.join(__dirname, "..", "..", "dist", "index.html"));
    return win;
  }

  async function resize(width, height) {
    if (!win || win.isDestroyed()) throw new Error("Production fixture window is closed");
    win.setContentSize(width, height);
    await win.webContents.executeJavaScript(
      "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      true,
    );
  }

  async function dispose() {
    const windowToDispose = win;
    const shouldRemoveHandlers = handlersInstalled;
    win = null;
    handlersInstalled = false;

    await runBestEffortCleanup([
      {
        label: "分离生产窗口调试器",
        run: () => {
          if (windowToDispose?.webContents.debugger.isAttached()) {
            windowToDispose.webContents.debugger.detach();
          }
        },
      },
      {
        label: "销毁生产窗口",
        run: () => {
          if (windowToDispose && !windowToDispose.isDestroyed()) {
            windowToDispose.destroy();
          }
        },
      },
      ...HANDLERS.map((channel) => ({
        label: `移除 IPC handler ${channel}`,
        run: () => {
          if (shouldRemoveHandlers) ipcMain.removeHandler(channel);
        },
      })),
      {
        label: "恢复 Electron userData 路径",
        run: () => app.setPath("userData", originalUserData),
      },
      {
        label: "删除生产验收临时目录",
        run: () => fs.rmSync(tempDir, { recursive: true, force: true }),
      },
    ]);
  }

  return { open, resize, dispose, tempDir };
}

module.exports = { createProductionLayoutHarness };
