import { t } from "../i18n";
import { useAppStore } from "../store/appStore";
import { request } from "./api";
import type { AppSnapshot } from "./types";

/** The command has succeeded; failure to refresh must never invite resubmission. */
export async function refreshQueueAfterChange(): Promise<void> {
  try {
    await useAppStore.getState().refreshSnapshot(() => request<AppSnapshot>("app.getSnapshot"));
  } catch {
    useAppStore.getState().pushToast({
      kind: "info",
      title: t("queue.refreshDelayed"),
      detail: t("queue.changeCompleted"),
    });
  }
}
