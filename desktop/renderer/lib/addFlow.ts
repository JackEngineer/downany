import { t } from "../i18n";
import { request } from "./api";
import { refreshQueueAfterChange } from "./refreshQueue";
import { extractUrls, looksLikePlaylistUrl } from "./urls";
import { useAppStore } from "../store/appStore";

/** 创建任务并刷新快照 + 成功提示。 */
export async function createTasksAndRefresh(
  urls: string[],
  items?: {
    url: string;
    title?: string;
    thumbnail_url?: string;
    format_id?: string;
    audio_only?: boolean;
    group_id?: string;
    group_title?: string;
    playlist_index?: number;
  }[],
): Promise<boolean> {
  const { pushToast } = useAppStore.getState();
  const readiness = await request<{ ready?: boolean; reason?: string }>(
    "settings.checkDownloadDir",
    {},
  );
  if (readiness?.ready === false) {
    pushToast({
      kind: "error",
      title: t("add.downloadDirUnavailable"),
      detail: t("add.downloadDirAction"),
      sticky: true,
    });
    await window.api.openSettings("download").catch(() => undefined);
    return false;
  }
  const result = await request<{ taskIds?: string[] }>("download.createTasks", {
    urls,
    items,
  });
  const count = Array.isArray(result?.taskIds) ? result.taskIds.length : urls.length;
  pushToast({
    kind: "success",
    title: t("add.success", undefined, { count }),
  });
  await refreshQueueAfterChange();
  return true;
}

/**
 * 统一添加入口：
 * - 关闭自动开始 → 解析确认
 * - 播放列表/合集 URL → 即使自动开始也先进确认窗（选集）
 * - 其余自动开始 → 直入队（Sidecar 对 playlist URL 仍会兜底展开）
 */
export async function submitAddText(raw: string): Promise<string[]> {
  const { pushToast, settings, setPendingAddUrls } = useAppStore.getState();
  const urls = extractUrls(raw);
  if (urls.length === 0) {
    if (raw.trim()) {
      pushToast({ kind: "warning", title: t("add.none") });
    }
    return [];
  }
  const forceConfirm =
    settings?.auto_start_downloads === false || urls.some(looksLikePlaylistUrl);
  if (forceConfirm) {
    setPendingAddUrls(urls);
    return urls;
  }
  try {
    const created = await createTasksAndRefresh(urls);
    if (!created) return [];
  } catch {
    pushToast({
      kind: "error",
      title: t("add.failed"),
      detail: t("add.retry"),
      sticky: true,
    });
    if (urls.length === 1) {
      pushToast({
        kind: "info",
        title: t("add.captureHint"),
        detail: t("add.captureCopy"),
      });
    }
  }
  return urls;
}
