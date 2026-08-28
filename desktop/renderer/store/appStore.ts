import { create } from "zustand";

import { acceptsTaskProgress, taskProgressPatch } from "../../electron/taskProgressRelay";
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
  TaskProgressPatch,
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
  failNetSearch: (searchId: string, error: string) => void;
  clearNetSearch: () => void;
  requestAddFocus: () => void;
  setPendingAddUrls: (urls: string[] | null) => void;
  setLogDir: (dir: string) => void;
  hydrateSnapshot: (snap: AppSnapshot) => void;
  invalidateSnapshotRequests: () => void;
  refreshSnapshot: (load: () => Promise<AppSnapshot>) => Promise<void>;
  applyQueueOrder: (snap: AppSnapshot) => void;
  applyTaskProgressBatch: (updates: readonly TaskProgressPatch[]) => void;
  applyEvent: (event: ProtocolEvent) => void;
  pushToast: (toast: Omit<ToastItem, "id"> & { id?: string }) => string;
  dismissToast: (id: string) => void;
}

const defaultSettings = null;

interface PendingSnapshotRefresh {
  sequence: number;
  changedTaskIds: Set<string>;
  progress: Map<string, Omit<TaskProgressPatch, "taskId">>;
  queueOrders: Map<string, number>;
  settingsChanged: boolean;
}

// Only in-flight requests retain changes; removed IDs never form an unbounded
// tombstone cache. Recording progress does not rescan the task list.
const pendingSnapshotRefreshes = new Set<PendingSnapshotRefresh>();
let snapshotSequence = 0;
let latestAppliedSnapshot = 0;

function rememberTaskChange(taskId: string): void {
  for (const pending of pendingSnapshotRefreshes) pending.changedTaskIds.add(taskId);
}

function rememberProgress(taskId: string, patch: Omit<TaskProgressPatch, "taskId">): void {
  for (const pending of pendingSnapshotRefreshes) {
    pending.progress.set(taskId, { ...pending.progress.get(taskId), ...patch });
  }
}

