import { openPath, request } from "../lib/api";
import type { TaskSnapshot } from "../lib/types";
import { useAppStore } from "../store/appStore";

function formatBytes(n: number): string {
  if (!n) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function TaskRow({ task }: { task: TaskSnapshot }) {
  const pushToast = useAppStore((s) => s.pushToast);
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

  return (
    <li className="task-row">
      <div className="task-main">
        <strong>{task.title || task.url}</strong>
        <div className="muted">
          {task.platform} · {task.status}
          {task.error_message ? ` · ${task.error_message}` : ""}
        </div>
        <div className="progress-bar" aria-valuenow={task.progress} aria-valuemin={0} aria-valuemax={100}>
          <span style={{ width: `${Math.min(100, Math.max(0, task.progress))}%` }} />
        </div>
        <div className="task-meta muted">
          {formatBytes(task.downloaded_bytes)} / {formatBytes(task.total_bytes)} · {task.speed} ·{" "}
          {task.eta}
        </div>
      </div>
      <div className="task-actions">
        {task.status === "downloading" && (
          <>
            <button type="button" onClick={() => void act("download.pause")}>
              暂停
            </button>
            <button type="button" onClick={() => void act("download.cancel")}>
              取消
            </button>
          </>
        )}
        {task.status === "paused" && (
          <button type="button" onClick={() => void act("download.resume")}>
            恢复
          </button>
        )}
        {task.status === "failed" && (
          <button type="button" onClick={() => void act("download.retry")}>
            重试
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
        {(task.status === "completed" ||
          task.status === "cancelled" ||
          task.status === "failed") && (
          <button type="button" onClick={() => void act("download.remove")}>
            移除
          </button>
        )}
      </div>
    </li>
  );
}

export function QueuePage() {
  const tasks = useAppStore((s) => s.tasks);
  const setRoute = useAppStore((s) => s.setRoute);
  const pushToast = useAppStore((s) => s.pushToast);
  const connection = useAppStore((s) => s.connection);
  const active = tasks.filter((t) => t.status === "downloading");
  const totalSpeed = active.map((t) => t.speed).filter(Boolean).join(" · ");

  const batch = async (method: string, okMsg: string) => {
    try {
      await request(method, {});
      const snap = await request("app.getSnapshot");
      useAppStore.getState().hydrateSnapshot(snap as never);
      pushToast({ kind: "success", title: okMsg });
    } catch (err) {
      pushToast({ kind: "error", title: "操作失败", detail: String(err) });
    }
  };

  if (tasks.length === 0) {
    return (
      <div className="page empty">
        <h1>下载队列</h1>
        <p className="muted">还没有任务。</p>
        <button type="button" className="primary" onClick={() => setRoute("new")}>
          新建下载
        </button>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-header row">
        <div>
          <h1>下载队列</h1>
          {active.length > 0 && (
            <p className="muted">
              活跃 {active.length} · {totalSpeed || "—"}
            </p>
          )}
        </div>
        <div className="actions">
          <button
            type="button"
            disabled={connection !== "connected"}
            onClick={() => void batch("download.pauseAll", "已全部暂停")}
          >
            全部暂停
          </button>
          <button
            type="button"
            disabled={connection !== "connected"}
            onClick={() => void batch("download.resumeAll", "已全部恢复")}
          >
            全部恢复
          </button>
          <button
            type="button"
            disabled={connection !== "connected"}
            onClick={() => void batch("download.clearFinished", "已清除完成项")}
          >
            清除已完成
          </button>
        </div>
      </header>
      <ul className="task-list-full">
        {tasks.map((task) => (
          <TaskRow key={task.id} task={task} />
        ))}
      </ul>
    </div>
  );
}
