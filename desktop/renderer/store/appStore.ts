import { create } from "zustand";

import type {
  AppRoute,
  AppSettings,
  AppSnapshot,
  ConnectionState,
  ProtocolEvent,
  TaskSnapshot,
  ToastItem,
} from "../lib/types";

function toastId(): string {
  return `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

interface AppState {
  connection: ConnectionState;
  route: AppRoute;
  tasks: TaskSnapshot[];
  settings: AppSettings | null;
  logDir: string;
  toasts: ToastItem[];
  setConnection: (state: ConnectionState) => void;
  setRoute: (route: AppRoute) => void;
  setLogDir: (dir: string) => void;
  hydrateSnapshot: (snap: AppSnapshot) => void;
  applyEvent: (event: ProtocolEvent) => void;
  pushToast: (toast: Omit<ToastItem, "id"> & { id?: string }) => string;
  dismissToast: (id: string) => void;
}

const defaultSettings = null;

export const useAppStore = create<AppState>((set, get) => ({
  connection: "connecting",
  route: "new",
  tasks: [],
  settings: defaultSettings,
  logDir: "",
  toasts: [],

  setConnection: (connection) => set({ connection }),
  setRoute: (route) => set({ route }),
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
