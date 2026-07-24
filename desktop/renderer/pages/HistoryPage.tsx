import { useCallback, useEffect, useRef, useState } from "react";

import { ConfirmDialog } from "../components/ConfirmDialog";
import { openPath, request } from "../lib/api";
import type { HistoryItem } from "../lib/types";
import { useAppStore } from "../store/appStore";

const PAGE_SIZE = 30;

export function HistoryPage() {
  const pushToast = useAppStore((s) => s.pushToast);
  const connection = useAppStore((s) => s.connection);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmClear, setConfirmClear] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const queryRef = useRef(query);
  const statusRef = useRef(status);
  queryRef.current = query;
  statusRef.current = status;

  const fetchPage = useCallback(
    async (nextOffset: number, reset: boolean) => {
      if (connection !== "connected") return;
      setLoading(true);
      try {
        const res = await request<{ items: HistoryItem[] }>("history.list", {
          offset: nextOffset,
          limit: PAGE_SIZE,
          query: queryRef.current || undefined,
          status: statusRef.current || undefined,
        });
        const batch = res.items || [];
        setItems((prev) => (reset ? batch : [...prev, ...batch]));
        setOffset(nextOffset + batch.length);
        setHasMore(batch.length >= PAGE_SIZE);
        if (reset) setSelected(new Set());
      } catch (err) {
        pushToast({ kind: "error", title: "加载历史失败", detail: String(err) });
      } finally {
        setLoading(false);
      }
    },
    [connection, pushToast],
  );

  useEffect(() => {
    void fetchPage(0, true);
  }, [query, status, connection, fetchPage]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
    if (ids.length === 0) return;
    try {
      await request("history.delete", { ids });
      pushToast({ kind: "success", title: `已删除 ${ids.length} 条` });
      await fetchPage(0, true);
    } catch (err) {
      pushToast({ kind: "error", title: "删除失败", detail: String(err) });
    }
  };

  const clearAll = async () => {
    try {
      await request("history.clear", {});
      pushToast({ kind: "success", title: "历史已清空" });
      setConfirmClear(false);
      await fetchPage(0, true);
    } catch (err) {
      pushToast({ kind: "error", title: "清空失败", detail: String(err) });
    }
  };

  const redownload = async (item: HistoryItem) => {
    try {
      await request("download.createTasks", {
        urls: [item.url],
        items: [{ url: item.url, title: item.title }],
      });
      pushToast({ kind: "success", title: "已重新加入队列" });
      useAppStore.getState().setRoute("queue");
    } catch (err) {
      pushToast({ kind: "error", title: "重新下载失败", detail: String(err) });
    }
  };

  return (
    <div className="page">
      <header className="page-header">
        <h1>历史记录</h1>
      </header>
      <div className="toolbar">
        <input
          ref={searchRef}
          type="search"
          placeholder="搜索标题或链接"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="状态筛选">
          <option value="">全部状态</option>
          <option value="completed">已完成</option>
          <option value="failed">失败</option>
          <option value="cancelled">已取消</option>
        </select>
        <button type="button" disabled={selected.size === 0} onClick={() => void deleteSelected()}>
          删除{selected.size > 0 ? `（${selected.size}）` : ""}
        </button>
        <button type="button" className="danger" onClick={() => setConfirmClear(true)}>
          清空历史
        </button>
      </div>

      {items.length === 0 && !loading ? (
        <p className="muted">暂无记录</p>
      ) : (
        <ul className="history-list">
          {items.map((item) => (
            <li key={item.id}>
              <label className="history-row">
                <input
                  type="checkbox"
                  checked={selected.has(item.id)}
                  onChange={() => toggle(item.id)}
                />
                <div className="grow">
                  <strong>{item.title}</strong>
                  <div className="muted">
                    {item.platform} · {item.status}
                  </div>
                </div>
                <div className="task-actions">
                  <button type="button" onClick={() => void redownload(item)}>
                    重新下载
                  </button>
                  {item.file_path && (
                    <button type="button" onClick={() => void openPath(item.file_path)}>
                      打开
                    </button>
                  )}
                </div>
              </label>
            </li>
          ))}
        </ul>
      )}

      {hasMore && items.length > 0 && (
        <button type="button" disabled={loading} onClick={() => void fetchPage(offset, false)}>
          {loading ? "加载中…" : "加载更多"}
        </button>
      )}

      <ConfirmDialog
        open={confirmClear}
        title="清空历史？"
        message="此操作不可恢复，将删除全部下载历史记录。"
        confirmLabel="清空"
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => void clearAll()}
      />
    </div>
  );
}
