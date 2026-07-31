import { request } from "./api";
import { extractUrls } from "./urls";
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
  }[],
): Promise<void> {
  const { pushToast } = useAppStore.getState();
  await request("download.createTasks", { urls, items });
  pushToast({
    kind: "success",
    title: urls.length === 1 ? "已加入 1 个任务" : `已加入 ${urls.length} 个任务`,
  });
  const snap = await request("app.getSnapshot");
  useAppStore.getState().hydrateSnapshot(snap as never);
}

/**
 * 统一添加入口：自动开始开启时直接入队；关闭时先进入解析确认流程。
 * 返回提取到的 URL（用于调用方清空输入框等）。
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
  if (settings?.auto_start_downloads === false) {
    setPendingAddUrls(urls);
    return urls;
  }
  try {
    await createTasksAndRefresh(urls);
  } catch (err) {
    pushToast({ kind: "error", title: "添加失败", detail: String(err) });
  }
  return urls;
}
