import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { platformLabel } from "../../lib/format";
import type { TaskSnapshot } from "../../lib/types";
import { useAppStore } from "../../store/appStore";
import { Button } from "../ui/Button";
import {
  TaskActionsMenu,
  buildTaskContextTemplate,
  dispatchTaskAction,
} from "./TaskActionsMenu";
import { presentTask, type TaskPrimaryAction } from "./taskPresentation";
import { useTaskCommands, type TaskCommands } from "./useTaskCommands";

export type ArtworkTone = "dark" | "medium" | "light";

export interface MediaTaskBannerProps {
  task: TaskSnapshot;
  density?: "normal" | "compact";
  artworkTone?: ArtworkTone;
}

const TONE_OVERLAYS: Record<ArtworkTone, string> = {
  dark: "linear-gradient(115deg, rgba(12, 18, 28, 0.82), rgba(12, 18, 28, 0.3) 48%, rgba(12, 18, 28, 0.72))",
  medium:
    "linear-gradient(115deg, rgba(15, 23, 42, 0.58), rgba(15, 23, 42, 0.16) 48%, rgba(15, 23, 42, 0.54))",
  light:
    "linear-gradient(115deg, rgba(255, 255, 255, 0.52), rgba(255, 255, 255, 0.18) 46%, rgba(15, 23, 42, 0.26))",
};

const ROOT_BASE_STYLE: CSSProperties = {
  position: "relative",
  display: "grid",
  gridTemplateColumns: "88px minmax(0, 1fr) auto",
  alignItems: "center",
  gap: "var(--space-4)",
  padding: "14px 16px",
  borderRadius: 24,
  overflow: "hidden",
  border: "1px solid color-mix(in srgb, var(--color-stroke-subtle) 88%, rgba(255, 255, 255, 0.18))",
  background:
    "color-mix(in srgb, var(--color-surface-panel) 74%, rgba(255, 255, 255, 0.08))",
  boxShadow: "0 28px 80px rgba(15, 23, 42, 0.16)",
  listStyle: "none",
};

const ROOT_COMPACT_STYLE: CSSProperties = {
  gridTemplateColumns: "72px minmax(0, 1fr) auto",
  padding: "12px 14px",
  borderRadius: 20,
};

const ARTWORK_STYLE: CSSProperties = {
  position: "absolute",
  inset: 0,
  overflow: "hidden",
};

const ARTWORK_MEDIA_STYLE: CSSProperties = {
  width: "100%",
  height: "100%",
  objectFit: "cover",
  display: "block",
  filter: "saturate(1.08) contrast(1.02)",
  transform: "scale(1.04)",
};

const ARTWORK_PLACEHOLDER_STYLE: CSSProperties = {
  width: "100%",
  height: "100%",
  display: "grid",
  placeItems: "center",
  background:
    "radial-gradient(circle at 20% 20%, rgba(255,255,255,0.22), transparent 42%), linear-gradient(135deg, rgba(12, 18, 28, 0.88), rgba(37, 99, 235, 0.68))",
  color: "rgba(255, 255, 255, 0.92)",
  fontSize: 44,
  fontWeight: 700,
  letterSpacing: "-0.04em",
};

const GLASS_STYLE: CSSProperties = {
  position: "absolute",
  inset: "10px 10px 10px 78px",
  borderRadius: 20,
  background:
    "linear-gradient(135deg, rgba(255,255,255,0.34), rgba(255,255,255,0.12) 48%, rgba(255,255,255,0.2))",
  border: "1px solid rgba(255, 255, 255, 0.18)",
  backdropFilter: "blur(26px) saturate(1.16)",
};

const SHADE_BASE_STYLE: CSSProperties = {
  position: "absolute",
  inset: 0,
};

const CONTENT_STYLE: CSSProperties = {
  position: "relative",
  zIndex: 1,
  minWidth: 0,
  display: "grid",
  gap: "var(--space-2)",
};

const TITLE_STYLE: CSSProperties = {
  display: "block",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: 16,
  lineHeight: 1.3,
  color: "var(--color-text-primary)",
  cursor: "text",
};

const TITLE_INPUT_STYLE: CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  borderRadius: 14,
  border: "1px solid var(--color-accent)",
  background: "rgba(255, 255, 255, 0.6)",
  color: "var(--color-text-primary)",
  outline: 0,
  boxShadow: "0 0 0 2px var(--color-focus-ring)",
};

const META_STYLE: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: 2,
  fontSize: 12,
  color: "var(--color-text-secondary)",
};

const STATUS_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "4px 8px",
  borderRadius: 999,
  background: "rgba(255, 255, 255, 0.2)",
  color: "var(--color-text-primary)",
};

