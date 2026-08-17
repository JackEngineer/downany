import { useCallback, useMemo } from "react";

import {
  openExtractWindow,
  openPath,
  openSettings as openSettingsWindow,
  request,
} from "../../lib/api";
import type { AppSnapshot, TaskSnapshot } from "../../lib/types";
import { useAppStore } from "../../store/appStore";

export interface TaskCommands {
  run: (
    method:
      | "download.pause"
      | "download.resume"
      | "download.cancel"
      | "download.retry"
      | "download.remove",
  ) => Promise<void>;
  update: (patch: Record<string, unknown>) => Promise<void>;
  open: () => Promise<void>;
  reveal: () => Promise<void>;
  recognizePage: () => Promise<void>;
  openSettings: () => Promise<void>;
}

export function useTaskCommands(task: TaskSnapshot): TaskCommands {
  const pushToast = useAppStore((state) => state.pushToast);

  const refresh = useCallback(async () => {
    const snapshot = await request<AppSnapshot>("app.getSnapshot");
    useAppStore.getState().hydrateSnapshot(snapshot);
  }, []);

  const run = useCallback<TaskCommands["run"]>(
    async (method) => {
      try {
        await request(method, { taskId: task.id });
        await refresh();
      } catch (error) {
        pushToast({ kind: "error", title: "操作失败", detail: String(error) });
      }
    },
    [pushToast, refresh, task.id],
  );

  const update = useCallback<TaskCommands["update"]>(
    async (patch) => {
      try {
        await request("download.updateTask", { taskId: task.id, ...patch });
        await refresh();
      } catch (error) {
        pushToast({ kind: "error", title: "更新失败", detail: String(error) });
      }
    },
    [pushToast, refresh, task.id],
  );

  return useMemo(
    () => ({
      run,
      update,
      open: async () => {
        if (task.file_path) {
          await openPath(task.file_path);
        }
      },
      reveal: async () => {
        if (task.file_path) {
          await window.api.showItemInFolder(task.file_path);
        }
      },
      recognizePage: () => openExtractWindow(task.url),
      openSettings: () => openSettingsWindow(),
    }),
    [run, task.file_path, task.url, update],
  );
}
