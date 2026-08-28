import { useEffect, useRef, useState } from "react";

import type { MigrationResult } from "../electron/preload";
import { ConnectionGate } from "./components/ConnectionGate";
import { SitesPanel } from "./components/SitesPanel";
import { TelegramSettingsTab } from "./components/TelegramSettingsTab";
import { ToastHost } from "./components/ToastHost";
import { request } from "./lib/api";
import { setLocale, t, useLocale, type Locale } from "./i18n";
import { useDocumentTheme } from "./lib/documentTheme";
import {
  subtitleModeFromSettings,
  subtitleModePatch,
  type SubtitleMode,
} from "./lib/outputSettings";
import type { AppSettings } from "./lib/types";
import { appUpdateToast, safeVersion } from "./lib/updatePresentation";
import { startSettingsSession } from "./lib/settingsSession";
import { useAppStore } from "./store/appStore";

type SaveState = "idle" | "saving" | "saved" | "error";

type YtDlpInfo = {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  downloadUrl?: string;
};

type TabKey = "general" | "quality" | "postprocess" | "appearance" | "telegram";

const TABS: { key: TabKey; labelKey: string }[] = [
  { key: "general", labelKey: "settings.general" },
  { key: "quality", labelKey: "settings.quality" },
  { key: "postprocess", labelKey: "settings.postprocess" },
  { key: "appearance", labelKey: "settings.appearance" },
  { key: "telegram", labelKey: "Telegram" },
];

function useBootstrap() {
  const themeMode = useAppStore((s) => s.settings?.theme_mode);

  useDocumentTheme(themeMode);

  useEffect(() => startSettingsSession(window.api), []);

}

interface TabProps {
  draft: AppSettings;
  disabled: boolean;
  update: (partial: Partial<AppSettings>) => void;
  pickDir: () => Promise<void>;
}

function GeneralTab({ draft, disabled, update, pickDir }: TabProps) {
  const locale = useLocale();
  return (
    <div className="settings-grid">
      <label className="settings-row">
        <span>{t("settings.downloadDir", locale)}</span>
        <div className="settings-control">
          <input
            value={draft.download_dir}
            disabled={disabled}
            onChange={(e) => update({ download_dir: e.target.value })}
          />
          <button type="button" disabled={disabled} onClick={() => void pickDir()}>
            {t("settings.chooseDir", locale)}
          </button>
        </div>
      </label>

      <label className="settings-row">
        <span>{t("settings.concurrent", locale)}</span>
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
        <span>{t("settings.speedLimit", locale)}</span>
        <input
          type="number"
          min={0}
          value={draft.speed_limit}
          disabled={disabled}
          onChange={(e) => update({ speed_limit: Number(e.target.value) })}
        />
      </label>

      <label className="settings-row">
        <span>{t("settings.cookies", locale)}</span>
        <select
          value={draft.cookies_from_browser || ""}
          disabled={disabled}
          onChange={(e) => update({ cookies_from_browser: e.target.value })}
        >
          <option value="">{t("settings.noCookies", locale)}</option>
          <option value="chrome">Chrome</option>
          {window.api?.platform === "darwin" && <option value="safari">Safari</option>}
          <option value="firefox">Firefox</option>
          <option value="edge">Edge</option>
        </select>
      </label>

      <label className="settings-row">
        <span>{t("settings.metadata", locale)}</span>
        <input
          type="checkbox"
          checked={draft.embed_metadata !== false}
          disabled={disabled}
          onChange={(e) => update({ embed_metadata: e.target.checked })}
        />
      </label>
      <p className="muted small">{t("settings.metadataHint", locale)}</p>

      <label className="settings-row">
        <span>{t("settings.fragments", locale)}</span>
        <input
          type="number"
          min={0}
          max={32}
          value={draft.concurrent_fragments ?? 4}
          disabled={disabled}
          onChange={(e) => update({ concurrent_fragments: Number(e.target.value) })}
        />
      </label>

      <label className="settings-row">
        <span>{t("settings.telemetry", locale)}</span>
        <input
          type="checkbox"
          checked={Boolean(draft.telemetry_enabled)}
          disabled={disabled}
          onChange={(e) => update({ telemetry_enabled: e.target.checked })}
        />
      </label>

      <label className="settings-row">
        <span>{t("settings.language", locale)}</span>
        <select
          value={locale}
          disabled={disabled}
          onChange={(e) => {
            setLocale(e.target.value as Locale);
          }}
        >
          <option value="zh-CN">简体中文</option>
          <option value="en">English</option>
        </select>
      </label>

      <SitesPanel />

      <label className="settings-row">
        <span>{t("settings.clipboard", locale)}</span>
        <input
          type="checkbox"
          checked={Boolean(draft.clipboard_monitor)}
          disabled={disabled}
          onChange={(e) => update({ clipboard_monitor: e.target.checked })}
        />
      </label>

      <label className="settings-row">
        <span>{t("settings.proxyEnabled", locale)}</span>
        <input
          type="checkbox"
          checked={Boolean(draft.proxy_enabled)}
          disabled={disabled}
          onChange={(e) => update({ proxy_enabled: e.target.checked })}
        />
      </label>

      <label className="settings-row">
        <span>{t("settings.proxyUrl", locale)}</span>
        <input
          value={draft.proxy_url}
          disabled={disabled || !draft.proxy_enabled}
          aria-invalid={draft.proxy_enabled && !draft.proxy_url.trim()}
          onChange={(e) => update({ proxy_url: e.target.value })}
        />
      </label>
    </div>
  );
}

