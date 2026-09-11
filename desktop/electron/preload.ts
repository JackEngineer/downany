import { contextBridge, ipcRenderer } from "electron";

import type { ConnectionState, ProtocolEvent } from "./protocol";
import type {
  TelegramConfig,
  TelegramDeliverySummary,
  TelegramTarget,
} from "./telegram/types";

export type AppRoute = "new" | "queue" | "history" | "settings";
export type NativeThemeMode = "light" | "dark";
export type SettingsFocus = "cookies" | "network" | "downloadTool" | "download";

export type MigrationResult = {
  status: "skipped" | "migrated" | "failed";
  message?: string;
  details?: Record<string, unknown>;
};

export type ExternalEnqueuePayload = {
  count: number;
  urls: string[];
  error?: string;
};

export type ContextMenuTemplateItem = {
  id: string;
  label: string;
  enabled?: boolean;
  type?: "separator";
};

const api = {
  platform: process.platform as NodeJS.Platform,
  request(method: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    return ipcRenderer.invoke("sidecar:request", method, payload);
  },
  telegram: {
    getConfig(): Promise<TelegramConfig> {
      return ipcRenderer.invoke("telegram:getConfig");
    },
    bind(token: string): Promise<TelegramConfig> {
      return ipcRenderer.invoke("telegram:bind", token);
    },
    discoverTargets(): Promise<TelegramTarget[]> {
      return ipcRenderer.invoke("telegram:discoverTargets");
    },
    selectTarget(targetId: string): Promise<TelegramConfig> {
      return ipcRenderer.invoke("telegram:selectTarget", targetId);
    },
    sendTest(text: string): Promise<unknown> {
      return ipcRenderer.invoke("telegram:sendTest", text);
    },
    setAutoSend(enabled: boolean): Promise<TelegramConfig> {
      return ipcRenderer.invoke("telegram:setAutoSend", enabled);
    },
    disconnect(): Promise<TelegramConfig> {
      return ipcRenderer.invoke("telegram:disconnect");
    },
    listDeliveries(offset = 0, limit = 50): Promise<{ items: TelegramDeliverySummary[]; total: number; offset: number; limit: number }> {
      return ipcRenderer.invoke("telegram:listDeliveries", offset, limit);
    },
    retry(deliveryId: string, confirmPossibleDuplicate = false, confirmInterruptedOutput = false): Promise<TelegramDeliverySummary> {
      return ipcRenderer.invoke("telegram:retry", { deliveryId, confirmPossibleDuplicate, confirmInterruptedOutput });
    },
  },
  getConnectionState(): Promise<ConnectionState> {
    return ipcRenderer.invoke("sidecar:getState");
  },
  getLogDir(): Promise<string> {
    return ipcRenderer.invoke("sidecar:getLogDir");
  },
  openPath(target: string): Promise<string> {
    return ipcRenderer.invoke("app:openPath", target);
  },
  showItemInFolder(target: string): Promise<void> {
    return ipcRenderer.invoke("app:showItemInFolder", target);
  },
  selectDirectory(): Promise<string | null> {
    return ipcRenderer.invoke("app:selectDirectory");
  },
  getNativeTheme(): Promise<NativeThemeMode> {
    return ipcRenderer.invoke("app:getNativeTheme");
  },
  setThemeSource(mode: "system" | NativeThemeMode): Promise<void> {
    return ipcRenderer.invoke("app:setThemeSource", mode);
  },
  openSettings(focus?: SettingsFocus): Promise<void> {
    return ipcRenderer.invoke("app:openSettings", focus);
  },
  onSettingsFocus(handler: (focus: SettingsFocus) => void): () => void {
    const listener = (_: Electron.IpcRendererEvent, focus: SettingsFocus) => handler(focus);
    ipcRenderer.on("app:settingsFocus", listener);
    return () => ipcRenderer.removeListener("app:settingsFocus", listener);
  },
  readClipboardText(): Promise<string> {
    return ipcRenderer.invoke("app:readClipboard");
  },
  quit(): Promise<void> {
    return ipcRenderer.invoke("app:quit");
  },
  checkAppUpdate(): Promise<{
    status: string;
    currentVersion: string;
    latestVersion?: string;
    message: string;
    downloadUrl?: string;
  }> {
    return ipcRenderer.invoke("app:checkUpdate");
  },
  openExternal(url: string): Promise<void> {
    return ipcRenderer.invoke("app:openExternal", url);
  },
  onEvent(handler: (event: ProtocolEvent) => void): () => void {
    const listener = (_: Electron.IpcRendererEvent, event: ProtocolEvent) => handler(event);
    ipcRenderer.on("sidecar:event", listener);
    return () => ipcRenderer.removeListener("sidecar:event", listener);
  },
  onState(handler: (state: ConnectionState) => void): () => void {
    const listener = (_: Electron.IpcRendererEvent, state: ConnectionState) => handler(state);
    ipcRenderer.on("sidecar:state", listener);
    return () => ipcRenderer.removeListener("sidecar:state", listener);
  },
  onNavigate(handler: (route: AppRoute) => void): () => void {
    const listener = (_: Electron.IpcRendererEvent, route: AppRoute) => handler(route);
    ipcRenderer.on("app:navigate", listener);
    return () => ipcRenderer.removeListener("app:navigate", listener);
  },
  onNativeTheme(handler: (mode: NativeThemeMode) => void): () => void {
    const listener = (_: Electron.IpcRendererEvent, mode: NativeThemeMode) => handler(mode);
    ipcRenderer.on("app:nativeTheme", listener);
    return () => ipcRenderer.removeListener("app:nativeTheme", listener);
  },
  onMigration(handler: (result: MigrationResult) => void): () => void {
    const listener = (_: Electron.IpcRendererEvent, result: MigrationResult) =>
      handler(result);
    ipcRenderer.on("app:migration", listener);
    return () => ipcRenderer.removeListener("app:migration", listener);
  },
  onExternalEnqueue(handler: (payload: ExternalEnqueuePayload) => void): () => void {
    const listener = (_: Electron.IpcRendererEvent, payload: ExternalEnqueuePayload) =>
      handler(payload);
    ipcRenderer.on("app:externalEnqueue", listener);
    return () => ipcRenderer.removeListener("app:externalEnqueue", listener);
  },
  onHighlightTask(handler: (taskId: string) => void): () => void {
    const listener = (_: Electron.IpcRendererEvent, taskId: string) => handler(taskId);
    ipcRenderer.on("app:highlightTask", listener);
    return () => ipcRenderer.removeListener("app:highlightTask", listener);
  },
  openExtractWindow(url: string): Promise<void> {
    return ipcRenderer.invoke("app:openExtractWindow", url);
  },
  showTaskContextMenu(template: ContextMenuTemplateItem[]): Promise<string | null> {
    return ipcRenderer.invoke("app:showTaskContextMenu", template);
  },
};

contextBridge.exposeInMainWorld("api", api);

export type DesktopApi = typeof api;
