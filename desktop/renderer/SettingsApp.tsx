import { useEffect, useRef, useState, useId, cloneElement, isValidElement, type ReactNode } from "react";

import type { MigrationResult, SettingsFocus } from "../electron/preload";
import { Icon, type IconName } from "./components/ui/Icon";
import { RuntimeStatus } from "./components/RuntimeStatus";
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
  pendingVersion?: string;
};

type EngineStateInfo = { recoveryRequired?: unknown; current?: { version?: unknown; selection?: unknown }; pending?: { version?: unknown; sha256?: unknown } | null };
type EngineUpdateResult = { ok?: unknown; state?: unknown; version?: unknown; currentVersion?: unknown };
type EngineUpdateOutcome = "prepared" | "rolled_back" | "failed" | null;

type TabKey = "general" | "output" | "appearance" | "network" | "telegram" | "advanced" | "about";

const SETTINGS_FOCUS_IDS: Record<SettingsFocus, string> = {
  cookies: "settings-focus-cookies", network: "settings-focus-network",
  downloadTool: "settings-focus-download-tool", download: "settings-focus-download",
};
const FOCUS_TABS: Record<SettingsFocus, TabKey> = {
  cookies: "network", network: "network", downloadTool: "about", download: "general",
};
function focusSettingsControl(focus: SettingsFocus): boolean {
  const control = document.getElementById(SETTINGS_FOCUS_IDS[focus]);
  if (!control) return false;
  control.scrollIntoView?.({ block: "center" });
  control.focus();
  return true;
}
const TABS: { key: TabKey; labelKey: string; icon: IconName; group: "everyday" | "more" }[] = [
  { key: "general", labelKey: "settings.nav.download", icon: "download", group: "everyday" },
  { key: "output", labelKey: "settings.nav.output", icon: "folder", group: "everyday" },
  { key: "appearance", labelKey: "settings.nav.appearance", icon: "settings", group: "everyday" },
  { key: "network", labelKey: "settings.nav.network", icon: "link", group: "everyday" },
  { key: "telegram", labelKey: "Telegram", icon: "open", group: "more" },
  { key: "advanced", labelKey: "settings.nav.advanced", icon: "settings", group: "more" },
  { key: "about", labelKey: "settings.nav.about", icon: "more", group: "more" },
];
function useBootstrap() {
  useDocumentTheme(useAppStore((s) => s.settings?.theme_mode));
  useEffect(() => startSettingsSession(window.api), []);
}
interface TabProps {
  draft: AppSettings; disabled: boolean;
  update: (partial: Partial<AppSettings>) => void; pickDir: () => Promise<void>;
}
function SettingRow({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  const id = useId();
  const control = isValidElement<{ "aria-labelledby"?: string; "aria-describedby"?: string }>(children)
    && (children.type === "input" || children.type === "select")
    ? cloneElement(children, { "aria-labelledby": `${id}-title`, "aria-describedby": hint ? `${id}-hint` : undefined })
    : children;
  return <label className="settings-row">
    <span className="settings-row__copy"><span id={`${id}-title`} className="settings-row__title">{title}</span>{hint && <small id={`${id}-hint`}>{hint}</small>}</span>
    <span className="settings-row__control">{control}</span>
  </label>;
}
function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return <section className="settings-group"><h2>{title}</h2><div className="settings-card">{children}</div></section>;
}
function GeneralTab({ draft, disabled, update, pickDir }: TabProps) {
  const locale = useLocale();
  return <div className="settings-grid">
    <SettingsGroup title={t("settings.group.destination", locale)}>
      <SettingRow title={t("settings.downloadDir", locale)} hint={t("settings.hint.directory", locale)}>
        <span className="settings-control settings-control--directory">
          <input id="settings-focus-download" title={draft.download_dir} aria-label={t("settings.downloadDir", locale)} value={draft.download_dir} disabled={disabled} onChange={(e) => update({ download_dir: e.target.value })} />
          <button type="button" disabled={disabled} onClick={() => void pickDir()}>{t("settings.chooseDir", locale)}</button>
        </span>
      </SettingRow>
    </SettingsGroup>
    <SettingsGroup title={t("settings.group.defaults", locale)}>
      <SettingRow title={t("settings.defaultQuality", locale)} hint={t("settings.hint.quality", locale)}>
        <select value={draft.default_quality} disabled={disabled} onChange={(e) => update({ default_quality: e.target.value })}>
          <option value="best">{t("settings.best", locale)}</option>{["1080p", "720p", "480p"].map(v => <option key={v} value={v}>{v}</option>)}
        </select>
      </SettingRow>
      <SettingRow title={t("settings.askQuality", locale)} hint={t("settings.hint.confirm", locale)}>
        <input type="checkbox" checked={draft.auto_start_downloads === false} disabled={disabled} onChange={(e) => update({ auto_start_downloads: !e.target.checked })} />
      </SettingRow>
      <SettingRow title={t("settings.concurrent", locale)} hint={t("settings.hint.concurrent", locale)}>
        <input type="number" min={1} max={10} value={draft.concurrent_downloads} disabled={disabled} onChange={(e) => update({ concurrent_downloads: Number(e.target.value) })} />
      </SettingRow>
    </SettingsGroup>
  </div>;
}
function OutputTab({ draft, disabled, update }: TabProps) {
  const locale = useLocale();
  const subtitleMode = subtitleModeFromSettings(draft);
  const mp3UsesExternalSubtitles = draft.postprocessing === "mp3" && (subtitleMode === "embedded" || subtitleMode === "both");
  return <div className="settings-grid">
    <SettingsGroup title={t("settings.group.format", locale)}>
      <SettingRow title={t("settings.postprocess", locale)} hint={t("settings.hint.format", locale)}>
        <select value={draft.postprocessing || "none"} disabled={disabled} onChange={(e) => update({ postprocessing: e.target.value })}>
          <option value="none">{t("settings.formatOriginal", locale)}</option><option value="mp4">{t("settings.formatMP4", locale)}</option><option value="mp3">{t("settings.formatMP3", locale)}</option><option value="script">{t("settings.formatScript", locale)}</option>
        </select>
      </SettingRow>
      {draft.postprocessing === "script" && <SettingRow title={t("settings.script", locale)} hint={t("settings.hint.script", locale)}>
        <input value={draft.postprocess_script || ""} disabled={disabled} onChange={(e) => update({ postprocess_script: e.target.value })} />
      </SettingRow>}
      <SettingRow title={t("settings.metadata", locale)} hint={t("settings.metadataHint", locale)}>
        <input type="checkbox" checked={draft.embed_metadata !== false} disabled={disabled} onChange={(e) => update({ embed_metadata: e.target.checked })} />
      </SettingRow>
    </SettingsGroup>
    <SettingsGroup title={t("settings.subtitles", locale)}>
      <SettingRow title={t("settings.subtitles", locale)} hint={t("settings.hint.subtitles", locale)}>
        <select value={subtitleMode} disabled={disabled} onChange={(e) => update(subtitleModePatch(e.target.value as SubtitleMode))}>
          <option value="none">{t("settings.subtitlesNone", locale)}</option><option value="external">{t("settings.subtitlesExternal", locale)}</option><option value="embedded">{t("settings.subtitlesEmbedded", locale)}</option><option value="both">{t("settings.subtitlesBoth", locale)}</option>
        </select>
      </SettingRow>
      <SettingRow title={t("settings.subtitleLanguages", locale)} hint={t("settings.subtitleHint", locale)}>
        <input value={draft.subtitle_langs || ""} disabled={disabled} placeholder="zh-Hans,en" onChange={(e) => update({ subtitle_langs: e.target.value })} />
      </SettingRow>
      {mp3UsesExternalSubtitles && <p className="settings-card__note" role="status">{t("settings.mp3Subtitles", locale)}</p>}
    </SettingsGroup>
  </div>;
}
function NetworkTab({ draft, disabled, update }: TabProps) {
  const locale = useLocale();
  return <div className="settings-grid">
    <SettingsGroup title={t("settings.group.account", locale)}>
      <SettingRow title={t("settings.cookies", locale)} hint={t("settings.hint.account", locale)}>
        <select id="settings-focus-cookies" value={draft.cookies_from_browser || ""} disabled={disabled} onChange={(e) => update({ cookies_from_browser: e.target.value })}>
          <option value="">{t("settings.noCookies", locale)}</option><option value="chrome">Chrome</option>{window.api?.platform === "darwin" && <option value="safari">Safari</option>}<option value="firefox">Firefox</option><option value="edge">Edge</option>
        </select>
      </SettingRow>
    </SettingsGroup>
    <SettingsGroup title={t("settings.group.proxy", locale)}>
      <SettingRow title={t("settings.proxyEnabled", locale)} hint={t("settings.hint.proxy", locale)}>
        <input id="settings-focus-network" type="checkbox" checked={Boolean(draft.proxy_enabled)} disabled={disabled} onChange={(e) => update({ proxy_enabled: e.target.checked })} />
      </SettingRow>
      <SettingRow title={t("settings.proxyUrl", locale)} hint="http://127.0.0.1:7890 / socks5://127.0.0.1:1080">
        <input value={draft.proxy_url} disabled={disabled || !draft.proxy_enabled} aria-invalid={draft.proxy_enabled && !draft.proxy_url.trim()} onChange={(e) => update({ proxy_url: e.target.value })} />
      </SettingRow>
    </SettingsGroup>
  </div>;
}
function AdvancedTab({ draft, disabled, update }: TabProps) {
  const locale = useLocale();
  return <div className="settings-grid">
    <SettingsGroup title={t("settings.group.transfer", locale)}>
      <SettingRow title={t("settings.speedLimit", locale)} hint={t("settings.hint.speed", locale)}>
        <input type="number" min={0} value={draft.speed_limit} disabled={disabled} onChange={(e) => update({ speed_limit: Number(e.target.value) })} />
      </SettingRow>
      <SettingRow title={t("settings.fragments", locale)} hint={t("settings.hint.fragments", locale)}>
        <input type="number" min={0} max={32} value={draft.concurrent_fragments ?? 4} disabled={disabled} onChange={(e) => update({ concurrent_fragments: Number(e.target.value) })} />
      </SettingRow>
    </SettingsGroup>
    <SettingsGroup title={t("settings.group.naming", locale)}>
      <SettingRow title={t("settings.filenameTemplate", locale)} hint={t("settings.hint.filename", locale)}>
        <input value={draft.filename_template || ""} disabled={disabled} placeholder="%(title)s.%(ext)s" onChange={(e) => update({ filename_template: e.target.value })} />
      </SettingRow>
    </SettingsGroup>
    <SettingsGroup title={t("settings.group.privacy", locale)}>
      <SettingRow title={t("settings.telemetry", locale)} hint={t("settings.hint.telemetry", locale)}>
        <input type="checkbox" checked={Boolean(draft.telemetry_enabled)} disabled={disabled} onChange={(e) => update({ telemetry_enabled: e.target.checked })} />
      </SettingRow>
    </SettingsGroup>
  </div>;
}
function AppearanceTab({ draft, disabled, update }: TabProps) {
  const locale = useLocale();
  const isMac = window.api?.platform === "darwin";
  return <div className="settings-grid">
    <SettingsGroup title={t("settings.group.display", locale)}>
      <SettingRow title={t("settings.theme", locale)} hint={t("settings.hint.theme", locale)}>
        <select value={draft.theme_mode} disabled={disabled} onChange={(e) => update({ theme_mode: e.target.value as AppSettings["theme_mode"] })}>
          <option value="system">{t("settings.themeSystem", locale)}</option><option value="light">{t("settings.themeLight", locale)}</option><option value="dark">{t("settings.themeDark", locale)}</option>
        </select>
      </SettingRow>
      <SettingRow title={t("settings.language", locale)} hint={t("settings.hint.language", locale)}>
        <select value={locale} disabled={disabled} onChange={(e) => setLocale(e.target.value as Locale)}><option value="zh-CN">简体中文</option><option value="en">English</option></select>
      </SettingRow>
    </SettingsGroup>
    <SettingsGroup title={t("settings.group.behavior", locale)}>
      <SettingRow title={t("settings.clipboard", locale)} hint={t("settings.hint.clipboard", locale)}>
        <input type="checkbox" checked={Boolean(draft.clipboard_monitor)} disabled={disabled} onChange={(e) => update({ clipboard_monitor: e.target.checked })} />
      </SettingRow>
      <SettingRow title={t(isMac ? "settings.menuBar" : "settings.tray", locale)} hint={t(isMac ? "settings.hint.menuBar" : "settings.hint.tray", locale)}>
        <input type="checkbox" checked={Boolean(draft.menu_bar_mode)} disabled={disabled} onChange={(e) => update({ menu_bar_mode: e.target.checked })} />
      </SettingRow>
      {isMac && <SettingRow title={t("settings.dockProgress", locale)} hint={t("settings.hint.dock", locale)}>
        <input type="checkbox" checked={draft.dock_progress !== false} disabled={disabled} onChange={(e) => update({ dock_progress: e.target.checked })} />
      </SettingRow>}
    </SettingsGroup>
  </div>;
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
  const pendingFocus = useRef<SettingsFocus | null>(null);

  const [ytInfo, setYtInfo] = useState<YtDlpInfo | null>(null);
  const [ytBusy, setYtBusy] = useState(false);
  const [ytError, setYtError] = useState("");
  const [ytChecked, setYtChecked] = useState(false);
  const [ytOutcome, setYtOutcome] = useState<EngineUpdateOutcome>(null);
  const ytReadGeneration = useRef(0);
  const ytStateRequested = useRef(false);
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
    const navigate = (focus: SettingsFocus) => {
      pendingFocus.current = focus;
      setTab(FOCUS_TABS[focus]);
      if (focusSettingsControl(focus)) pendingFocus.current = null;
    };
    const initial = new URLSearchParams(window.location.search).get("focus");
    if (initial && initial in SETTINGS_FOCUS_IDS) navigate(initial as SettingsFocus);
    return window.api.onSettingsFocus(navigate);
  }, []);

  useEffect(() => {
    const focus = pendingFocus.current;
    if (!draft || !focus || tab !== FOCUS_TABS[focus]) return;
    if (focusSettingsControl(focus)) pendingFocus.current = null;
  }, [draft, tab]);

  useEffect(() => {
    if (connection !== "connected") return;
    void request<MigrationResult>("app.runMigration", {})
      .then((r) => setMigration(r))
      .catch(() => undefined);
  }, [connection]);

  useEffect(() => {
    if (connection !== "connected" && connection !== "failed" && ytStateRequested.current) return;
    ytStateRequested.current = true;
    const generation = ++ytReadGeneration.current;
    void request<EngineStateInfo>("updater.getEngineState", {}).then((state) => {
      if (!mounted.current || generation !== ytReadGeneration.current) return;
      if (state?.recoveryRequired === true) {
        setYtInfo(null);
        setYtOutcome("failed");
        setYtError("");
        return;
      }
      const currentVersion = safeVersion(state?.current?.version);
      if (!currentVersion) return;
      setYtInfo((previous) => ({
        currentVersion,
        latestVersion: previous?.latestVersion || "",
        updateAvailable: previous?.updateAvailable || false,
        pendingVersion: state.pending?.sha256 === state.current?.selection ? undefined : safeVersion(state.pending?.version) || undefined,
      }));
    }).catch(() => undefined);
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
    ytReadGeneration.current += 1;
    setYtBusy(true);
    setYtError("");
    try {
      const info = await request<YtDlpInfo>("updater.checkYtDlp", {});
      if (!mounted.current) return;
      const currentVersion = safeVersion(info?.currentVersion);
      const latestVersion = safeVersion(info?.latestVersion);
      if (!currentVersion || typeof info?.updateAvailable !== "boolean" || (info.updateAvailable && !latestVersion)) {
        throw new Error("invalid tool check result");
      }
      setYtInfo({ currentVersion, latestVersion, updateAvailable: info.updateAvailable, pendingVersion: safeVersion(info.pendingVersion) || undefined });
      setYtChecked(true);
      pushToast({
        kind: "info",
        title: info.updateAvailable
          ? t("settings.toolNew", undefined, { version: safeVersion(info.latestVersion) || "—" })
          : t("settings.toolCurrentResult", undefined, { version: safeVersion(info.currentVersion) || "—" }),
      });
    } catch {
      setYtError(t("settings.toolCheckFailed"));
    } finally {
      ytReadGeneration.current += 1;
      setYtBusy(false);
    }
  };

  const updateYtDlp = async () => {
    ytReadGeneration.current += 1;
    setYtBusy(true);
    setYtError("");
    setYtOutcome(null);
    try {
      const result = await request<EngineUpdateResult>("updater.updateYtDlp", {});
      if (!mounted.current) return;
      const version = safeVersion(result?.version);
      if (!version) throw new Error("invalid tool update result");
      if (result.ok === true && result.state === "activated") {
        setYtInfo({ currentVersion: version, latestVersion: version, updateAvailable: false });
        pushToast({ kind: "success", title: t("settings.toolUpdated", undefined, { version }) });
      } else if (result.ok === true && result.state === "current") {
        setYtInfo({ currentVersion: version, latestVersion: version, updateAvailable: false });
        setYtChecked(true);
        pushToast({ kind: "info", title: t("settings.toolCurrentResult", undefined, { version }) });
      } else if (result.ok === false && (result.state === "prepared" || result.state === "rolled_back")) {
        const currentVersion = safeVersion(result.currentVersion);
        if (!currentVersion) throw new Error("invalid current engine version");
        setYtInfo({ currentVersion, latestVersion: version, updateAvailable: true, pendingVersion: version });
        setYtOutcome(result.state);
      } else if (result.ok === false && result.state === "failed") {
        setYtInfo({ currentVersion: "", latestVersion: version, updateAvailable: false });
        setYtOutcome("failed");
      } else {
        throw new Error("invalid tool update result");
      }
    } catch {
      setYtError(t("settings.toolUpdateFailed"));
      pushToast({ kind: "error", title: t("settings.toolUpdateFailed") });
    } finally {
      ytReadGeneration.current += 1;
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

  if (connection === "failed" && !ytBusy && ytOutcome !== "failed") {
    return (
      <>
        <ConnectionGate />
        <ToastHost />
      </>
    );
  }

  if (!draft) {
    return (
      <div className="settings-shell settings-loading">
        {ytOutcome === "failed"
          ? <p className="field-error" role="alert">{t("settings.toolServiceFailed", locale)}</p>
          : <p className="muted">{t("settings.loading", locale)}</p>}
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
      <aside className="settings-sidebar">
        <h1>{t("settings.open", locale)}</h1>
        <nav className="settings-tabs" aria-label={t("settings.categories", locale)} onKeyDown={(event) => {
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
          const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          if (index < 0) return;
          event.preventDefault();
          const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
            : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next]?.focus(); buttons[next]?.click();
        }}>
          {(["everyday", "more"] as const).map(group => <div className="settings-nav-group" key={group}>
            <p>{t(`settings.nav.${group}`, locale)}</p>
            {TABS.filter(item => item.group === group).map(item => <button key={item.key} type="button"
              className={tab === item.key ? "settings-tab active" : "settings-tab"}
              aria-current={tab === item.key ? "page" : undefined} aria-controls="settings-content"
              onClick={() => { setTab(item.key); document.getElementById("settings-content")?.scrollTo?.(0, 0); }}>
              <Icon name={item.icon} size={18} /><span>{t(item.labelKey, locale)}</span>
            </button>)}
          </div>)}
        </nav>
      </aside>
      <main id="settings-content" className="settings-content" tabIndex={-1}>
        <header className="settings-page-header">
          <h2>{t(TABS.find(item => item.key === tab)!.labelKey, locale)}</h2>
          <p>{t(`settings.intro.${tab}`, locale)}</p>
        </header>
        {tab === "general" && <GeneralTab {...tabProps} />}
        {tab === "output" && <OutputTab {...tabProps} />}
        {tab === "appearance" && <AppearanceTab {...tabProps} />}
        {tab === "network" && <NetworkTab {...tabProps} />}
        {tab === "advanced" && <AdvancedTab {...tabProps} />}
        {tab === "telegram" && <TelegramSettingsTab disabled={disabled} />}

      {tab === "about" && (
        <div className="settings-maintenance">
          <RuntimeStatus />
          <section className="settings-section">
            <h2>{t("settings.downloadTool", locale)}</h2>
            <p className="muted">
              {t("settings.toolCurrent", locale, { version: ytOutcome === "failed" ? t("settings.toolUnavailable", locale) : safeVersion(ytInfo?.currentVersion) || t("settings.toolUnknown", locale) })}
              {ytInfo?.updateAvailable
                ? t("settings.toolAvailable", locale, { version: safeVersion(ytInfo.latestVersion) || "—" })
                : ytChecked && ytOutcome !== "failed"
                  ? t("settings.toolLatest", locale)
                  : ""}
            </p>
            {ytOutcome === "failed" ? (
              <p className="field-error" role="status">{t("settings.toolServiceFailed", locale)}</p>
            ) : ytInfo?.pendingVersion ? (
              <p className={ytOutcome === "rolled_back" ? "field-error" : "muted"} role="status">
                {t(ytOutcome === "rolled_back" ? "settings.toolRolledBack" : "settings.toolPrepared", locale, {
                  version: safeVersion(ytInfo.pendingVersion), currentVersion: safeVersion(ytInfo.currentVersion),
                })}
              </p>
            ) : null}
            {ytError && <p className="field-error">{ytError}</p>}
            <div className="settings-control">
              <button
                id="settings-focus-download-tool"
                type="button"
                disabled={disabled || ytBusy || ytOutcome === "failed"}
                onClick={() => void checkYtDlp()}
              >
                {t("settings.toolCheck", locale)}
              </button>
              <button
                type="button"
                disabled={disabled || ytBusy || ytOutcome === "failed" || (!ytInfo?.pendingVersion && !ytInfo?.updateAvailable)}
                onClick={() => void updateYtDlp()}
              >
                {t(ytBusy ? "settings.toolProcessing" : ytInfo?.pendingVersion ? "settings.toolActivate" : "settings.toolUpdate", locale)}
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
          <section className="settings-section"><SitesPanel /></section>
        </div>
      )}
      </main>
      <footer className="settings-save-bar">
        <span className={`save-state ${saveState}`} role="status" aria-live="polite">
          {saveState === "error" ? error : statusLabel || t("settings.autoSave", locale)}
        </span>
        {saveState === "saved" && <span className="settings-save-hint">{t("settings.appliesNow", locale)}</span>}
        {saveState === "error" && <div className="settings-control">
          <button type="button" disabled={disabled} onClick={() => {
            if (draftRef.current) { setSaveState("saving"); setError(""); void persist(draftRef.current, editVersion.current); }
          }}>{t("settings.retrySave", locale)}</button>
          <button type="button" onClick={() => {
            if (timer.current !== null) window.clearTimeout(timer.current);
            const version = ++editVersion.current; savedVersion.current = version;
            draftRef.current = settings; setDraft(settings); setSaveState("idle"); setError("");
          }}>{t("settings.discardUnsaved", locale)}</button>
        </div>}
      </footer>
      <ToastHost />
    </div>
  );
}
