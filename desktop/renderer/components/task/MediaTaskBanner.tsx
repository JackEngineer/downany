import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type SyntheticEvent,
} from "react";

import { t, useLocale } from "../../i18n";
import { platformLabel } from "../../lib/format";
import type { TaskSnapshot } from "../../lib/types";
import { ConfirmDialog } from "../ConfirmDialog";
import { Button } from "../ui/Button";
import {
  TaskActionsMenu,
  buildTaskContextTemplate,
  dispatchTaskAction,
} from "./TaskActionsMenu";
import {
  artworkToneSampler,
  classifyArtwork,
  classifyArtworkShape,
  type ArtworkDimensions,
  type ArtworkTone,
} from "./artworkPresentation";
import {
  failureRecoveryFor,
  type FailureRecoveryAction,
} from "./failureRecovery";
import { presentTask, type TaskPrimaryAction } from "./taskPresentation";
import { useTaskCommands, type TaskCommands } from "./useTaskCommands";

export interface MediaTaskBannerProps {
  task: TaskSnapshot;
  density?: "normal" | "compact";
  queueControls?: ReactNode;
}

interface ArtworkState {
  url: string | undefined;
  broken: boolean;
  focusBroken: boolean;
  naturalSize: ArtworkDimensions | null;
  tone: ArtworkTone;
}

function initialArtworkState(url: string | undefined): ArtworkState {
  return {
    url,
    broken: false,
    focusBroken: false,
    naturalSize: null,
    tone: "light",
  };
}

function runPrimaryAction(
  action: Exclude<TaskPrimaryAction, null>,
  commands: TaskCommands,
  requestRetry: () => Promise<void>,
): Promise<void> {
  switch (action) {
    case "pause":
      return commands.run("download.pause");
    case "resume":
      return commands.run("download.resume");
    case "open":
      return commands.open();
    case "retry":
      return requestRetry();
    default: {
      const exhaustive: never = action;
      return Promise.reject(new Error(`Unhandled task action: ${exhaustive}`));
    }
  }
}

const RECOVERY_ACTION_VIEWS = {
  login: { labelKey: "recovery.login", icon: "settings" },
  network: { labelKey: "recovery.network", icon: "settings" },
  updateTool: { labelKey: "recovery.updateTool", icon: "settings" },
  recognize: { labelKey: "recovery.recognize", icon: "capture" },
  downloadSettings: { labelKey: "recovery.downloadSettings", icon: "settings" },
  appDownload: { labelKey: "recovery.appDownload", icon: "download" },
  diagnostics: { labelKey: "recovery.diagnostics", icon: "folder" },
} as const satisfies Record<
  FailureRecoveryAction,
  { labelKey: string; icon: "settings" | "capture" | "download" | "folder" }
>;