function QualityTab({ draft, disabled, update }: TabProps) {
  const locale = useLocale();
  const subtitleMode = subtitleModeFromSettings(draft);
  const mp3UsesExternalSubtitles =
    draft.postprocessing === "mp3" &&
    (subtitleMode === "embedded" || subtitleMode === "both");

  return (
    <div className="settings-grid">
      <label className="settings-row">
        <span>{t("settings.defaultQuality", locale)}</span>
        <select
          value={draft.default_quality}
          disabled={disabled}
          onChange={(e) => update({ default_quality: e.target.value })}
        >
          <option value="best">{t("settings.best", locale)}</option>
          <option value="1080p">1080p</option>
          <option value="720p">720p</option>
          <option value="480p">480p</option>
        </select>
      </label>

      <label className="settings-row">
        <span>{t("settings.askQuality", locale)}</span>
        <input
          type="checkbox"
          checked={draft.auto_start_downloads === false}
          disabled={disabled}
          onChange={(e) => update({ auto_start_downloads: !e.target.checked })}
        />
      </label>

      <label className="settings-row">
        <span>{t("settings.subtitles", locale)}</span>
        <select
          value={subtitleMode}
          disabled={disabled}
          onChange={(e) =>
            update(subtitleModePatch(e.target.value as SubtitleMode))
          }
        >
          <option value="none">{t("settings.subtitlesNone", locale)}</option>
          <option value="external">{t("settings.subtitlesExternal", locale)}</option>
          <option value="embedded">{t("settings.subtitlesEmbedded", locale)}</option>
          <option value="both">{t("settings.subtitlesBoth", locale)}</option>
        </select>
      </label>

      <label className="settings-row">
        <span>{t("settings.subtitleLanguages", locale)}</span>
        <input
          value={draft.subtitle_langs || ""}
          disabled={disabled}
          placeholder={t("settings.subtitleHint", locale)}
          onChange={(e) => update({ subtitle_langs: e.target.value })}
        />
      </label>

      {mp3UsesExternalSubtitles ? (
        <p className="muted small">
          {t("settings.mp3Subtitles", locale)}
        </p>
      ) : null}
    </div>
  );
}

