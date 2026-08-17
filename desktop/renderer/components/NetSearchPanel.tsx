import { useEffect, useRef, useState } from "react";

import { createTasksAndRefresh } from "../lib/addFlow";
import { request } from "../lib/api";
import { platformLabel } from "../lib/format";
import type { NetSearchItem } from "../lib/types";
import { useAppStore } from "../store/appStore";
import { Button } from "./ui/Button";
import { Icon } from "./ui/Icon";
import { TextField } from "./ui/TextField";

const SEARCH_PLATFORMS = [
  { key: "youtube", label: "YouTube" },
  { key: "bilibili", label: "Bilibili" },
  { key: "pornhub", label: "Pornhub" },
] as const;

function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return "";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const h = Math.floor(m / 60);
  if (h > 0) {
    return `${h}:${String(m % 60).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** 网络搜索使用独立主工作区，避免与任务列表形成双滚动和双上下文。 */
export function NetSearchPanel() {
  const searchMode = useAppStore((state) => state.searchMode);
  const netSearching = useAppStore((state) => state.netSearching);
  const netResults = useAppStore((state) => state.netResults);
  const netError = useAppStore((state) => state.netError);
  const netSearchId = useAppStore((state) => state.netSearchId);
  const clearNetSearch = useAppStore((state) => state.clearNetSearch);
  const setSearchMode = useAppStore((state) => state.setSearchMode);
  const startNetSearch = useAppStore((state) => state.startNetSearch);
  const failNetSearch = useAppStore((state) => state.failNetSearch);
  const pushToast = useAppStore((state) => state.pushToast);
  const [query, setQuery] = useState("");
  const [platform, setPlatform] = useState("youtube");
  const [adding, setAdding] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (searchMode === "network") {
      queueMicrotask(() => inputRef.current?.focus());
    }
  }, [searchMode]);

  if (searchMode !== "network") return null;

  const runSearch = async () => {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      inputRef.current?.focus();
      return;
    }

    const searchId = globalThis.crypto.randomUUID();
    startNetSearch(searchId);
    try {
      await request<{ searchId: string }>("search.query", {
        query: normalizedQuery,
        platform,
        maxResults: 12,
        searchId,
      });
    } catch (error) {
      const message = String(error);
      failNetSearch(searchId, message);
      pushToast({ kind: "error", title: "搜索失败", detail: message });
    }
  };

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
    } catch (error) {
      pushToast({ kind: "error", title: "添加失败", detail: String(error) });
    } finally {
      setAdding(null);
    }
  };

  const leaveSearch = () => {
    clearNetSearch();
    setSearchMode("filter");
  };

  const hasSearched = netSearching || Boolean(netSearchId);

  return (
    <section className="net-search-workspace" aria-label="网络搜索结果">
      <header className="net-search-workspace__header">
        <div className="net-search-workspace__title-row">
          <div>
            <h1>网络视频</h1>
            <p>搜索视频平台，找到后直接加入下载列表。</p>
          </div>
          <Button variant="ghost" onClick={leaveSearch}>
            返回下载列表
          </Button>
        </div>
        <form
          className="net-search-form"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            void runSearch();
          }}
        >
          <select
            aria-label="搜索平台"
            value={platform}
            onChange={(event) => setPlatform(event.target.value)}
          >
            {SEARCH_PLATFORMS.map((item) => (
              <option key={item.key} value={item.key}>
                {item.label}
              </option>
            ))}
          </select>
          <TextField
            ref={inputRef}
            leadingIcon="search"
            type="search"
            aria-label="搜索网络视频"
            placeholder="输入视频名称或关键词"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <Button
            type="submit"
            variant="primary"
            leadingIcon="search"
            loading={netSearching}
          >
            搜索
          </Button>
        </form>
      </header>

      <div
        className="net-search-workspace__body"
        aria-live="polite"
        aria-busy={netSearching}
      >
        <div className="net-results-head">
          <span className="net-results-summary">
            {netSearching
              ? "正在搜索…"
              : netError
                ? "搜索没有完成"
                : hasSearched
                  ? `${netResults.length} 个结果`
                  : "等待搜索"}
          </span>
          {hasSearched && !netSearching && (
            <Button size="small" variant="ghost" onClick={clearNetSearch}>
              清除结果
            </Button>
          )}
        </div>

        {netSearching ? (
          <div className="net-search-state">
            <Icon name="search" size={20} />
            <strong>正在查找视频</strong>
            <span>搜索完成后，结果会显示在这里。</span>
          </div>
        ) : netError ? (
          <div className="net-search-state" role="alert">
            <strong>搜索失败</strong>
            <span>{netError}</span>
            <Button size="small" onClick={() => void runSearch()}>
              重试
            </Button>
          </div>
        ) : !hasSearched ? (
          <div className="net-search-state">
            <Icon name="search" size={20} />
            <strong>搜索你想下载的视频</strong>
            <span>选择平台，输入关键词，然后开始搜索。</span>
          </div>
        ) : netResults.length === 0 ? (
          <div className="net-search-state">
            <strong>没有找到相关视频</strong>
            <span>换一个关键词，或尝试其他平台。</span>
          </div>
        ) : (
          <ul className="net-results-list">
            {netResults.map((item) => (
              <li key={item.url} className="net-result-row">
                {item.thumbnail_url ? (
                  <img
                    className="net-thumb"
                    src={item.thumbnail_url}
                    alt=""
                    loading="lazy"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <div className="net-thumb net-thumb-placeholder" aria-hidden="true">
                    <Icon name="play" size={18} />
                  </div>
                )}
                <div className="net-info">
                  <span className="net-title" title={item.title}>
                    {item.title}
                  </span>
                  <span className="net-meta">
                    {[item.uploader, formatDuration(item.duration), platformLabel(item.platform)]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </div>
                <Button
                  className="net-add"
                  size="small"
                  leadingIcon="download"
                  disabled={adding === item.url}
                  onClick={() => void add(item)}
                >
                  {adding === item.url ? "添加中…" : "下载"}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
