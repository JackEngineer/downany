import { contextBridge, ipcRenderer } from "electron";

import type { ConnectionState, ProtocolEvent } from "./protocol";

export type AppRoute = "new" | "queue" | "history" | "settings";
export type NativeThemeMode = "light" | "dark";

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

const api = {
  request(method: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    return ipcRenderer.invoke("sidecar:request", method, payload);
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
  quit(): Promise<void> {
    return ipcRenderer.invoke("app:quit");
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
};

contextBridge.exposeInMainWorld("api", api);

export type DesktopApi = typeof api;