function reconcileSnapshotTasks(
  snapshotTasks: readonly TaskSnapshot[], currentTasks: readonly TaskSnapshot[], pending: PendingSnapshotRefresh,
): TaskSnapshot[] {
  const currentById = new Map(currentTasks.map((task) => [task.id, task]));
  const seen = new Set<string>();
  const result: TaskSnapshot[] = [];
  for (const snapshotTask of snapshotTasks) {
    const { id } = snapshotTask;
    seen.add(id);
    if (pending.changedTaskIds.has(id)) {
      const current = currentById.get(id);
      if (current) result.push(current);
      continue;
    }
    let task = snapshotTask;
    const progress = pending.progress.get(id);
    if (progress && acceptsTaskProgress(task.status)) task = { ...task, ...progress };
    const queueOrder = pending.queueOrders.get(id);
    if (queueOrder !== undefined) task = { ...task, queue_order: queueOrder };
    result.push(task);
  }
  for (const task of currentTasks) {
    if (!seen.has(task.id) && pending.changedTaskIds.has(task.id)) result.push(task);
  }
  return result;
}

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
  failNetSearch: (netSearchId, netError) => {
    if (netSearchId !== get().netSearchId) return;
    set({ netSearching: false, netResults: [], netError });
  },
  clearNetSearch: () =>
    set({ netSearchId: "", netSearching: false, netResults: [], netError: "" }),
  requestAddFocus: () => set({ addFocusSignal: get().addFocusSignal + 1 }),
  setPendingAddUrls: (pendingAddUrls) => set({ pendingAddUrls }),
  setLogDir: (logDir) => set({ logDir }),

  hydrateSnapshot: (snap) => {
    latestAppliedSnapshot = ++snapshotSequence;
    set({
      tasks: snap.tasks ?? [],
      settings: snap.settings ?? null,
    });
  },

  invalidateSnapshotRequests: () => {
    latestAppliedSnapshot = ++snapshotSequence;
    pendingSnapshotRefreshes.clear();
  },

  refreshSnapshot: async (load) => {
    const pending: PendingSnapshotRefresh = {
      sequence: ++snapshotSequence, changedTaskIds: new Set(), progress: new Map(),
      queueOrders: new Map(), settingsChanged: false,
    };
    pendingSnapshotRefreshes.add(pending);
    try {
      const snapshot = await load();
      if (pending.sequence < latestAppliedSnapshot) return;
      const current = get();
      latestAppliedSnapshot = pending.sequence;
      set({
        tasks: reconcileSnapshotTasks(snapshot.tasks ?? [], current.tasks, pending),
        settings: pending.settingsChanged ? current.settings : snapshot.settings ?? null,
      });
    } finally {
      pendingSnapshotRefreshes.delete(pending);
    }
  },

  applyQueueOrder: (snapshot) => {
    const currentTasks = get().tasks;
    const byId = new Map(currentTasks.map((task) => [task.id, task]));
    const ordered: TaskSnapshot[] = [];
    for (const task of snapshot.tasks ?? []) {
      const current = byId.get(task.id);
      if (!current) continue;
      byId.delete(task.id);
      if (typeof task.queue_order === "number" && task.queue_order !== current.queue_order) {
        ordered.push({ ...current, queue_order: task.queue_order });
        for (const pending of pendingSnapshotRefreshes) pending.queueOrders.set(task.id, task.queue_order);
      } else {
        ordered.push(current);
      }
    }
    // An order response is not a lifecycle snapshot: keep new tasks and never
    // reinsert removed ones or replace progress, terminal state or settings.
    for (const task of currentTasks) if (byId.has(task.id)) ordered.push(task);
    set({ tasks: ordered });
  },

  applyTaskProgressBatch: (updates) => {
    if (updates.length === 0) return;
    set({ tasks: applyProgressBatch(get().tasks, updates, rememberProgress) });
  },

  applyEvent: (event) => {
    const { tasks } = get();
    const payload = event.payload || {};
    const taskId = String(payload.taskId || payload.task_id || "");

    if (event.event === "task.progressBatch") {
      if (Array.isArray(payload.updates)) {
        get().applyTaskProgressBatch(payload.updates as TaskProgressPatch[]);
      }
      return;
    }
    if (event.event === "task.progress") {
      const patch = taskProgressPatch(event);
      if (patch) get().applyTaskProgressBatch([patch]);
      return;
    }

    if (event.event === "settings.changed" && payload.settings) {
      for (const pending of pendingSnapshotRefreshes) pending.settingsChanged = true;
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
      rememberTaskChange(taskId);
      set({ tasks: tasks.filter((t) => t.id !== taskId) });
      return;
    }

    const incoming = payload.task as TaskSnapshot | undefined;
    if (incoming && incoming.id) {
      rememberTaskChange(incoming.id);
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

  },

  pushToast: (toast) => {
    const id = toast.id || toastId();
    set({ toasts: [...get().toasts, { ...toast, id }] });
    return id;
  },

  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

export function applyProgressBatch(
  tasks: readonly TaskSnapshot[], updates: readonly TaskProgressPatch[],
  onApplied?: (taskId: string, patch: Omit<TaskProgressPatch, "taskId">) => void,
): TaskSnapshot[] {
  const byId = new Map<string, Omit<TaskProgressPatch, "taskId">>();
  for (const { taskId, ...patch } of updates) {
    byId.set(taskId, { ...byId.get(taskId), ...patch });
  }
  return tasks.map((task) => {
    const patch = byId.get(task.id);
    if (!patch || !acceptsTaskProgress(task.status)) return task;
    onApplied?.(task.id, patch);
    return { ...task, ...patch };
  });
}

export function activeTaskCount(tasks: TaskSnapshot[]): number {
  return tasks.filter((t) => t.status === "downloading" || t.status === "pending")
    .length;
}
