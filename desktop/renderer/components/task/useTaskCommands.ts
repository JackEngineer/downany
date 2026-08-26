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
  exportDiagnostics: () => Promise<void>;
  openAppDownload: () => Promise<void>;
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

  const exportDiagnostics = useCallback(async () => {
    try {
      const result = await request<{ ok: boolean; path: string }>(
        "app.exportDiagnostics",
        {},
      );
      if (!result.ok || !result.path) throw new Error("diagnostics unavailable");
      await window.api.showItemInFolder(result.path);
      pushToast({ kind: "success", title: "诊断包已导出" });
    } catch {
      pushToast({
        kind: "error",
        title: "诊断包导出失败，请稍后重试。",
      });
    }
  }, [pushToast]);

  const openAppDownload = useCallback(async () => {
    try {
      const info = await window.api.checkAppUpdate();
      if (!info.downloadUrl) throw new Error("download unavailable");
      await window.api.openExternal(info.downloadUrl);
    } catch {
      pushToast({
        kind: "error",
        title: "暂时无法打开下载页面，请稍后重试。",
      });
    }
  }, [pushToast]);

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
      exportDiagnostics,
      openAppDownload,
    }),
    [exportDiagnostics, openAppDownload, run, task.file_path, task.url, update],
  );
}
