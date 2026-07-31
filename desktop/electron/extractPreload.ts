import { contextBridge, ipcRenderer } from "electron";

import type { ExtractMediaItem } from "./extractWindow";

const api = {
  getInitialUrl(): string {
    const params = new URLSearchParams(window.location.search);
    return params.get("url") || "";
  },
  onNavigate(handler: (url: string) => void): () => void {
    const listener = (_: Electron.IpcRendererEvent, url: string) => handler(url);
    ipcRenderer.on("extract:navigate", listener);
    return () => ipcRenderer.removeListener("extract:navigate", listener);
  },
  onList(handler: (items: ExtractMediaItem[]) => void): () => void {
    const listener = (_: Electron.IpcRendererEvent, items: ExtractMediaItem[]) =>
      handler(items);
    ipcRenderer.on("extract:list", listener);
    return () => ipcRenderer.removeListener("extract:list", listener);
  },
  enqueue(items: Array<{ url: string; title?: string }>): Promise<{
    ok: boolean;
    error?: string;
    count?: number;
  }> {
    return ipcRenderer.invoke("extract:enqueue", { items });
  },
};

contextBridge.exposeInMainWorld("extractApi", api);

export type ExtractApi = typeof api;
