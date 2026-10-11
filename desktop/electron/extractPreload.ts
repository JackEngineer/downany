import { contextBridge, ipcRenderer } from "electron";

import type { ExtractSnapshot } from "./extractMedia";

const api = {
  getInitialUrl(): string {
    const params = new URLSearchParams(window.location.search);
    return params.get("url") || "";
  },
  isRecovery(): boolean { return new URLSearchParams(window.location.search).get("recovery") === "1"; },
  retryOriginal(): Promise<{ ok: boolean; code?: string }> { return ipcRenderer.invoke("extract:retryOriginal"); },
  onRecovery(handler: (active: boolean) => void): () => void {
    const listener = (_: Electron.IpcRendererEvent, active: boolean) => handler(active);
    ipcRenderer.on("extract:recovery", listener);
    return () => ipcRenderer.removeListener("extract:recovery", listener);
  },
  onNavigate(handler: (url: string) => void): () => void {
    const listener = (_: Electron.IpcRendererEvent, url: string) => handler(url);
    ipcRenderer.on("extract:navigate", listener);
    return () => ipcRenderer.removeListener("extract:navigate", listener);
  },
  onList(handler: (items: ExtractSnapshot) => void): () => void {
    const listener = (_: Electron.IpcRendererEvent, items: ExtractSnapshot) =>
      handler(items);
    ipcRenderer.on("extract:list", listener);
    return () => ipcRenderer.removeListener("extract:list", listener);
  },
  locate(id: string): Promise<boolean> { return ipcRenderer.invoke("extract:locate", id); },
  enqueue(ids: string[]): Promise<{
    ok: boolean;
    error?: string;
    count?: number;
  }> {
    return ipcRenderer.invoke("extract:enqueue", { ids });
  },
};

contextBridge.exposeInMainWorld("extractApi", api);

export type ExtractApi = typeof api;
