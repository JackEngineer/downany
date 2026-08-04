import { useMemo, useState } from "react";

import { request } from "../lib/api";
import { isActiveStatus } from "../lib/format";
import type { TaskSnapshot } from "../lib/types";
import { useAppStore } from "../store/appStore";
import { DownloadCard } from "./DownloadCard";

function sortGroupTasks(tasks: TaskSnapshot[]): TaskSnapshot[] {
  return tasks.slice().sort((a, b) => {
    const ia = a.playlist_index ?? 0;
    const ib = b.playlist_index ?? 0;
    if (ia !== ib) return ia - ib;
    const orderA = a.queue_order ?? 0;
    const orderB = b.queue_order ?? 0;
    return orderA - orderB;
  });
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

async function runForGroup(
  tasks: TaskSnapshot[],
  method: "download.pause" | "download.resume" | "download.cancel" | "download.retry",
  predicate: (task: TaskSnapshot) => boolean,
): Promise<void> {
  const targets = tasks.filter(predicate);
  await Promise.all(
    targets.map((task) =>
      request(method, { taskId: task.id }).catch(() => undefined),
    ),
  );
}

export function PlaylistGroupCard({ tasks }: { tasks: TaskSnapshot[] }) {
  const pushToast = useAppStore((s) => s.pushToast);
  const [expanded, setExpanded] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [removing, setRemoving] = useState(false);
  const ordered = useMemo(() => sortGroupTasks(tasks), [tasks]);
  const title = ordered[0]?.group_title || "播放列表";
  const groupId = (ordered[0]?.group_id || "").trim();
  const { completed, total, percent } = aggregateProgress(ordered);
  const hasDownloading = ordered.some((t) => t.status === "downloading");
  const hasPaused = ordered.some((t) => t.status === "paused");
  const hasFailed = ordered.some(
    (t) => t.status === "failed" || t.status === "cancelled",
  );
  const hasActive = ordered.some((t) => isActiveStatus(t.status));
  const hasLocalFiles = ordered.some(
    (t) => t.status === "completed" && Boolean(t.file_path),
  );

  const refresh = async () => {
    const snap = await request<{ tasks: TaskSnapshot[]; settings: never }>(
      "app.getSnapshot",
    );
    useAppStore.getState().hydrateSnapshot(snap as never);
  };

  const act = async (
    method: "download.pause" | "download.resume" | "download.cancel" | "download.retry",
    predicate: (task: TaskSnapshot) => boolean,
    label: string,
  ) => {
    try {
      await runForGroup(ordered, method, predicate);
      pushToast({ kind: "info", title: label });
    } catch (err) {
      pushToast({ kind: "error", title: "组操作失败", detail: String(err) });
    }
  };

  const confirmRemoveGroup = async () => {
    if (!groupId || removing) return;
    setRemoving(true);
    try {
      const result = await request<{ removed?: string[] }>("download.removeGroup", {
        groupId,
        delete_files: deleteFiles,
      });
      await refresh();
      const n = Array.isArray(result?.removed) ? result.removed.length : ordered.length;
      pushToast({
        kind: "success",
        title: deleteFiles
          ? `已删除合集（含本地文件）· ${n} 项`
          : `已从队列移除合集 · ${n} 项`,
      });
      setConfirmDelete(false);
      setDeleteFiles(false);
    } catch (err) {
      pushToast({ kind: "error", title: "删除合集失败", detail: String(err) });
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
            {expanded ? "▾" : "▸"}
          </span>
          <div className="playlist-group-heading">
            <strong className="playlist-group-title">{title}</strong>
            <span className="playlist-group-meta muted">
              {completed}/{total} 完成 · {percent}%
            </span>
          </div>
        </button>
        <div className="playlist-group-actions">
          {hasDownloading ? (
            <button
              type="button"
              className="ghost-btn"
              onClick={() =>
                void act(
                  "download.pause",
                  (t) => t.status === "downloading",
                  "已暂停组内下载",
                )
              }
            >
              暂停
            </button>
          ) : null}
          {hasPaused ? (
            <button
              type="button"
              className="primary"
              onClick={() =>
                void act(
                  "download.resume",
                  (t) => t.status === "paused",
                  "已恢复组内任务",
                )
              }
            >
              恢复
            </button>
          ) : null}
          {hasFailed ? (
            <button
              type="button"
              className="ghost-btn"
              onClick={() =>
                void act(
                  "download.retry",
                  (t) => t.status === "failed" || t.status === "cancelled",
                  "已重试组内失败任务",
                )
              }
            >
              重试
            </button>
          ) : null}
          {hasActive ? (
            <button
              type="button"
              className="ghost-btn"
              onClick={() =>
                void act(
                  "download.cancel",
                  (t) => isActiveStatus(t.status),
                  "已取消组内任务",
                )
              }
            >
              取消
            </button>
          ) : null}
          {groupId ? (
            <button
              type="button"
              className="ghost-btn danger-btn"
              onClick={() => setConfirmDelete(true)}
            >
              删除
            </button>
          ) : null}
        </div>
      </div>
      <div className="playlist-group-progress" aria-hidden>
        <div style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
      </div>
      {confirmDelete ? (
        <div className="playlist-group-delete" role="group" aria-label="确认删除合集">
          <div className="playlist-group-delete-copy">
            <strong>删除整组合集？</strong>
            <p className="muted">
              「{title}」共 {total} 项；进行中的任务会先取消再移除。
            </p>
            <label className="playlist-group-delete-option">
              <input
                type="checkbox"
                checked={deleteFiles}
                disabled={!hasLocalFiles || removing}
                onChange={(e) => setDeleteFiles(e.target.checked)}
              />
              <span>
                同时删除已下载的本地文件
                {!hasLocalFiles ? <em className="muted">（暂无已完成文件）</em> : null}
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
              返回
            </button>
            <button
              type="button"
              className="danger-btn solid-danger"
              disabled={removing}
              onClick={() => void confirmRemoveGroup()}
            >
              {removing ? "删除中…" : "确认删除"}
            </button>
          </div>
        </div>
      ) : null}
      {expanded ? (
        <ul className="playlist-group-list">
          {ordered.map((task) => (
            <DownloadCard key={task.id} task={task} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
