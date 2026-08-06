import { useEffect, useRef, useState } from "react";

import type { MigrationResult } from "../electron/preload";
import { ConnectionGate } from "./components/ConnectionGate";
import { SitesPanel } from "./components/SitesPanel";
import { ToastHost } from "./components/ToastHost";
import { request } from "./lib/api";
import { getLocale, setLocale, t, type Locale } from "./i18n";
import type { AppSettings } from "./lib/types";
import { useAppStore } from "./store/appStore";

type SaveState = "idle" | "saving" | "saved" | "error";

type YtDlpInfo = {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  downloadUrl?: string;
};

type TabKey = "general" | "quality" | "postprocess" | "appearance";

const TABS: { key: TabKey; label: string }[] = [
  { key: "general", label: "通用" },
  { key: "quality", label: "质量" },
  { key: "postprocess", label: "后处理" },
  { key: "appearance", label: "界面" },
];

function useBootstrap() {
  const themeMode = useAppStore((s) => s.settings?.theme_mode);

  useEffect(() => {
    const store = useAppStore.getState();
    void window.api.getConnectionState().then((state) => store.setConnection(state));
    const offState = window.api.onState((state) => {
      useAppStore.getState().setConnection(state);
      if (state === "connected") {
        void request<AppSettings>("settings.get").then((settings) => {
          useAppStore.setState({ settings });
        });
      }
    });
    const offEvent = window.api.onEvent((event) => {
      if (event.event === "settings.changed" && event.payload.settings) {
        useAppStore.setState({ settings: event.payload.settings as AppSettings });
      }
    });
    void request<AppSettings>("settings.get")
      .then((settings) => useAppStore.setState({ settings }))
      .catch(() => undefined);
    return () => {
      offState();
      offEvent();
    };
  }, []);

  useEffect(() => {
    const applyTheme = async () => {
      const mode = useAppStore.getState().settings?.theme_mode || "system";
      const resolved = mode === "system" ? await window.api.getNativeTheme() : mode;
      document.documentElement.setAttribute("data-theme", resolved);
    };
    void applyTheme();
    return window.api.onNativeTheme(() => void applyTheme());
  }, [themeMode]);
}

interface TabProps {
  draft: AppSettings;
  disabled: boolean;
  update: (partial: Partial<AppSettings>) => void;
  pickDir: () => Promise<void>;
}

function GeneralTab({ draft, disabled, update, pickDir }: TabProps) {
  return (
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
        <span>从浏览器导入 Cookie</span>
        <select
          value={draft.cookies_from_browser || ""}
          disabled={disabled}
          onChange={(e) => update({ cookies_from_browser: e.target.value })}
        >
          <option value="">不导入</option>
          <option value="chrome">Chrome</option>
          {window.api?.platform === "darwin" && <option value="safari">Safari</option>}
          <option value="firefox">Firefox</option>
          <option value="edge">Edge</option>
        </select>
      </label>

      <label className="settings-row">
        <span>嵌入元数据</span>
        <input
          type="checkbox"
          checked={draft.embed_metadata !== false}
          disabled={disabled}
          onChange={(e) => update({ embed_metadata: e.target.checked })}
        />
      </label>

      <label className="settings-row">
        <span>HLS 分片并发</span>
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
        <span>{t("settings.telemetry", getLocale())}</span>
        <input
          type="checkbox"
          checked={Boolean(draft.telemetry_enabled)}
          disabled={disabled}
          onChange={(e) => update({ telemetry_enabled: e.target.checked })}
        />
      </label>

      <label className="settings-row">
        <span>{t("settings.language", getLocale())}</span>
        <select
          value={getLocale()}
          disabled={disabled}
          onChange={(e) => {
            setLocale(e.target.value as Locale);
            window.dispatchEvent(new CustomEvent("downany:locale"));
          }}
        >
          <option value="zh-CN">简体中文</option>
          <option value="en">English</option>
        </select>
      </label>

      <SitesPanel />

      <label className="settings-row">
        <span>剪贴板监控</span>
        <input
          type="checkbox"
          checked={Boolean(draft.clipboard_monitor)}
          disabled={disabled}
          onChange={(e) => update({ clipboard_monitor: e.target.checked })}
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
    </div>
  );
}

