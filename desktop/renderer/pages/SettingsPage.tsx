import { useEffect, useRef, useState } from "react";

import type { MigrationResult } from "../../electron/preload";
import { request } from "../lib/api";
import type { AppSettings } from "../lib/types";
import { useAppStore } from "../store/appStore";

type SaveState = "idle" | "saving" | "saved" | "error";

type YtDlpInfo = {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  downloadUrl?: string;
};

export function SettingsPage() {
  const settings = useAppStore((s) => s.settings);
  const connection = useAppStore((s) => s.connection);
  const pushToast = useAppStore((s) => s.pushToast);
  const [draft, setDraft] = useState<AppSettings | null>(settings);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [error, setError] = useState("");
  const timer = useRef<number | null>(null);

  const [ytInfo, setYtInfo] = useState<YtDlpInfo | null>(null);
  const [ytBusy, setYtBusy] = useState(false);
  const [ytError, setYtError] = useState("");
  const [migration, setMigration] = useState<MigrationResult | null>(null);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  useEffect(() => {
    const mode = draft?.theme_mode || "system";
    const root = document.documentElement;
    if (mode === "system") {
      void window.api.getNativeTheme().then((resolved) => {
        root.setAttribute("data-theme", resolved);
      });
    } else {
      root.setAttribute("data-theme", mode);
    }
  }, [draft?.theme_mode]);

  useEffect(() => {
    return window.api.onMigration((result) => setMigration(result));
  }, []);

  useEffect(() => {
    if (connection !== "connected") return;
    void request<MigrationResult>("app.runMigration", {})
      .then((r) => setMigration(r))
      .catch(() => undefined);
  }, [connection]);

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

  const checkYtDlp = async () => {
    setYtBusy(true);
    setYtError("");
    try {
      const info = await request<YtDlpInfo>("updater.checkYtDlp", {});
      setYtInfo(info);
      pushToast({
        kind: "info",
        message: info.updateAvailable
          ? `发现新版本 ${info.latestVersion}`
          : `已是最新（${info.currentVersion}）`,
      });
    } catch (err) {
      setYtError(String(err));
    } finally {
      setYtBusy(false);
    }
  };

  const updateYtDlp = async () => {
    setYtBusy(true);
    setYtError("");
    try {
      const result = await request<{ ok: boolean; version: string }>(
        "updater.updateYtDlp",
        ytInfo?.downloadUrl ? { downloadUrl: ytInfo.downloadUrl } : {},
      );
      setYtInfo((prev) =>
        prev
          ? {
              ...prev,
              currentVersion: result.version,
              updateAvailable: false,
            }
          : {
              currentVersion: result.version,
              latestVersion: result.version,
              updateAvailable: false,
            },
      );
      pushToast({ kind: "success", message: `yt-dlp 已更新至 ${result.version}` });
    } catch (err) {
      setYtError(String(err));
      pushToast({ kind: "error", message: "yt-dlp 更新失败" });
    } finally {
      setYtBusy(false);
    }
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

  const migrationLabel =
    migration == null
      ? "尚未查询"
      : migration.status === "migrated"
        ? `已迁移：${migration.message || ""}`
        : migration.status === "failed"
          ? `失败：${migration.message || ""}`
          : migration.message || "无需迁移";

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

      <section className="settings-section">
        <h2>yt-dlp</h2>
        <p className="muted">
          当前版本：{ytInfo?.currentVersion || "点击检查以查询"}
          {ytInfo?.updateAvailable
            ? ` · 可更新至 ${ytInfo.latestVersion}`
            : ytInfo
              ? " · 已是最新"
              : ""}
        </p>
        {ytError && <p className="field-error">{ytError}</p>}
        <div className="settings-control">
          <button
            type="button"
            disabled={disabled || ytBusy}
            onClick={() => void checkYtDlp()}
          >
            检查更新
          </button>
          <button
            type="button"
            disabled={disabled || ytBusy || !ytInfo?.updateAvailable}
            onClick={() => void updateYtDlp()}
          >
            更新 yt-dlp
          </button>
        </div>
      </section>

      <section className="settings-section">
        <h2>数据迁移</h2>
        <p className="muted">{migrationLabel}</p>
        {migration?.details && (
          <p className="muted small">
            历史复制{" "}
            {String(
              (migration.details as { history_copied?: number }).history_copied ?? 0,
            )}{" "}
            条
          </p>
        )}
      </section>

      <p className="muted">更改将自动保存。</p>
    </div>
  );
}
