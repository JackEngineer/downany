import { contextBridge, ipcRenderer } from "electron";

import type { ConnectionState, ProtocolEvent } from "./protocol";

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
};

contextBridge.exposeInMainWorld("api", api);

export type DesktopApi = typeof api;
