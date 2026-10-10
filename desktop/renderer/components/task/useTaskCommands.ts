import { useCallback, useMemo } from "react";

import { t } from "../../i18n";
import {
  openExtractWindow,
  openPath,
  openSettings as openSettingsWindow,
  request,
} from "../../lib/api";
import { refreshQueueAfterChange } from "../../lib/refreshQueue";
import type { TaskSnapshot } from "../../lib/types";
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
  retryEmbeddedDouyin?: () => Promise<void>;
  openSettings: (focus?: SettingsFocus) => Promise<void>;
  exportDiagnostics: () => Promise<void>;
  openAppDownload: () => Promise<void>;
}

export type SettingsFocus = "cookies" | "network" | "downloadTool" | "download";

export function useTaskCommands(task: TaskSnapshot): TaskCommands {
  const pushToast = useAppStore((state) => state.pushToast);

  const run = useCallback<TaskCommands["run"]>(
    async (method) => {
      try {
        const reply = await request<{ ok?: boolean } | undefined>(method, { taskId: task.id });
        if (method === "download.remove" && reply?.ok === false) {
          pushToast({ kind: "error", title: t("error.action"), detail: t("error.removeTaskRetry") });
          return;
        }
        await refreshQueueAfterChange();
      } catch {
        pushToast({ kind: "error", title: t("error.action"), detail: t("error.actionRetry") });
      }
    },
    [pushToast, task.id],
  );

  const update = useCallback<TaskCommands["update"]>(
    async (patch) => {
      try {
        await request("download.updateTask", { taskId: task.id, ...patch });
        await refreshQueueAfterChange();
      } catch {
        pushToast({ kind: "error", title: t("error.updateTask"), detail: t("error.updateTaskRetry") });
      }
    },
    [pushToast, task.id],
  );

  const exportDiagnostics = useCallback(async () => {
    try {
      const result = await request<{ ok: boolean; path: string }>(
        "app.exportDiagnostics",
        {},
      );
      if (!result.ok || !result.path) throw new Error("diagnostics unavailable");
      pushToast({ kind: "success", title: t("diagnostics.success") });
      await window.api.showItemInFolder(result.path).catch(() => {
        pushToast({ kind: "info", title: t("diagnostics.revealFailed") });
      });
    } catch {
      pushToast({
        kind: "error",
        title: t("diagnostics.failed"),
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
        title: t("update.openFailed"),
      });
    }
  }, [pushToast]);

  const safeOpen = useCallback(async (action: () => Promise<unknown>, titleKey: string) => {
    try {
      await action();
    } catch {
      pushToast({ kind: "error", title: t(titleKey) });
    }
  }, [pushToast]);

  return useMemo(
    () => ({
      run,
      update,
      open: () => safeOpen(async () => {
        if (task.file_path) {
          const error = await openPath(task.file_path);
          if (error) throw new Error("open failed");
        }
      }, "error.openFile"),
      reveal: () => safeOpen(async () => {
        if (task.file_path) {
          await window.api.showItemInFolder(task.file_path);
        }
      }, "error.openFolder"),
      retryEmbeddedDouyin: async () => {
        try {
          const result = await window.api.retryEmbeddedDouyin(task.id);
          if (!result.ok) {
            const key = result.code === "session_required" ? "embeddedRetry.sessionRequired" : result.code === "rejected" ? "embeddedRetry.rejected" : result.code === "busy" ? "embeddedRetry.busy" : "embeddedRetry.unavailable";
            pushToast({ kind: "error", title: t("embeddedRetry.failed"), detail: t(key) });
            return;
          }
          await refreshQueueAfterChange();
        } catch { pushToast({ kind: "error", title: t("embeddedRetry.failed"), detail: t("embeddedRetry.unavailable") }); }
      },
      recognizePage: () => safeOpen(() => openExtractWindow(task.url), "add.recognizeFailed"),
      openSettings: (focus) =>
        safeOpen(() => openSettingsWindow(focus), "settings.openFailed"),
      exportDiagnostics,
      openAppDownload,
    }),
    [exportDiagnostics, openAppDownload, pushToast, run, safeOpen, task.id, task.file_path, task.url, update],
  );
}