function PostprocessTab({ draft, disabled, update }: TabProps) {
  return (
    <div className="settings-grid">
      <label className="settings-row">
        <span>默认后处理</span>
        <select
          value={draft.postprocessing || "none"}
          disabled={disabled}
          onChange={(e) => update({ postprocessing: e.target.value })}
        >
          <option value="none">无</option>
          <option value="mp4">转换为 MP4</option>
          <option value="mp3">提取音频 (MP3)</option>
          <option value="script">自定义脚本</option>
        </select>
      </label>

      {draft.postprocessing === "script" && (
        <>
          <label className="settings-row">
            <span>后处理脚本</span>
            <input
              value={draft.postprocess_script || ""}
              disabled={disabled}
              placeholder="例如：/Users/me/bin/process {file}"
              onChange={(e) => update({ postprocess_script: e.target.value })}
            />
          </label>
          <p className="muted small">
            {"{file}"} 会被替换为下载完成的文件路径；脚本在每次下载完成后执行，请只填写可信命令。
          </p>
        </>
      )}

      <label className="settings-row">
        <span>文件名模板</span>
        <input
          value={draft.filename_template || ""}
          disabled={disabled}
          placeholder="%(title)s.%(ext)s（留空使用默认）"
          onChange={(e) => update({ filename_template: e.target.value })}
        />
      </label>
      <p className="muted small">
        支持占位符：%(title)s、%(uploader)s、%(id)s、%(upload_date)s、%(resolution)s，需包含
        %(ext)s。
      </p>
    </div>
  );
}

function menuBarModeCopy(): { label: string; hint: string } {
  const ua = navigator.userAgent;
  if (ua.includes("Windows")) {
    return {
      label: "关闭时最小化到托盘",
      hint: "开启后关闭主窗口不退出，应用驻留系统托盘，可从托盘恢复或退出。",
    };
  }
  if (ua.includes("Mac")) {
    return {
      label: "菜单栏模式",
      hint: "开启后隐藏 Dock 图标，关闭主窗口不退出，驻留系统菜单栏。",
    };
  }
  return {
    label: "菜单栏模式",
    hint: "开启后关闭主窗口不退出，应用驻留系统托盘。",
  };
}

function AppearanceTab({ draft, disabled, update }: TabProps) {
  const menuBarMode = menuBarModeCopy();
  return (
    <div className="settings-grid">
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

      <label className="settings-row">
        <span>{menuBarMode.label}</span>
        <input
          type="checkbox"
          checked={Boolean(draft.menu_bar_mode)}
          disabled={disabled}
          onChange={(e) => update({ menu_bar_mode: e.target.checked })}
        />
      </label>
      <p className="muted small">{menuBarMode.hint}</p>

      {window.api?.platform === "darwin" && (
        <label className="settings-row">
          <span>Dock 进度条</span>
          <input
            type="checkbox"
            checked={draft.dock_progress !== false}
            disabled={disabled}
            onChange={(e) => update({ dock_progress: e.target.checked })}
          />
        </label>
      )}
    </div>
  );
}

