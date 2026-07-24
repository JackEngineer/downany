import { useCallback, useEffect, useState } from "react";

import type { ConnectionState } from "../electron/protocol";

interface TaskSnap {
  id: string;
  title: string;
  status: string;
  progress: number;
}

interface Snapshot {
  tasks: TaskSnap[];
  settings?: Record<string, unknown>;
}

const STATE_LABEL: Record<ConnectionState, string> = {
  connecting: "连接中",
  connected: "已连接",
  reconnecting: "重连中",
  disconnected: "已断开",
  failed: "连接失败",
};

export function App() {
  const [state, setState] = useState<ConnectionState>("connecting");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string>("");
  const [logDir, setLogDir] = useState<string>("");

  const refresh = useCallback(async () => {
    try {
      const snap = (await window.api.request("app.getSnapshot")) as Snapshot;
      setSnapshot(snap);
      setError("");
    } catch (err) {
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    void window.api.getConnectionState().then(setState);
    void window.api.getLogDir().then(setLogDir);
    const offState = window.api.onState(setState);
    const offEvent = window.api.onEvent((event) => {
      if (event.event.startsWith("task.") || event.event === "sidecar.health") {
        void refresh();
      }
    });
    void refresh();
    return () => {
      offState();
      offEvent();
    };
  }, [refresh]);

  const onQuit = async () => {
    try {
      await window.api.request("app.shutdown");
    } catch {
      // ignore
    }
    await window.api.quit();
  };

  const tasks = snapshot?.tasks ?? [];

  return (
    <div className="page">
      <header className="header">
        <div>
          <h1>视频下载器</h1>
          <p className="sub">阶段 1 进程外壳 · 连接与快照</p>
        </div>
        <span className={`badge badge-${state}`}>{STATE_LABEL[state]}</span>
      </header>

      {state === "failed" && (
        <section className="panel warn">
          <p>无法连接下载核心。请查看日志后重试。</p>
          <p className="mono">{logDir || "（日志目录未知）"}</p>
          <button type="button" onClick={() => void window.api.openPath(logDir)}>
            打开日志目录
          </button>
        </section>
      )}

      {error && <p className="error">{error}</p>}

      <section className="panel">
        <div className="row">
          <h2>任务快照（{tasks.length}）</h2>
          <button type="button" onClick={() => void refresh()} disabled={state !== "connected"}>
            刷新快照
          </button>
        </div>
        {tasks.length === 0 ? (
          <p className="muted">暂无任务。命令中心界面将在阶段 2 提供。</p>
        ) : (
          <ul className="task-list">
            {tasks.map((task) => (
              <li key={task.id}>
                <strong>{task.title || task.id}</strong>
                <span>
                  {task.status} · {Math.round(task.progress || 0)}%
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer className="footer">
        <button type="button" className="danger" onClick={() => void onQuit()}>
          退出应用
        </button>
      </footer>
    </div>
  );
}