const STATUS_TONE_STYLE: Record<string, CSSProperties> = {
  neutral: { color: "var(--color-text-primary)" },
  active: { color: "var(--color-accent)" },
  warning: { color: "#c26d00" },
  success: { color: "#11845b" },
  danger: { color: "var(--color-danger)" },
};

const STATUS_DOT_TONE_STYLE: Record<string, CSSProperties> = {
  neutral: { background: "currentColor" },
  active: { background: "var(--color-accent)" },
  warning: { background: "#c26d00" },
  success: { background: "#22c55e" },
  danger: { background: "var(--color-danger)" },
};

const STATUS_DOT_STYLE: CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: 999,
  display: "inline-block",
};

const DETAIL_STYLE: CSSProperties = {
  minHeight: 18,
  fontSize: 13,
  lineHeight: 1.4,
  color: "var(--color-text-secondary)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const ACTIONS_STYLE: CSSProperties = {
  position: "relative",
  zIndex: 1,
  display: "flex",
  flexWrap: "wrap",
  justifyContent: "flex-end",
  gap: "var(--space-2)",
  alignItems: "center",
};

const PROGRESS_STYLE: CSSProperties = {
  position: "absolute",
  left: 0,
  right: 0,
  bottom: 0,
  height: 3,
  background: "rgba(255, 255, 255, 0.14)",
  overflow: "hidden",
};

const RECOVERY_LABEL_STYLE: CSSProperties = {
  whiteSpace: "nowrap",
};

function runPrimaryAction(
  action: Exclude<TaskPrimaryAction, null>,
  commands: TaskCommands,
): Promise<void> {
  switch (action) {
    case "pause":
      return commands.run("download.pause");
    case "resume":
      return commands.run("download.resume");
    case "open":
      return commands.open();
    case "retry":
      return commands.run("download.retry");
    default: {
      const exhaustive: never = action;
      return Promise.reject(new Error(`Unhandled task action: ${exhaustive}`));
    }
  }
}

function FailureRecoveryActions({
  task,
  commands,
}: {
  task: TaskSnapshot;
  commands: TaskCommands;
}) {
  const pushToast = useAppStore((state) => state.pushToast);

  if (presentTask(task).status !== "failed") return null;

  if (task.error_code === "need_login") {
    return (
      <>
        <Button
          className="media-task-banner__recovery-action"
          size="small"
          variant="ghost"
          leadingIcon="settings"
          aria-label="导入浏览器登录状态"
          title="导入浏览器登录状态"
          onClick={() => void commands.openSettings()}
        >
          <span className="media-task-banner__recovery-label" style={RECOVERY_LABEL_STYLE}>
            导入浏览器登录状态
          </span>
        </Button>
        <Button
          className="media-task-banner__recovery-action"
          size="small"
          variant="ghost"
          leadingIcon="capture"
          aria-label="网页识别"
          title="网页识别"
          onClick={() => void commands.recognizePage()}
        >
          <span className="media-task-banner__recovery-label" style={RECOVERY_LABEL_STYLE}>
            网页识别
          </span>
        </Button>
      </>
    );
  }

  return (
    <>
      {task.error_code === "geo_blocked" ? (
        <Button
          className="media-task-banner__recovery-action"
          size="small"
          variant="ghost"
          leadingIcon="settings"
          aria-label="检查代理"
          title="检查代理"
          onClick={() => {
            pushToast({
              kind: "info",
              title: "地区受限",
              detail: "请在设置中启用代理并填写代理地址后重试。",
            });
            void commands.openSettings();
          }}
        >
          <span className="media-task-banner__recovery-label" style={RECOVERY_LABEL_STYLE}>
            检查代理
          </span>
        </Button>
      ) : null}
      {task.error_code === "ytdlp_outdated" ? (
        <Button
          className="media-task-banner__recovery-action"
          size="small"
          variant="ghost"
          leadingIcon="settings"
          aria-label="打开设置"
          title="打开设置"
          onClick={() => void commands.openSettings()}
        >
          <span className="media-task-banner__recovery-label" style={RECOVERY_LABEL_STYLE}>
            打开设置
          </span>
        </Button>
      ) : null}
      <Button
        className="media-task-banner__recovery-action"
        size="small"
        variant="ghost"
        leadingIcon="capture"
        aria-label="网页识别"
        title="网页识别"
        onClick={() => void commands.recognizePage()}
      >
        <span className="media-task-banner__recovery-label" style={RECOVERY_LABEL_STYLE}>
          网页识别
        </span>
      </Button>
    </>
  );
}

