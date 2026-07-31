import { useState } from "react";

import { createTasksAndRefresh } from "../lib/addFlow";
import type { NetSearchItem } from "../lib/types";
import { useAppStore } from "../store/appStore";

function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return "";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}:${String(m % 60).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** 网络搜索模式下顶栏下方的结果面板，结果可一键入队。 */
export function NetSearchPanel() {
  const searchMode = useAppStore((s) => s.searchMode);
  const netSearching = useAppStore((s) => s.netSearching);
  const netResults = useAppStore((s) => s.netResults);
  const netError = useAppStore((s) => s.netError);
  const netSearchId = useAppStore((s) => s.netSearchId);
  const clearNetSearch = useAppStore((s) => s.clearNetSearch);
  const pushToast = useAppStore((s) => s.pushToast);
  const [adding, setAdding] = useState<string | null>(null);

  if (searchMode !== "network") return null;

  const add = async (item: NetSearchItem) => {
    setAdding(item.url);
    try {
      await createTasksAndRefresh(
        [item.url],
        [
          {
            url: item.url,
            title: item.title,
            thumbnail_url: item.thumbnail_url,
          },
        ],
      );
    } catch (err) {
      pushToast({ kind: "error", title: "添加失败", detail: String(err) });
    } finally {
      setAdding(null);
    }
  };

  const hasSearched = netSearching || Boolean(netSearchId);

  return (
    <section className="net-results" aria-label="网络搜索结果">
      <div className="net-results-head">
        <span className="muted small">
          {netSearching
            ? "正在搜索…"
            : netError
              ? `搜索失败：${netError}`
              : hasSearched
                ? `${netResults.length} 个结果`
                : "输入关键词后按回车搜索"}
        </span>
        {hasSearched && !netSearching && (
          <button type="button" className="net-results-close" onClick={clearNetSearch}>
            清除结果
          </button>
        )}
      </div>
      {!netSearching && !netError && hasSearched && netResults.length === 0 && (
        <p className="muted">未找到相关视频</p>
      )}
      <ul className="net-results-list">
        {netResults.map((item) => (
          <li key={item.url} className="net-result-row">
            {item.thumbnail_url ? (
              <img className="net-thumb" src={item.thumbnail_url} alt="" loading="lazy" />
            ) : (
              <div className="net-thumb net-thumb-placeholder" aria-hidden="true">
                ▶
              </div>
            )}
            <div className="net-info">
              <span className="net-title" title={item.title}>
                {item.title}
              </span>
              <span className="net-meta">
                {[item.uploader, formatDuration(item.duration), item.platform]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </div>
            <button
              type="button"
              className="net-add"
              disabled={adding === item.url}
              onClick={() => void add(item)}
            >
              {adding === item.url ? "添加中…" : "下载"}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