function QualityTab({ draft, disabled, update }: TabProps) {
  return (
    <div className="settings-grid">
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
        <span>每次询问画质</span>
        <input
          type="checkbox"
          checked={draft.auto_start_downloads === false}
          disabled={disabled}
          onChange={(e) => update({ auto_start_downloads: !e.target.checked })}
        />
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
        <span>字幕语言</span>
        <input
          value={draft.subtitle_langs || ""}
          disabled={disabled}
          placeholder="如 zh-Hans,en（空=跟随站点默认）"
          onChange={(e) => update({ subtitle_langs: e.target.value })}
        />
      </label>

      <label className="settings-row">
        <span>内嵌字幕</span>
        <input
          type="checkbox"
          checked={Boolean(draft.embed_subs)}
          disabled={disabled}
          onChange={(e) => update({ embed_subs: e.target.checked })}
        />
      </label>

      <label className="settings-row">
        <span>片段裁剪</span>
        <input
          value={draft.download_sections || ""}
          disabled={disabled}
          placeholder="如 *00:10:00-00:15:00（空=完整）"
          onChange={(e) => update({ download_sections: e.target.value })}
        />
      </label>

      <label className="settings-row">
        <span>SponsorBlock 去除</span>
        <input
          value={draft.sponsorblock_remove || ""}
          disabled={disabled}
          placeholder="如 sponsor,intro,outro（空=不启用）"
          onChange={(e) => update({ sponsorblock_remove: e.target.value })}
        />
      </label>
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
  const connection = useAppStore((s) => s.connection);
  const settings = useAppStore((s) => s.settings);
  const pushToast = useAppStore((s) => s.pushToast);
  const [draft, setDraft] = useState<AppSettings | null>(settings);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [error, setError] = useState("");
  const [tab, setTab] = useState<TabKey>("general");
  const timer = useRef<number | null>(null);

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
    setDraft(settings);
  }, [settings]);

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
        title: info.updateAvailable
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
      pushToast({ kind: "success", title: `yt-dlp 已更新至 ${result.version}` });
    } catch (err) {
      setYtError(String(err));
      pushToast({ kind: "error", title: "yt-dlp 更新失败" });
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
      setDiagPath(result.path);
      pushToast({ kind: "success", title: "诊断包已导出" });
      if (result.path) {
        void window.api.showItemInFolder(result.path);
      }
    } catch (err) {
      pushToast({ kind: "error", title: `导出失败：${String(err)}` });
    } finally {
      setDiagBusy(false);
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

  const tabProps: TabProps = { draft, disabled, update, pickDir };

  return (
    <div className="settings-shell">
      <div className="settings-drag-strip" />
      <header className="row">
        <h1>设置</h1>
        <span className={`save-state ${saveState}`}>{statusLabel}</span>
      </header>
      {error && <p className="field-error">{error}</p>}

      <nav className="settings-tabs" aria-label="设置分类">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={tab === t.key ? "segment active" : "segment"}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "general" && <GeneralTab {...tabProps} />}
      {tab === "quality" && <QualityTab {...tabProps} />}
      {tab === "postprocess" && <PostprocessTab {...tabProps} />}
      {tab === "appearance" && <AppearanceTab {...tabProps} />}

      {tab === "general" && (
        <>
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

          <section className="settings-section">
            <h2>应用更新</h2>
            <p className="muted">
              通过 GitHub Releases 检查新版本。当前为未签名分发：有更新时请前往下载页手动安装。
              自动替换需签名公证后接入 electron-updater，见 docs/RELEASE.md。
            </p>
            {appUpdateMsg && <p className="muted small">{appUpdateMsg}</p>}
            <div className="settings-control">
              <button
                type="button"
                disabled={disabled || appUpdateBusy}
                onClick={() => {
                  setAppUpdateBusy(true);
                  void window.api
                    .checkAppUpdate()
                    .then((info) => {
                      setAppUpdateMsg(info.message);
                      setAppUpdateUrl(info.downloadUrl || "");
                      const kind =
                        info.status === "available"
                          ? "success"
                          : info.status === "error"
                            ? "error"
                            : "info";
                      pushToast({ kind, title: info.message });
                    })
                    .finally(() => setAppUpdateBusy(false));
                }}
              >
                {appUpdateBusy ? "检查中…" : "检查应用更新"}
              </button>
              <button
                type="button"
                disabled={disabled || !appUpdateUrl}
                onClick={() => {
                  void window.api.openExternal(appUpdateUrl);
                }}
              >
                前往下载
              </button>
            </div>
          </section>

          <section className="settings-section">
            <h2>诊断</h2>
            <p className="muted">
              导出日志、yt-dlp / ffmpeg 版本与失败任务摘要，便于排查下载问题。
            </p>
            {diagPath && <p className="muted small">{diagPath}</p>}
            <div className="settings-control">
              <button
                type="button"
                disabled={disabled || diagBusy}
                onClick={() => void exportDiagnosticsBundle()}
              >
                {diagBusy ? "导出中…" : "导出诊断包"}
              </button>
            </div>
          </section>
        </>
      )}

      <p className="muted">更改将自动保存。</p>
      <ToastHost />
    </div>
  );
}