export function MediaTaskBanner({
  task,
  density = "normal",
  artworkTone = "medium",
}: MediaTaskBannerProps) {
  const commands = useTaskCommands(task);
  const view = useMemo(() => presentTask(task), [task]);
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(task.title);
  const [thumbnailBroken, setThumbnailBroken] = useState(false);
  const editRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraftTitle(task.title);
  }, [task.title]);

  useEffect(() => {
    if (!editing) return;
    queueMicrotask(() => {
      editRef.current?.focus();
      editRef.current?.select();
    });
  }, [editing]);

  useEffect(() => {
    setThumbnailBroken(false);
  }, [task.thumbnail_url]);

  const initial = (platformLabel(task.platform) || task.title || "视").slice(0, 1);

  const startRename = () => {
    setDraftTitle(task.title);
    setEditing(true);
  };

  const submitRename = async () => {
    setEditing(false);
    const title = draftTitle.trim();
    if (!title || title === task.title) {
      setDraftTitle(task.title);
      return;
    }
    await commands.update({ title });
  };

  const rootStyle =
    density === "compact"
      ? { ...ROOT_BASE_STYLE, ...ROOT_COMPACT_STYLE }
      : ROOT_BASE_STYLE;

  const progressWidth = { width: `${view.progress}%`, height: "100%", background: "var(--color-accent)" };

  const handleRenameKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void submitRename();
    } else if (event.key === "Escape") {
      setDraftTitle(task.title);
      setEditing(false);
    }
  };

  return (
    <li
      id={`task-${task.id}`}
      className={`media-task-banner media-task-banner--${density} status-${view.status}`}
      data-artwork-tone={artworkTone}
      style={rootStyle}
      onContextMenu={(event) => {
        event.preventDefault();
        void window.api
          .showTaskContextMenu(buildTaskContextTemplate(task))
          .then((picked) => {
            if (picked) {
              void dispatchTaskAction(picked, task, commands, startRename);
            }
          });
      }}
    >
      <div className="media-task-banner__artwork" aria-hidden style={ARTWORK_STYLE}>
        {task.thumbnail_url && !thumbnailBroken ? (
          <img
            src={task.thumbnail_url}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            style={ARTWORK_MEDIA_STYLE}
            onError={() => setThumbnailBroken(true)}
          />
        ) : (
          <div
            className="media-task-banner__artwork-placeholder"
            style={ARTWORK_PLACEHOLDER_STYLE}
          >
            {initial}
          </div>
        )}
      </div>
      <div
        className="media-task-banner__shade"
        aria-hidden
        style={{ ...SHADE_BASE_STYLE, background: TONE_OVERLAYS[artworkTone] }}
      />
      <div className="media-task-banner__glass" aria-hidden style={GLASS_STYLE} />
      <div className="media-task-banner__content" style={CONTENT_STYLE}>
        {editing ? (
          <input
            ref={editRef}
            className="media-task-banner__title-input"
            aria-label="重命名任务"
            value={draftTitle}
            style={TITLE_INPUT_STYLE}
            onChange={(event) => setDraftTitle(event.target.value)}
            onBlur={() => void submitRename()}
            onKeyDown={handleRenameKeyDown}
          />
        ) : (
          <strong
            className="media-task-banner__title"
            title={`${task.title || task.url}（双击重命名）`}
            style={TITLE_STYLE}
            onDoubleClick={startRename}
          >
            {task.title || task.url}
          </strong>
        )}
        <div className="media-task-banner__meta" style={META_STYLE}>
          <span
            className={`media-task-banner__status tone-${view.tone}`}
            style={{ ...STATUS_STYLE, ...STATUS_TONE_STYLE[view.tone] }}
          >
            <span
              className="media-task-banner__status-dot"
              aria-hidden
              style={{ ...STATUS_DOT_STYLE, ...STATUS_DOT_TONE_STYLE[view.tone] }}
            />
            {view.label}
          </span>
          {view.meta.map((item) => (
            <span className="media-task-banner__meta-item" key={item}>
              <span className="media-task-banner__separator" aria-hidden>
                ·
              </span>{" "}
              {item}
            </span>
          ))}
        </div>
        {view.detail ? (
          <div
            className="media-task-banner__detail"
            title={task.error_message || undefined}
            style={DETAIL_STYLE}
          >
            {view.detail}
          </div>
        ) : null}
      </div>
      <div className="media-task-banner__actions" style={ACTIONS_STYLE}>
        {view.primaryAction ? (
          <Button
            className="media-task-banner__primary-action"
            size="small"
            onClick={() => void runPrimaryAction(view.primaryAction, commands)}
          >
            {view.primaryLabel}
          </Button>
        ) : null}
        <FailureRecoveryActions task={task} commands={commands} />
        <TaskActionsMenu task={task} commands={commands} onRename={startRename} />
      </div>
      {view.showProgress ? (
        <div
          className="media-task-banner__progress"
          role="progressbar"
          aria-label="下载进度"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={view.progress}
          style={PROGRESS_STYLE}
        >
          <span style={progressWidth} />
        </div>
      ) : null}
    </li>
  );
}