function runRecoveryAction(
  action: FailureRecoveryAction,
  commands: TaskCommands,
): Promise<void> {
  switch (action) {
    case "login":
      return commands.openSettings("cookies");
    case "network":
      return commands.openSettings("network");
    case "updateTool":
      return commands.openSettings("downloadTool");
    case "recognize":
      return commands.recognizePage();
    case "downloadSettings":
      return commands.openSettings("download");
    case "appDownload":
      return commands.openAppDownload();
    case "diagnostics":
      return commands.exportDiagnostics();
    default: {
      const exhaustive: never = action;
      return Promise.reject(
        new Error(`Unhandled recovery action: ${exhaustive}`),
      );
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
  const locale = useLocale();
  if (presentTask(task).status !== "failed") return null;
  const view = failureRecoveryFor(task.error_code);

  return (
    <>
      {view.actions.map((action) => {
        const presentation = RECOVERY_ACTION_VIEWS[action];
        const label = t(presentation.labelKey, locale);
        return (
          <Button
            key={action}
            className="media-task-banner__recovery-action"
            size="small"
            variant="ghost"
            leadingIcon={presentation.icon}
            aria-label={label}
            title={label}
            onClick={() => void runRecoveryAction(action, commands)}
          >
            <span className="media-task-banner__recovery-label">
              {label}
            </span>
          </Button>
        );
      })}
    </>
  );
}

export function MediaTaskBanner({
  task,
  density = "normal",
  queueControls,
}: MediaTaskBannerProps) {
  const locale = useLocale();
  const commands = useTaskCommands(task);
  const view = useMemo(() => presentTask(task, new Date(), locale), [task, locale]);
  const [editing, setEditing] = useState(false);
  const [retryConfirmationOpen, setRetryConfirmationOpen] = useState(false);
  const [draftTitle, setDraftTitle] = useState(task.title);
  const [renderedArtworkUrl, setRenderedArtworkUrl] = useState(
    task.thumbnail_url,
  );
  const [artworkState, setArtworkState] = useState<ArtworkState>(() =>
    initialArtworkState(task.thumbnail_url),
  );
  if (renderedArtworkUrl !== task.thumbnail_url) {
    setRenderedArtworkUrl(task.thumbnail_url);
    setArtworkState(initialArtworkState(task.thumbnail_url));
  }
  const [bannerSize, setBannerSize] = useState<ArtworkDimensions | null>(null);
  const rootRef = useRef<HTMLLIElement>(null);
  const editRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraftTitle(task.title);
  }, [task.title]);

  useEffect(() => {
    const artworkUrl = task.thumbnail_url;
    if (!artworkUrl) return;
    const controller = new AbortController();
    let active = true;
    void artworkToneSampler
      .sample(artworkUrl, controller.signal)
      .then((tone) => {
        if (!active) return;
        setArtworkState((current) =>
          current.url === artworkUrl ? { ...current, tone } : current,
        );
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (!active) return;
        setArtworkState((current) =>
          current.url === artworkUrl ? { ...current, tone: "light" } : current,
        );
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [task.thumbnail_url]);

  useEffect(() => {
    if (!editing) return;
    queueMicrotask(() => {
      editRef.current?.focus();
      editRef.current?.select();
    });
  }, [editing]);

  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const update = (width: number, height: number) => {
      setBannerSize({ width, height });
    };
    const rect = node.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) update(rect.width, rect.height);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) update(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const currentArtworkState =
    artworkState.url === task.thumbnail_url
      ? artworkState
      : initialArtworkState(task.thumbnail_url);
  const currentNaturalSize = currentArtworkState.naturalSize;
  const artworkTone = currentArtworkState.tone;
  const unavailable = !task.thumbnail_url || currentArtworkState.broken;
  const mediaQuality = classifyArtwork(
    currentNaturalSize,
    bannerSize,
    unavailable,
  );
  const artworkShape = classifyArtworkShape(currentNaturalSize);

  const initial = (platformLabel(task.platform) || task.title || "视").slice(0, 1);

  const startRename = () => {
    setDraftTitle(task.title);
    setEditing(true);
  };

  const requestRetry = async () => {
    if (failureRecoveryFor(task.error_code).requiresRetryConfirmation) {
      setRetryConfirmationOpen(true);
      return;
    }
    await commands.run("download.retry");
  };

  const confirmRetry = async () => {
    setRetryConfirmationOpen(false);
    await commands.run("download.retry");
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

  const progressWidth = { width: `${view.progress}%` };

  const handleArtworkLoad = (event: SyntheticEvent<HTMLImageElement>) => {
    const image = event.currentTarget;
    const artworkUrl = image.getAttribute("src");
    if (!artworkUrl || artworkUrl !== task.thumbnail_url) return;
    setArtworkState((current) =>
      current.url === artworkUrl
        ? {
            ...current,
            broken: false,
            focusBroken: false,
            naturalSize: { width: image.naturalWidth, height: image.naturalHeight },
          }
        : current,
    );
  };

  const handleArtworkError = (event: SyntheticEvent<HTMLImageElement>) => {
    const artworkUrl = event.currentTarget.getAttribute("src");
    if (artworkUrl && artworkUrl === task.thumbnail_url) {
      setArtworkState({
        ...initialArtworkState(artworkUrl),
        broken: true,
      });
    }
  };

  const handleFocusError = (event: SyntheticEvent<HTMLImageElement>) => {
    const artworkUrl = event.currentTarget.getAttribute("src");
    if (artworkUrl && artworkUrl === task.thumbnail_url) {
      setArtworkState((current) =>
        current.url === artworkUrl
          ? { ...current, focusBroken: true }
          : current,
      );
    }
  };

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
    <>
      <li
      ref={rootRef}
      id={`task-${task.id}`}
      className={`media-task-banner media-task-banner--${density} status-${view.status}`}
      data-media-quality={mediaQuality}
      data-artwork-shape={artworkShape}
      data-artwork-tone={artworkTone}
      onContextMenu={(event) => {
        event.preventDefault();
        void window.api
          .showTaskContextMenu(buildTaskContextTemplate(task, locale))
          .then((picked) => {
            if (picked) {
              void dispatchTaskAction(
                picked,
                task,
                commands,
                startRename,
                requestRetry,
              );
            }
          });
      }}
    >
      <div className="media-task-banner__artwork" aria-hidden>
        {mediaQuality === "missing" ? (
          <div className="media-task-banner__artwork-placeholder">{initial}</div>
        ) : (
          <>
            <img
              key={`ambient:${task.thumbnail_url}`}
              className="media-task-banner__artwork-ambient"
              src={task.thumbnail_url}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              onLoad={handleArtworkLoad}
              onError={handleArtworkError}
            />
            {mediaQuality === "weak" &&
            currentNaturalSize &&
            !currentArtworkState.focusBroken ? (
              <img
                key={`focus:${task.thumbnail_url}`}
                className="media-task-banner__artwork-focus"
                src={task.thumbnail_url}
                alt=""
                loading="lazy"
                referrerPolicy="no-referrer"
                onError={handleFocusError}
              />
            ) : null}
          </>
        )}
      </div>
      <div className="media-task-banner__shade" aria-hidden />
      <div className="media-task-banner__glass" aria-hidden />
      <div className="media-task-banner__content">
        {editing ? (
          <input
            ref={editRef}
            className="media-task-banner__title-input"
            aria-label={t("action.renameTask", locale)}
            value={draftTitle}
            onChange={(event) => setDraftTitle(event.target.value)}
            onBlur={() => void submitRename()}
            onKeyDown={handleRenameKeyDown}
          />
        ) : (
          <strong
            className="media-task-banner__title"
            title={t("action.renameHint", locale, { title: task.title || task.url })}
            onDoubleClick={startRename}
          >
            {task.title || task.url}
          </strong>
        )}
        <div className="media-task-banner__meta">
          <span className={`media-task-banner__status tone-${view.tone}`}>
            <span
              className="media-task-banner__status-dot"
              aria-hidden
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
          <div className="media-task-banner__detail">
            {view.detail}
          </div>
        ) : null}
      </div>
      <div className="media-task-banner__actions">
        {view.primaryAction ? (
          <Button
            className="media-task-banner__primary-action"
            size="small"
            onClick={() =>
              view.primaryAction && void runPrimaryAction(
                view.primaryAction,
                commands,
                requestRetry,
              )
            }
          >
            {view.primaryLabel}
          </Button>
        ) : null}
        <FailureRecoveryActions task={task} commands={commands} />
        <TaskActionsMenu
          task={task}
          commands={commands}
          onRename={startRename}
          onRetryRequested={requestRetry}
        />
        {queueControls}
      </div>
      {view.showProgress ? (
        <div
          className="media-task-banner__progress"
          role="progressbar"
          aria-label={t("task.progress", locale)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={view.progress}
        >
          <span style={progressWidth} />
        </div>
      ) : null}
      </li>
      <ConfirmDialog
        open={retryConfirmationOpen}
        title={t("retry.title", locale)}
        message={t("retry.copy", locale)}
        confirmLabel={t("action.downloadAgain", locale)}
        onConfirm={() => void confirmRetry()}
        onCancel={() => setRetryConfirmationOpen(false)}
      />
    </>
  );
}
