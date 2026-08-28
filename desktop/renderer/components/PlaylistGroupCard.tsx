import { useMemo, useRef, useState, type ReactNode } from "react";

import { t, useLocale } from "../i18n";
import { request } from "../lib/api";
import { isActiveStatus } from "../lib/format";
import { comparePlaylistTasks } from "../lib/queueOrdering";
import { taskActionToast } from "../lib/taskActionReport";
import { refreshQueueAfterChange } from "../lib/refreshQueue";
import type { GroupRemovalReport, TaskAction, TaskActionReport, TaskSnapshot } from "../lib/types";
import { useAppStore } from "../store/appStore";
import { MediaTaskBanner } from "./task/MediaTaskBanner";
import { Icon } from "./ui/Icon";

function sortGroupTasks(tasks: TaskSnapshot[]): TaskSnapshot[] {
  return tasks.slice().sort(comparePlaylistTasks);
}

function aggregateProgress(tasks: TaskSnapshot[]): {
  completed: number;
  total: number;
  percent: number;
} {
  const total = tasks.length;
  const completed = tasks.filter((t) => t.status === "completed").length;
  const percent =
    total === 0
      ? 0
      : Math.round(
          tasks.reduce((sum, t) => sum + (Number(t.progress) || 0), 0) / total,
        );
  return { completed, total, percent };
}

export function PlaylistGroupCard({ tasks, queueControls }: { tasks: TaskSnapshot[]; queueControls?: ReactNode }) {
  const locale = useLocale();
  const pushToast = useAppStore((s) => s.pushToast);
  const [expanded, setExpanded] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [acting, setActing] = useState(false);
  const actionPending = useRef(false);
  const ordered = useMemo(() => sortGroupTasks(tasks), [tasks]);
  const title = ordered[0]?.group_title || t("group.title", locale);
  const groupId = (ordered[0]?.group_id || "").trim();
  const { completed, total, percent } = aggregateProgress(ordered);
  const hasRunning = ordered.some((t) => t.status === "pending" || t.status === "downloading");
  const hasPaused = ordered.some((t) => t.status === "paused");
  const hasFailed = ordered.some(
    (t) => t.status === "failed" || t.status === "cancelled",
  );
  const hasActive = ordered.some((t) => isActiveStatus(t.status));
  const hasLocalFiles = ordered.some(
    (t) => t.status === "completed" && Boolean(t.file_path),
  );

  const act = async (action: TaskAction) => {
    if (!groupId || actionPending.current || removing) return;
    actionPending.current = true;
    setActing(true);
    try {
      const report = await request<TaskActionReport>("download.applyGroupAction", { groupId, action });
      await refreshQueueAfterChange();
      pushToast(taskActionToast(report));
    } catch {
      pushToast({ kind: "error", title: t("group.actionFailed"), detail: t("error.retryLater") });
    } finally {
      actionPending.current = false;
      setActing(false);
    }
  };

  const confirmRemoveGroup = async () => {
    if (!groupId || removing || actionPending.current) return;
    setRemoving(true);
    try {
      const result = await request<GroupRemovalReport>("download.removeGroup", {
        groupId,
        delete_files: deleteFiles,
      });
      await refreshQueueAfterChange();
      const n = result.removed.length;
      const failures = result.fileDeleteFailures?.length ?? 0;
      pushToast({
        kind: failures > 0 ? "warning" : n > 0 ? "success" : "info",
        title: failures > 0
          ? t("group.fileFailures", locale, { count: n, failures })
          : n === 0
            ? t("group.noneRemoved", locale)
            : deleteFiles
              ? t("group.removedFiles", locale, { count: n })
              : t("group.removed", locale, { count: n }),
      });
      setConfirmDelete(false);
      setDeleteFiles(false);
    } catch {
      pushToast({ kind: "error", title: t("group.removeFailed"), detail: t("error.retryLater") });
    } finally {
      setRemoving(false);
    }
  };

  return (
    <li className="playlist-group">
      <div className="playlist-group-header">
        <button
          type="button"
          className="playlist-group-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          <span className="playlist-group-chevron" aria-hidden>
            <Icon name={expanded ? "chevron-down" : "chevron-right"} size={14} />
          </span>
          <div className="playlist-group-heading">
            <strong className="playlist-group-title">{title}</strong>
            <span className="playlist-group-meta muted">
              {t("group.progress", locale, { completed, total, percent })}
            </span>
          </div>
        </button>
        <div className="playlist-group-actions">
          {queueControls}
          {hasRunning ? (
            <button
              type="button"
              className="ghost-btn"
              disabled={acting || removing}
              onClick={() => void act("pause")}
            >
              {t("action.pause", locale)}
            </button>
          ) : null}
          {hasPaused ? (
            <button
              type="button"
              className="primary"
              disabled={acting || removing}
              onClick={() => void act("resume")}
            >
              {t("action.resume", locale)}
            </button>
          ) : null}
          {hasFailed ? (
            <button
              type="button"
              className="ghost-btn"
              disabled={acting || removing}
              onClick={() => void act("retry")}
            >
              {t("action.retry", locale)}
            </button>
          ) : null}
          {hasActive ? (
            <button
              type="button"
              className="ghost-btn"
              disabled={acting || removing}
              onClick={() => void act("cancel")}
            >
              {t("action.cancel", locale)}
            </button>
          ) : null}
          {groupId ? (
            <button
              type="button"
              className="ghost-btn danger-btn"
              disabled={acting || removing}
              onClick={() => setConfirmDelete(true)}
            >
              {t("action.delete", locale)}
            </button>
          ) : null}
        </div>
      </div>
      <div className="playlist-group-progress" aria-hidden>
        <div style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
      </div>
      {confirmDelete ? (
        <div className="playlist-group-delete" role="group" aria-label={t("group.confirmLabel", locale)}>
          <div className="playlist-group-delete-copy">
            <strong>{t("group.confirmTitle", locale)}</strong>
            <p className="muted">
              {t("group.confirmCopy", locale, { title, total })}
            </p>
            <label className="playlist-group-delete-option">
              <input
                type="checkbox"
                checked={deleteFiles}
                disabled={!hasLocalFiles || removing}
                onChange={(e) => setDeleteFiles(e.target.checked)}
              />
              <span>
                {t("group.deleteFiles", locale)}
                {!hasLocalFiles ? <em className="muted">{t("group.noFiles", locale)}</em> : null}
              </span>
            </label>
          </div>
          <div className="playlist-group-delete-actions">
            <button
              type="button"
              className="ghost-btn"
              disabled={removing}
              onClick={() => {
                setConfirmDelete(false);
                setDeleteFiles(false);
              }}
            >
              {t("action.back", locale)}
            </button>
            <button
              type="button"
              className="danger-btn solid-danger"
              disabled={removing}
              onClick={() => void confirmRemoveGroup()}
            >
              {t(removing ? "action.deleting" : "action.confirmDelete", locale)}
            </button>
          </div>
        </div>
      ) : null}
      {expanded ? (
        <ul className="playlist-group-list">
          {ordered.map((task) => (
            <MediaTaskBanner key={task.id} task={task} density="compact" />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
