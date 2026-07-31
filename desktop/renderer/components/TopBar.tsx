import { useEffect, useRef, useState } from "react";

import { request } from "../lib/api";
import { submitAddText } from "../lib/addFlow";
import type { ListFilter, SearchMode } from "../lib/types";
import { useAppStore } from "../store/appStore";
import { NetSearchPanel } from "./NetSearchPanel";

const SEGMENTS: { key: ListFilter; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "active", label: "进行中" },
  { key: "completed", label: "已完成" },
  { key: "history", label: "历史" },
];

const SEARCH_MODES: { key: SearchMode; label: string; hint: string }[] = [
  { key: "filter", label: "列表", hint: "过滤当前列表" },
  { key: "network", label: "网络", hint: "在视频平台内搜索" },
];

const SEARCH_PLATFORMS = [
  { key: "youtube", label: "YouTube" },
  { key: "bilibili", label: "Bilibili" },
  { key: "pornhub", label: "Pornhub" },
];

export function TopBar() {
  const connection = useAppStore((s) => s.connection);
  const filter = useAppStore((s) => s.filter);
  const setFilter = useAppStore((s) => s.setFilter);
  const searchQuery = useAppStore((s) => s.searchQuery);
  const setSearchQuery = useAppStore((s) => s.setSearchQuery);
  const searchMode = useAppStore((s) => s.searchMode);
  const setSearchMode = useAppStore((s) => s.setSearchMode);
  const addFocusSignal = useAppStore((s) => s.addFocusSignal);
  const pushToast = useAppStore((s) => s.pushToast);

  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [netPlatform, setNetPlatform] = useState("youtube");
  const addRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    if (addFocusSignal > 0) addRef.current?.focus();
  }, [addFocusSignal]);

  useEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const onToggle = () => {
      if (!el.open) return;
      document
        .querySelectorAll<HTMLDetailsElement>(
          "details.card-menu[open], details.topbar-menu[open]",
        )
        .forEach((other) => {
          if (other !== el) other.open = false;
        });
    };
    el.addEventListener("toggle", onToggle);
    return () => el.removeEventListener("toggle", onToggle);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      if (e.key === "n") {
        e.preventDefault();
        addRef.current?.focus();
      } else if (e.key === "f") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const disabled = connection !== "connected";

  const addUrls = async (raw: string) => {
    setBusy(true);
    try {
      const urls = await submitAddText(raw);
      if (urls.length > 0) setText("");
    } finally {
      setBusy(false);
    }
  };

  const runNetSearch = async () => {
    const query = searchQuery.trim();
    if (!query) return;
    try {
      const resp = await request<{ searchId: string }>("search.query", {
        query,
        platform: netPlatform,
        maxResults: 12,
      });
      useAppStore.getState().startNetSearch(resp.searchId);
    } catch (err) {
      pushToast({ kind: "error", title: "搜索失败", detail: String(err) });
    }
  };

  const batch = async (method: string, okMsg: string) => {
    if (menuRef.current) menuRef.current.open = false;
    try {
      await request(method, {});
      const snap = await request("app.getSnapshot");
      useAppStore.getState().hydrateSnapshot(snap as never);
      pushToast({ kind: "success", title: okMsg });
    } catch (err) {
      pushToast({ kind: "error", title: "操作失败", detail: String(err) });
    }
  };

  return (
    <header className="topbar">
      <div className="topbar-row">
        <input
          ref={addRef}
          className="topbar-add"
          type="text"
          placeholder="粘贴链接，回车开始下载…"
          value={text}
          disabled={disabled || busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void addUrls(text);
            }
          }}
          aria-label="添加下载链接"
        />
        <div className="topbar-search-wrap">
          <div className="search-mode-toggle" role="group" aria-label="搜索模式">
            {SEARCH_MODES.map((mode) => (
              <button
                key={mode.key}
                type="button"
                title={mode.hint}
                className={searchMode === mode.key ? "mode active" : "mode"}
                onClick={() => setSearchMode(mode.key)}
              >
                {mode.label}
              </button>
            ))}
          </div>
          {searchMode === "network" && (
            <select
              className="net-platform"
              value={netPlatform}
              onChange={(e) => setNetPlatform(e.target.value)}
              aria-label="搜索平台"
            >
              {SEARCH_PLATFORMS.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
          )}
          <input
            ref={searchRef}
            className="topbar-search"
            type="search"
            placeholder={searchMode === "network" ? "搜索网络视频，回车搜索…" : "过滤列表"}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && searchMode === "network") {
                e.preventDefault();
                void runNetSearch();
              }
            }}
            aria-label="搜索"
          />
        </div>
        <details className="topbar-menu" ref={menuRef}>
          <summary aria-label="批量操作">⋯</summary>
          <div className="topbar-menu-list" role="menu">
            <button
              type="button"
              disabled={disabled}
              onClick={() => void batch("download.pauseAll", "已全部暂停")}
            >
              全部暂停
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => void batch("download.resumeAll", "已全部恢复")}
            >
              全部恢复
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => void batch("download.clearFinished", "已清除完成项")}
            >
              清除已完成
            </button>
          </div>
        </details>
        <button
          type="button"
          className="topbar-settings"
          title="设置 (⌘,)"
          aria-label="设置"
          onClick={() => void window.api.openSettings()}
        >
          ⚙
        </button>
      </div>
      <nav className="segments" aria-label="列表过滤">
        {SEGMENTS.map((seg) => (
          <button
            key={seg.key}
            type="button"
            className={filter === seg.key ? "segment active" : "segment"}
            onClick={() => setFilter(seg.key)}
          >
            {seg.label}
          </button>
        ))}
      </nav>
      <NetSearchPanel />
    </header>
  );
}
