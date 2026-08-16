const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { app, BrowserWindow, ipcMain } = require("electron");

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
    if (win?.webContents.debugger.isAttached()) {
      win.webContents.debugger.detach();
    }
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
    if (handlersInstalled) {
      for (const channel of HANDLERS) ipcMain.removeHandler(channel);
      handlersInstalled = false;
    }
    app.setPath("userData", originalUserData);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  return { open, resize, dispose, tempDir };
}

module.exports = { createProductionLayoutHarness };
