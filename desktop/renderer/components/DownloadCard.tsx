import { useEffect, useRef, useState } from "react";

import { getLocale, t } from "../i18n";
import { openExtractWindow, openPath, openSettings, request } from "../lib/api";
import { formatBytes, statusLabel } from "../lib/format";
import type { TaskSnapshot } from "../lib/types";
import { useAppStore } from "../store/appStore";

const POSTPROCESSING_OPTIONS = [
  { value: "none", label: "无后处理" },
  { value: "mp4", label: "转换为 MP4" },
  { value: "mp3", label: "提取音频 (MP3)" },
  { value: "script", label: "自定义脚本" },
];

function Thumbnail({ task }: { task: TaskSnapshot }) {
  const [broken, setBroken] = useState(false);
  const initial = (task.platform || task.title || "视").slice(0, 1);
  if (task.thumbnail_url && !broken) {
    return (
      <img
        className="card-thumb"
        src={task.thumbnail_url}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
      />
    );
  }
  return (
    <div className="card-thumb card-thumb-placeholder" aria-hidden>
      {initial}
    </div>
  );
}

function qualityBadge(task: TaskSnapshot): string | null {
  if (task.audio_only || task.postprocessing === "mp3") return "仅音频";
  if (task.format_id) return "指定格式";
  if (task.quality && task.quality !== "best") return task.quality;
  return null;
}

function postBadge(task: TaskSnapshot): string | null {
  switch (task.postprocessing) {
    case "mp4":
      return "转 MP4";
    case "script":
      return "脚本";
    default:
      return null;
  }
}