export function SettingsApp() {
  useBootstrap();
  const locale = useLocale();
  const connection = useAppStore((s) => s.connection);
  const settings = useAppStore((s) => s.settings);
  const pushToast = useAppStore((s) => s.pushToast);
  const [draft, setDraft] = useState<AppSettings | null>(settings);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [error, setError] = useState("");
  const [tab, setTab] = useState<TabKey>("general");
  const timer = useRef<number | null>(null);
  const mounted = useRef(true);
  const draftRef = useRef(draft);
  const editVersion = useRef(0);
  const savedVersion = useRef(0);

  const [ytInfo, setYtInfo] = useState<YtDlpInfo | null>(null);
  const [ytBusy, setYtBusy] = useState(false);
  const [ytError, setYtError] = useState("");
  const [migration, setMigration] = useState<MigrationResult | null>(null);
  const [diagBusy, setDiagBusy] = useState(false);
  const [diagPath, setDiagPath] = useState("");
  const [appUpdateBusy, setAppUpdateBusy] = useState(false);
  const [appUpdateMsg, setAppUpdateMsg] = useState("");
  const [appUpdateUrl, setAppUpdateUrl] = useState("");

  useEffect(() => {
    if (editVersion.current !== savedVersion.current) return;
    draftRef.current = settings;
    setDraft(settings);
  }, [settings]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
    };
  }, []);

  useEffect(() => {
    return window.api.onMigration((result) => setMigration(result));
  }, []);

  useEffect(() => {
    if (connection !== "connected") return;
    void request<MigrationResult>("app.runMigration", {})
      .then((r) => setMigration(r))
      .catch(() => undefined);
  }, [connection]);

  const persist = async (next: AppSettings, version: number) => {
    try {
      const updated = await request<AppSettings>("settings.update", next);
      if (!mounted.current || version !== editVersion.current) return;
      savedVersion.current = version;
      draftRef.current = updated;
      setDraft(updated);
      useAppStore.getState().applyEvent({ event: "settings.changed", payload: { settings: updated } });
      setSaveState("saved");
    } catch {
      if (!mounted.current || version !== editVersion.current) return;
      setSaveState("error");
      setError(t("settings.saveFailed"));
    }
  };

  const update = (partial: Partial<AppSettings>) => {
    if (!draftRef.current) return;
    const next = { ...draftRef.current, ...partial };
    const version = ++editVersion.current;
    draftRef.current = next;
    setDraft(next);
    setSaveState("saving");
    setError("");
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      void persist(next, version);
    }, 300);
  };

  const pickDir = async () => {
    try {
      const dir = await window.api.selectDirectory();
      if (dir) update({ download_dir: dir });
    } catch {
      pushToast({ kind: "error", title: t("error.openFolder") });
    }
  };

  const checkYtDlp = async () => {
    setYtBusy(true);
    setYtError("");
    try {
      const info = await request<YtDlpInfo>("updater.checkYtDlp", {});
      setYtInfo(info);
      pushToast({
        kind: "info",
        title: info.updateAvailable
          ? t("settings.toolNew", undefined, { version: safeVersion(info.latestVersion) || "—" })
          : t("settings.toolCurrentResult", undefined, { version: safeVersion(info.currentVersion) || "—" }),
      });
    } catch {
      setYtError(t("settings.toolCheckFailed"));
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
      if (!result.ok || !safeVersion(result.version)) throw new Error("invalid tool update result");
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
      pushToast({ kind: "success", title: t("settings.toolUpdated", undefined, { version: result.version }) });
    } catch {
      setYtError(t("settings.toolUpdateFailed"));
      pushToast({ kind: "error", title: t("settings.toolUpdateFailed") });
    } finally {
      setYtBusy(false);
    }
  };

  const exportDiagnosticsBundle = async () => {
    setDiagBusy(true);
    try {
      const result = await request<{ ok: boolean; path: string }>(
        "app.exportDiagnostics",
        {},
      );
      if (!result.ok || !result.path) throw new Error("diagnostics unavailable");
      setDiagPath(result.path);
      pushToast({ kind: "success", title: t("diagnostics.success") });
      await window.api.showItemInFolder(result.path).catch(() => {
        pushToast({ kind: "info", title: t("diagnostics.revealFailed") });
      });
    } catch {
      pushToast({ kind: "error", title: t("diagnostics.failed") });
    } finally {
      setDiagBusy(false);
    }
  };

  const checkAppUpdate = async () => {
    setAppUpdateBusy(true);
    setAppUpdateUrl("");
    try {
      const info = await window.api.checkAppUpdate();
      const toast = appUpdateToast(info);
      setAppUpdateMsg(toast.title);
      setAppUpdateUrl(info.downloadUrl || "");
      pushToast(toast);
    } catch {
      const message = t("update.failed");
      setAppUpdateMsg(message);
      pushToast({ kind: "error", title: message });
    } finally {
      setAppUpdateBusy(false);
    }
  };

  if (connection === "failed") {
    return (
      <>
        <ConnectionGate />
        <ToastHost />
      </>
    );
  }

  if (!draft) {
    return (
      <div className="settings-shell">
        <p className="muted">{t("settings.loading", locale)}</p>
      </div>
    );
  }

  const disabled = connection !== "connected";
  const statusLabel =
    saveState === "saving"
      ? t("settings.saving", locale)
      : saveState === "saved"
        ? t("settings.saved", locale)
        : saveState === "error"
          ? t("settings.notSaved", locale)
          : "";

  const migrationLabel =
    migration == null
      ? t("settings.migrationPending", locale)
      : migration.status === "migrated"
        ? t("settings.migrationDone", locale)
        : migration.status === "failed"
          ? t("settings.migrationFailed", locale)
          : t("settings.migrationSkipped", locale);

  const tabProps: TabProps = { draft, disabled, update, pickDir };

  return (
    <div className="settings-shell">
      <div className="settings-drag-strip" />
      <header className="row">
        <h1>{t("settings.open", locale)}</h1>
        <span className={`save-state ${saveState}`}>{statusLabel}</span>
      </header>
      {error && <p className="field-error">{error}</p>}

      <nav className="settings-tabs" aria-label={t("settings.categories", locale)}>
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            className={tab === item.key ? "settings-tab active" : "settings-tab"}
            onClick={() => setTab(item.key)}
          >
            {t(item.labelKey, locale)}
          </button>
        ))}
      </nav>

      {tab === "general" && <GeneralTab {...tabProps} />}
      {tab === "quality" && <QualityTab {...tabProps} />}
      {tab === "postprocess" && <PostprocessTab {...tabProps} />}
      {tab === "appearance" && <AppearanceTab {...tabProps} />}
      {tab === "telegram" && <TelegramSettingsTab disabled={disabled} />}

      {tab === "general" && (
        <>
          <section className="settings-section">
            <h2>{t("settings.downloadTool", locale)}</h2>
            <p className="muted">
              {t("settings.toolCurrent", locale, { version: safeVersion(ytInfo?.currentVersion) || t("settings.toolUnknown", locale) })}
              {ytInfo?.updateAvailable
                ? t("settings.toolAvailable", locale, { version: safeVersion(ytInfo.latestVersion) || "—" })
                : ytInfo
                  ? t("settings.toolLatest", locale)
                  : ""}
            </p>
            {ytError && <p className="field-error">{ytError}</p>}
            <div className="settings-control">
              <button
                type="button"
                disabled={disabled || ytBusy}
                onClick={() => void checkYtDlp()}
              >
                {t("settings.toolCheck", locale)}
              </button>
              <button
                type="button"
                disabled={disabled || ytBusy || !ytInfo?.updateAvailable}
                onClick={() => void updateYtDlp()}
              >
                {t("settings.toolUpdate", locale)}
              </button>
            </div>
          </section>

          <section className="settings-section">
            <h2>{t("settings.migration", locale)}</h2>
            <p className="muted">{migrationLabel}</p>
            {migration?.details && (
              <p className="muted small">
                {t("settings.historyCopied", locale, {
                  count: Math.max(0, Number(migration.details.history_copied) || 0),
                })}
              </p>
            )}
          </section>

          <section className="settings-section">
            <h2>{t("update.title", locale)}</h2>
            <p className="muted">
              {t("update.copy", locale)}
            </p>
            {appUpdateMsg && <p className="muted small">{appUpdateMsg}</p>}
            <div className="settings-control">
              <button
                type="button"
                disabled={disabled || appUpdateBusy}
                onClick={() => void checkAppUpdate()}
              >
                {t(appUpdateBusy ? "update.checking" : "update.check", locale)}
              </button>
              <button
                type="button"
                disabled={disabled || !appUpdateUrl}
                onClick={() => {
                  void window.api.openExternal(appUpdateUrl).catch(() => {
                    pushToast({ kind: "error", title: t("update.openFailed") });
                  });
                }}
              >
                {t("update.download", locale)}
              </button>
            </div>
          </section>

          <section className="settings-section">
            <h2>{t("diagnostics.title", locale)}</h2>
            <p className="muted">
              {t("diagnostics.copy", locale)}
            </p>
            {diagPath && <p className="muted small">{diagPath}</p>}
            <div className="settings-control">
              <button
                type="button"
                disabled={disabled || diagBusy}
                onClick={() => void exportDiagnosticsBundle()}
              >
                {t(diagBusy ? "diagnostics.exporting" : "diagnostics.export", locale)}
              </button>
            </div>
          </section>
        </>
      )}

      <p className="muted">{t("settings.autoSave", locale)}</p>
      <ToastHost />
    </div>
  );
}
