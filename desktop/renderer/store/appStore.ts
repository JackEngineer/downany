import { create } from "zustand";

import type {
  AppSettings,
  AppSnapshot,
  ConnectionState,
  ListFilter,
  NetSearchItem,
  NetSearchResultPayload,
  ProtocolEvent,
  SearchMode,
  TaskSnapshot,
  ToastItem,
} from "../lib/types";

function toastId(): string {
  return `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

interface AppState {
  connection: ConnectionState;
  filter: ListFilter;
  searchQuery: string;
  searchMode: SearchMode;
  netSearchId: string;
  netSearching: boolean;
  netResults: NetSearchItem[];
  netError: string;
  addFocusSignal: number;
  pendingAddUrls: string[] | null;
  tasks: TaskSnapshot[];
  settings: AppSettings | null;
  logDir: string;
  toasts: ToastItem[];
  setConnection: (state: ConnectionState) => void;
  setFilter: (filter: ListFilter) => void;
  setSearchQuery: (query: string) => void;
  setSearchMode: (mode: SearchMode) => void;
  startNetSearch: (searchId: string) => void;
  clearNetSearch: () => void;
  requestAddFocus: () => void;
  setPendingAddUrls: (urls: string[] | null) => void;
  setLogDir: (dir: string) => void;
  hydrateSnapshot: (snap: AppSnapshot) => void;
  applyEvent: (event: ProtocolEvent) => void;
  pushToast: (toast: Omit<ToastItem, "id"> & { id?: string }) => string;
  dismissToast: (id: string) => void;
}

const defaultSettings = null;

export const useAppStore = create<AppState>((set, get) => ({
  connection: "connecting",
  filter: "all",
  searchQuery: "",
  searchMode: "filter",
  netSearchId: "",
  netSearching: false,
  netResults: [],
  netError: "",
  addFocusSignal: 0,
  pendingAddUrls: null,
  tasks: [],
  settings: defaultSettings,
  logDir: "",
  toasts: [],

  setConnection: (connection) => set({ connection }),
  setFilter: (filter) => set({ filter }),
  setSearchQuery: (searchQuery) => set({ searchQuery }),
  setSearchMode: (searchMode) => set({ searchMode }),
  startNetSearch: (netSearchId) =>
    set({ netSearchId, netSearching: true, netResults: [], netError: "" }),
  clearNetSearch: () =>
    set({ netSearchId: "", netSearching: false, netResults: [], netError: "" }),
  requestAddFocus: () => set({ addFocusSignal: get().addFocusSignal + 1 }),
  setPendingAddUrls: (pendingAddUrls) => set({ pendingAddUrls }),
  setLogDir: (logDir) => set({ logDir }),

  hydrateSnapshot: (snap) =>
    set({
      tasks: snap.tasks ?? [],
      settings: snap.settings ?? null,
    }),

  applyEvent: (event) => {
    const { tasks } = get();
    const payload = event.payload || {};
    const taskId = String(payload.taskId || payload.task_id || "");

    if (event.event === "settings.changed" && payload.settings) {
      set({ settings: payload.settings as AppSettings });
      return;
    }

    if (event.event === "search.result") {
      const result = payload as unknown as NetSearchResultPayload;
      if (result.searchId && result.searchId === get().netSearchId) {
        set({
          netSearching: false,
          netResults: result.ok ? result.items || [] : [],
          netError: result.ok ? "" : result.error || "搜索失败",
        });
      }
      return;
    }

    if (event.event === "task.removed" && taskId) {
      set({ tasks: tasks.filter((t) => t.id !== taskId) });
      return;
    }

    const incoming = payload.task as TaskSnapshot | undefined;
    if (incoming && incoming.id) {
      const idx = tasks.findIndex((t) => t.id === incoming.id);
      if (idx >= 0) {
        const next = tasks.slice();
        next[idx] = { ...next[idx], ...incoming };
        set({ tasks: next });
      } else {
        set({ tasks: [...tasks, incoming] });
      }
      return;
    }

    if (event.event === "task.progress" && taskId && payload.progress) {
      const progress = payload.progress as Record<string, unknown>;
      set({
        tasks: tasks.map((t) =>
          t.id === taskId
            ? {
                ...t,
                progress: Number(progress.progress ?? t.progress),
                downloaded_bytes: Number(
                  progress.downloaded_bytes ?? t.downloaded_bytes,
                ),
                total_bytes: Number(progress.total_bytes ?? t.total_bytes),
                speed: String(progress._speed_str ?? t.speed),
                eta: String(progress._eta_str ?? t.eta),
              }
            : t,
        ),
      });
    }
  },

  pushToast: (toast) => {
    const id = toast.id || toastId();
    set({ toasts: [...get().toasts, { ...toast, id }] });
    return id;
  },

  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

export function activeTaskCount(tasks: TaskSnapshot[]): number {
  return tasks.filter((t) => t.status === "downloading" || t.status === "pending")
    .length;
}