export function DownloadCard({ task }: { task: TaskSnapshot }) {
  const pushToast = useAppStore((s) => s.pushToast);
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(task.title);
  const menuRef = useRef<HTMLDetailsElement>(null);
  const editRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      editRef.current?.focus();
      editRef.current?.select();
    }
  }, [editing]);

  // 同一时间只允许一个「⋯」菜单打开
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

  const refresh = async () => {
    const snap = await request<{ tasks: TaskSnapshot[]; settings: never }>("app.getSnapshot");
    useAppStore.getState().hydrateSnapshot(snap as never);
  };

  const act = async (method: string) => {
    try {
      await request(method, { taskId: task.id });
      await refresh();
    } catch (err) {
      pushToast({ kind: "error", title: "操作失败", detail: String(err) });
    }
  };

  const update = async (patch: Record<string, unknown>) => {
    if (menuRef.current) menuRef.current.open = false;
    try {
      await request("download.updateTask", { taskId: task.id, ...patch });
      await refresh();
    } catch (err) {
      pushToast({ kind: "error", title: "更新失败", detail: String(err) });
    }
  };

  const submitRename = async () => {
    setEditing(false);
    const title = draftTitle.trim();
    if (!title || title === task.title) {
      setDraftTitle(task.title);
      return;
    }
    await update({ title });
  };

  const active = task.status === "downloading" || task.status === "pending";
  const finished =
    task.status === "completed" || task.status === "cancelled" || task.status === "failed";
  // 仅音频 / 后处理 / 优先级只影响尚未跑完（或失败后重试）的下载；
  // 已完成 / 已取消改这些不会重新处理文件，菜单里不展示。
  const showDownloadOptions =
    task.status === "pending" ||
    task.status === "paused" ||
    task.status === "downloading" ||
    task.status === "failed";
  const optionEditable = task.status !== "downloading";
  const qBadge = qualityBadge(task);
  const pBadge = postBadge(task);
  const locale = getLocale();

  const openExtract = () => {
    void openExtractWindow(task.url);
  };

  const handleContextAction = async (actionId: string) => {
    switch (actionId) {
      case "rename":
        setDraftTitle(task.title);
        setEditing(true);
        break;
      case "extract":
        openExtract();
        break;
      case "priority-high":
        await update({ priority: 1 });
        break;
      case "priority-normal":
        await update({ priority: 0 });
        break;
      case "audio-toggle":
        await update({ audio_only: !task.audio_only });
        break;
      case "cancel":
        await act("download.cancel");
        break;
      case "retry":
        await act("download.retry");
        break;
      case "remove":
        await act("download.remove");
        break;
      case "open":
        await openPath(task.file_path);
        break;
      case "reveal":
        await window.api.showItemInFolder(task.file_path);
        break;
      default:
        if (actionId.startsWith("pp:")) {
          await update({ postprocessing: actionId.slice(3) });
        } else if (actionId === "pause") {
          await act("download.pause");
        } else if (actionId === "resume") {
          await act("download.resume");
        }
        break;
    }
  };

  const buildContextTemplate = () => {
    const items: Array<{ id: string; label: string; enabled?: boolean; type?: string }> = [];
    items.push({ id: "rename", label: "重命名" });
    items.push({ id: "extract", label: t("menu.extract", locale) });
    if (showDownloadOptions) {
      items.push({ type: "separator", id: "sep1", label: "" });
      items.push({
        id: (task.priority ?? 0) > 0 ? "priority-normal" : "priority-high",
        label: (task.priority ?? 0) > 0 ? "取消高优先级" : "设为高优先级",
      });
      items.push({
        id: "audio-toggle",
        label: task.audio_only ? "取消仅音频" : "仅音频 (MP3)",
        enabled: optionEditable,
      });
    }
    if (task.status === "downloading") {
      items.push({ id: "pause", label: "暂停" });
    }
    if (task.status === "paused") {
      items.push({ id: "resume", label: "恢复" });
    }
    if (active) {
      items.push({ id: "cancel", label: "取消下载" });
    }
    if (task.status === "failed") {
      items.push({ id: "retry", label: "重试" });
    }
    if (task.status === "completed" && task.file_path) {
      items.push({ id: "open", label: "打开文件" });
      items.push({ id: "reveal", label: "在访达中显示" });
    }
    if (finished) {
      items.push({ id: "remove", label: "移除" });
    }
    return items;
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    void window.api.showTaskContextMenu(buildContextTemplate()).then((picked) => {
      if (picked) void handleContextAction(picked);
    });
  };

  const failedActions = () => {
    const code = task.error_code || "";
    const buttons: JSX.Element[] = [];

    buttons.push(
      <button key="retry" type="button" className="primary" onClick={() => void act("download.retry")}>
        重试
      </button>,
    );

    if (code === "need_login") {
      buttons.push(
        <button key="settings" type="button" onClick={() => void openSettings()}>
          导入 Cookie
        </button>,
        <button key="extract" type="button" onClick={openExtract}>
          浏览器抓取
        </button>,
      );
    } else if (code === "geo_blocked") {
      buttons.push(
        <button
          key="proxy"
          type="button"
          onClick={() => {
            pushToast({
              kind: "info",
              title: "地区受限",
              detail: "请在设置中启用代理并填写代理地址后重试。",
            });
            void openSettings();
          }}
        >
          检查代理
        </button>,
      );
    } else if (code === "ytdlp_outdated") {
      buttons.push(
        <button key="settings" type="button" onClick={() => void openSettings()}>
          打开设置
        </button>,
      );
    }

    if (code !== "need_login") {
      buttons.push(
        <button key="extract-generic" type="button" onClick={openExtract}>
          浏览器抓取
        </button>,
      );
    }

    return buttons;
  };

  return (
    <li
      id={`task-${task.id}`}
      className={`download-card status-${task.status}`}
      onContextMenu={onContextMenu}
    >
      <Thumbnail task={task} />
      <div className="card-main">
        {editing ? (
          <input
            ref={editRef}
            className="card-title-input"
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            onBlur={() => void submitRename()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submitRename();
              } else if (e.key === "Escape") {
                setDraftTitle(task.title);
                setEditing(false);
              }
            }}
            aria-label="重命名任务"
          />
        ) : (
          <strong
            className="card-title"
            title={`${task.title || task.url}（双击重命名）`}
            onDoubleClick={() => {
              setDraftTitle(task.title);
              setEditing(true);
            }}
          >
            {task.title || task.url}
          </strong>
        )}
        <div className="muted card-subtitle">
          {task.platform || "未知平台"} · {statusLabel(task.status)}
          {task.error_message ? ` · ${task.error_message}` : ""}
        </div>
        {(qBadge || pBadge || (task.priority ?? 0) > 0) && (
          <div className="card-badges">
            {qBadge && <span className="badge">{qBadge}</span>}
            {pBadge && <span className="badge">{pBadge}</span>}
            {(task.priority ?? 0) > 0 && <span className="badge badge-accent">高优先级</span>}
          </div>
        )}
        {(active || task.status === "paused") && (
          <>
            <div
              className="progress-bar"
              role="progressbar"
              aria-valuenow={task.progress}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <span style={{ width: `${Math.min(100, Math.max(0, task.progress))}%` }} />
            </div>
            <div className="card-meta muted">
              {formatBytes(task.downloaded_bytes)} / {formatBytes(task.total_bytes)} · {task.speed} ·{" "}
              {task.eta}
            </div>
          </>
        )}
      </div>
      <div className="card-actions">
        {task.status === "downloading" && (
          <button type="button" onClick={() => void act("download.pause")}>
            暂停
          </button>
        )}
        {task.status === "paused" && (
          <button type="button" className="primary" onClick={() => void act("download.resume")}>
            恢复
          </button>
        )}
        {task.status === "failed" && failedActions()}
        <details className="card-menu" ref={menuRef}>
          <summary aria-label="更多操作">⋯</summary>
          <div className="card-menu-list" role="menu">
            <button
              type="button"
              onClick={() => {
                if (menuRef.current) menuRef.current.open = false;
                setDraftTitle(task.title);
                setEditing(true);
              }}
            >
              重命名
            </button>
            <button type="button" onClick={openExtract}>
              {t("menu.extract", locale)}
            </button>
            {showDownloadOptions && (
              <>
                {(task.priority ?? 0) > 0 ? (
                  <button type="button" onClick={() => void update({ priority: 0 })}>
                    取消高优先级
                  </button>
                ) : (
                  <button type="button" onClick={() => void update({ priority: 1 })}>
                    设为高优先级
                  </button>
                )}
                <button
                  type="button"
                  disabled={!optionEditable}
                  onClick={() => void update({ audio_only: !task.audio_only })}
                >
                  {task.audio_only ? "取消仅音频" : "仅音频 (MP3)"}
                </button>
                {POSTPROCESSING_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    disabled={!optionEditable}
                    className={
                      (task.postprocessing || "none") === opt.value ? "menu-checked" : undefined
                    }
                    onClick={() => void update({ postprocessing: opt.value })}
                  >
                    {(task.postprocessing || "none") === opt.value ? "✓ " : ""}
                    {opt.label}
                  </button>
                ))}
              </>
            )}
            {(task.status === "downloading" || task.status === "paused" || task.status === "pending") && (
              <button type="button" onClick={() => void act("download.cancel")}>
                取消下载
              </button>
            )}
            {task.status === "completed" && task.file_path && (
              <>
                <button type="button" onClick={() => void openPath(task.file_path)}>
                  打开文件
                </button>
                <button
                  type="button"
                  onClick={() => void window.api.showItemInFolder(task.file_path)}
                >
                  在访达中显示
                </button>
              </>
            )}
            {finished && (
              <button type="button" className="menu-danger" onClick={() => void act("download.remove")}>
                移除
              </button>
            )}
          </div>
        </details>
      </div>
    </li>
  );
}
