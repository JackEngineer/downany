const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, handler) {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
const noop = () => invoke("layout-fixture:noop");

contextBridge.exposeInMainWorld("api", {
  __layoutFixture: true,
  platform: process.platform,
  request: (method, payload = {}) =>
    invoke("layout-fixture:request", method, payload),
  telegram: {
    getConfig: noop,
    bind: noop,
    discoverTargets: async () => [],
    selectTarget: noop,
    sendTest: noop,
    setAutoSend: noop,
    disconnect: noop,
    listDeliveries: async () => ({ items: [], total: 0, offset: 0, limit: 50 }),
    retry: noop,
  },
  getConnectionState: () => invoke("layout-fixture:getConnectionState"),
  getLogDir: () => invoke("layout-fixture:getLogDir"),
  openPath: async () => "",
  showItemInFolder: noop,
  selectDirectory: async () => null,
  getNativeTheme: () => invoke("layout-fixture:getNativeTheme"),
  setThemeSource: noop,
  openSettings: noop,
  readClipboardText: async () => "",
  quit: noop,
  checkAppUpdate: async () => ({
    status: "current",
    currentVersion: "fixture",
    message: "fixture",
  }),
  openExternal: noop,
  onEvent: (handler) => subscribe("layout-fixture:event", handler),
  onState: (handler) => subscribe("layout-fixture:state", handler),
  onNavigate: (handler) => subscribe("layout-fixture:navigate", handler),
  onNativeTheme: (handler) => subscribe("layout-fixture:nativeTheme", handler),
  onMigration: (handler) => subscribe("layout-fixture:migration", handler),
  onExternalEnqueue: (handler) =>
    subscribe("layout-fixture:externalEnqueue", handler),
  onHighlightTask: (handler) =>
    subscribe("layout-fixture:highlightTask", handler),
  openExtractWindow: noop,
  showTaskContextMenu: async () => null,
});
