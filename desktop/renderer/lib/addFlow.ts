import { request } from "./api";
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
): Promise<void> {
  const { pushToast } = useAppStore.getState();
  const result = await request<{ taskIds?: string[] }>("download.createTasks", {
    urls,
    items,
  });
  const count = Array.isArray(result?.taskIds) ? result.taskIds.length : urls.length;
  pushToast({
    kind: "success",
    title: count === 1 ? "已加入 1 个任务" : `已加入 ${count} 个任务`,
  });
  const snap = await request("app.getSnapshot");
  useAppStore.getState().hydrateSnapshot(snap as never);
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
      pushToast({ kind: "warning", title: "没有发现有效链接" });
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
    await createTasksAndRefresh(urls);
  } catch (err) {
    pushToast({
      kind: "error",
      title: "添加失败",
      detail: String(err),
      sticky: true,
    });
    if (urls.length === 1) {
      pushToast({
        kind: "info",
        title: "可尝试浏览器抓取",
        detail: "若站点需要登录或 yt-dlp 无法解析，可使用顶部「浏览器抓取」按钮。",
      });
    }
  }
  return urls;
}
