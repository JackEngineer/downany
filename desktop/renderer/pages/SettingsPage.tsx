import { useEffect, useRef, useState } from "react";

import { request } from "../lib/api";
import type { AppSettings } from "../lib/types";
import { useAppStore } from "../store/appStore";

type SaveState = "idle" | "saving" | "saved" | "error";

export function SettingsPage() {
  const settings = useAppStore((s) => s.settings);
  const connection = useAppStore((s) => s.connection);
  const [draft, setDraft] = useState<AppSettings | null>(settings);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [error, setError] = useState("");
  const timer = useRef<number | null>(null);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  useEffect(() => {
    const mode = draft?.theme_mode || "system";
    const root = document.documentElement;
    if (mode === "system") {
      root.removeAttribute("data-theme");
    } else {
      root.setAttribute("data-theme", mode);
    }
  }, [draft?.theme_mode]);

  const persist = async (next: AppSettings) => {
    setSaveState("saving");
    setError("");
    try {
      const updated = await request<AppSettings>("settings.update", next);
      useAppStore.setState({ settings: updated });
      setSaveState("saved");
    } catch (err) {
      setSaveState("error");
      setError(String(err));
    }
  };

  const update = (partial: Partial<AppSettings>) => {
    if (!draft) return;
    const next = { ...draft, ...partial };
    setDraft(next);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void persist(next), 300);
  };

  const pickDir = async () => {
    const dir = await window.api.selectDirectory();
    if (dir) update({ download_dir: dir });
  };

  if (!draft) {
    return (
      <div className="page">
        <h1>设置</h1>
        <p className="muted">正在加载…</p>
      </div>
    );
  }

  const disabled = connection !== "connected";
  const statusLabel =
    saveState === "saving"
      ? "正在保存…"
      : saveState === "saved"
        ? "已保存"
        : saveState === "error"
          ? "输入有误"
          : "";

  return (
    <div className="page">
      <header className="page-header row">
        <h1>设置</h1>
        <span className={`save-state ${saveState}`}>{statusLabel}</span>
      </header>
      {error && <p className="field-error">{error}</p>}

      <div className="settings-grid">
        <label className="settings-row">
          <span>下载目录</span>
          <div className="settings-control">
            <input
              value={draft.download_dir}
              disabled={disabled}
              onChange={(e) => update({ download_dir: e.target.value })}
            />
            <button type="button" disabled={disabled} onClick={() => void pickDir()}>
              选择…
            </button>
          </div>
        </label>

        <label className="settings-row">
          <span>并发下载</span>
          <input
            type="number"
            min={1}
            max={10}
            value={draft.concurrent_downloads}
            disabled={disabled}
            onChange={(e) => update({ concurrent_downloads: Number(e.target.value) })}
          />
        </label>

        <label className="settings-row">
          <span>速度限制 (B/s，0=不限)</span>
          <input
            type="number"
            min={0}
            value={draft.speed_limit}
            disabled={disabled}
            onChange={(e) => update({ speed_limit: Number(e.target.value) })}
          />
        </label>

        <label className="settings-row">
          <span>默认画质</span>
          <select
            value={draft.default_quality}
            disabled={disabled}
            onChange={(e) => update({ default_quality: e.target.value })}
          >
            <option value="best">最佳</option>
            <option value="1080p">1080p</option>
            <option value="720p">720p</option>
            <option value="480p">480p</option>
          </select>
        </label>

        <label className="settings-row">
          <span>下载字幕</span>
          <input
            type="checkbox"
            checked={Boolean(draft.download_subtitles)}
            disabled={disabled}
            onChange={(e) => update({ download_subtitles: e.target.checked })}
          />
        </label>

        <label className="settings-row">
          <span>启用代理</span>
          <input
            type="checkbox"
            checked={Boolean(draft.proxy_enabled)}
            disabled={disabled}
            onChange={(e) => update({ proxy_enabled: e.target.checked })}
          />
        </label>

        <label className="settings-row">
          <span>代理地址</span>
          <input
            value={draft.proxy_url}
            disabled={disabled || !draft.proxy_enabled}
            aria-invalid={draft.proxy_enabled && !draft.proxy_url.trim()}
            onChange={(e) => update({ proxy_url: e.target.value })}
          />
        </label>

        <label className="settings-row">
          <span>主题</span>
          <select
            value={draft.theme_mode}
            disabled={disabled}
            onChange={(e) =>
              update({ theme_mode: e.target.value as AppSettings["theme_mode"] })
            }
          >
            <option value="system">跟随系统</option>
            <option value="light">浅色</option>
            <option value="dark">深色</option>
          </select>
        </label>
      </div>

      <p className="muted">更改将自动保存。</p>
    </div>
  );
}
