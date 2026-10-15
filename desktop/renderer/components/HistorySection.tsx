import { useCallback, useEffect, useRef, useState } from "react";

import { ConfirmDialog } from "./ConfirmDialog";
import { openPath, request } from "../lib/api";
import { sourceName } from "../lib/workbenchPresentation";
import type { HistoryItem } from "../lib/types";
import { useAppStore } from "../store/appStore";

const PAGE_SIZE = 30;

export function HistorySection() {
  const pushToast = useAppStore((s) => s.pushToast);
  const connection = useAppStore((s) => s.connection);
  const searchQuery = useAppStore((s) => s.searchQuery);
  const searchMode = useAppStore((s) => s.searchMode);
  const sortOrder = useAppStore((s) => s.sortOrder);
  const generation = useRef(0);
  const effectiveQuery = searchMode === "filter" ? searchQuery : "";
  const [status, setStatus] = useState("");
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmSelected, setConfirmSelected] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const deletionLock = useRef(false);
  const queryRef = useRef(effectiveQuery);
  const statusRef = useRef(status);
  queryRef.current = effectiveQuery;
  statusRef.current = status;

  const fetchPage = useCallback(
    async (nextOffset: number, reset: boolean) => {
      if (connection !== "connected") return;
      const requestGeneration = ++generation.current;
      setLoading(true);
      try {
        const res = await request<{ items: HistoryItem[] }>("history.list", {
          sort_order: sortOrder,
          offset: nextOffset,
          limit: PAGE_SIZE,
          query: queryRef.current || undefined,
          status: statusRef.current || undefined,
        });
        if (requestGeneration !== generation.current) return;
        const batch = res.items || [];
        setItems((prev) => (reset ? batch : [...prev, ...batch]));
        setOffset(nextOffset + batch.length);
        setHasMore(batch.length >= PAGE_SIZE);

      } catch (err) {
        if (requestGeneration === generation.current) pushToast({ kind: "error", title: "加载历史失败", detail: String(err) });
      } finally {
        if (requestGeneration === generation.current) setLoading(false);
      }
    },
    [connection, pushToast, sortOrder],
  );

  useEffect(() => {
    const handle = window.setTimeout(() => void fetchPage(0, true), 200);
    return () => { window.clearTimeout(handle); generation.current++; };
  }, [effectiveQuery, status, connection, fetchPage]);

  useEffect(() => { setSelected(new Set()); }, [effectiveQuery, status]);

  useEffect(() => {
    return window.api.onEvent((event) => {
      if (event.event === "history.changed") void fetchPage(0, true);
    });
  }, [fetchPage]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const deleteSelected = async () => {
    const ids = [...selected];
    if (ids.length === 0 || deletionLock.current) return;
    deletionLock.current = true; setDeleting(true);
    try {
      await request("history.delete", { ids });
      setSelected(new Set());
      pushToast({ kind: "success", title: `已删除 ${ids.length} 条` });
      await fetchPage(0, true); setConfirmSelected(false);
    } catch {
      pushToast({ kind: "error", title: "删除失败，请稍后重试。" });
    } finally { deletionLock.current = false; setDeleting(false); }
  };

  const clearAll = async () => {
    if (deletionLock.current) return; deletionLock.current = true; setDeleting(true);
    try {
      await request("history.clear", {});
      setSelected(new Set());
      pushToast({ kind: "success", title: "历史已清空" });
      setConfirmClear(false);
      await fetchPage(0, true);
    } catch (err) {
      pushToast({ kind: "error", title: "清空失败，请稍后重试。" });
    } finally { deletionLock.current = false; setDeleting(false); }
  };

  const redownload = async (item: HistoryItem) => {
    try {
      await request("download.createTasks", {
        urls: [item.url],
        items: [{ url: item.url, title: item.title }],
      });
      pushToast({ kind: "success", title: "已重新加入队列" });
      useAppStore.getState().setFilter("all");
    } catch (err) {
      pushToast({ kind: "error", title: "重新下载失败", detail: String(err) });
    }
  };

  return (
    <div className="history-section">
      <div className="toolbar">
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="状态筛选">
          <option value="">全部状态</option>
          <option value="completed">已完成</option>
          <option value="failed">失败</option>
          <option value="cancelled">已取消</option>
        </select>
        <details className="wb-view-menu"><summary aria-label="历史维护">维护</summary><div><button type="button" onClick={() => setConfirmClear(true)}>清空全部下载历史…</button><small>只删除历史记录，不删除下载文件</small></div></details>
      </div>

      {selected.size > 0 && <div className="wb-selection-toolbar" role="toolbar" aria-label="已选历史操作"><strong>已选{selected.size}条</strong><button disabled={deleting} onClick={() => setConfirmSelected(true)}>删除选中记录…</button><button disabled={deleting} onClick={() => setSelected(new Set())}>取消选择</button></div>}
      {items.length === 0 && !loading ? (
        <p className="muted list-empty">暂无记录</p>
      ) : (
        <ul className="history-list">
          {items.map((item) => (
            <li key={item.id}>
              <div className="history-row">
                <input
                  type="checkbox"
                  aria-label={`选择历史 ${item.title}`}
                  checked={selected.has(item.id)}
                  onChange={() => toggle(item.id)}
                />
                <div className="grow">
                  <strong>{item.title}</strong>
                  <div className="muted">
                    {sourceName(item)} · {({completed:"已完成",failed:"下载失败",cancelled:"已取消"} as Record<string,string>)[item.status] || "状态待确认"}
                  </div>
                </div>
                <div className="card-actions">
                  <button type="button" onClick={() => void redownload(item)}>
                    重新下载
                  </button>
                  {item.file_path && (
                    <button type="button" onClick={() => void openPath(item.file_path)}>
                      打开
                    </button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {hasMore && items.length > 0 && (
        <button type="button" disabled={loading} onClick={() => void fetchPage(offset, false)}>
          {loading ? "加载中…" : "加载更多"}
        </button>
      )}

      <ConfirmDialog open={confirmSelected} title={`删除${selected.size}条选中历史？`} message="只删除选中的历史记录，不会删除下载文件或任务列表。此操作不可恢复。" busy={deleting} confirmLabel="删除选中记录" onCancel={() => { if (!deleting) setConfirmSelected(false); }} onConfirm={() => void deleteSelected()} />
      <ConfirmDialog
        open={confirmClear}
        title="清空历史？"
        message="将删除全部下载历史记录，包括当前搜索与筛选之外的记录。此操作不可恢复，但不会删除下载文件或任务列表。"
        busy={deleting}
        confirmLabel="清空"
        onCancel={() => { if (!deleting) setConfirmClear(false); }}
        onConfirm={() => void clearAll()}
      />
    </div>
  );
}
