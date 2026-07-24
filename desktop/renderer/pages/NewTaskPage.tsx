import { useCallback, useEffect, useMemo, useState, type DragEvent } from "react";

import { onEvent, request } from "../lib/api";
import { extractUrls } from "../lib/urls";
import type { ParseResultEvent } from "../lib/types";
import { useAppStore } from "../store/appStore";

interface ParseRow {
  url: string;
  status: "pending" | "ok" | "error" | "cancelled";
  title?: string;
  platform?: string;
  error?: string;
  selected: boolean;
}

export function NewTaskPage() {
  const pushToast = useAppStore((s) => s.pushToast);
  const setRoute = useAppStore((s) => s.setRoute);
  const connection = useAppStore((s) => s.connection);
  const [text, setText] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [rows, setRows] = useState<ParseRow[]>([]);
  const [parseId, setParseId] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);

  const urls = useMemo(() => extractUrls(text), [text]);

  useEffect(() => {
    return onEvent((event) => {
      if (event.event !== "download.parseResult") return;
      const data = event.payload as unknown as ParseResultEvent;
      if (!parseId || data.parseId !== parseId) return;
      setRows((prev) => {
        const next = prev.slice();
        const row = next[data.index];
        if (!row) return prev;
        if (data.cancelled) {
          row.status = "cancelled";
          row.error = "已取消";
        } else if (data.ok && data.info) {
          row.status = "ok";
          row.title = data.info.title;
          row.platform = data.info.platform;
          row.selected = true;
        } else {
          row.status = "error";
          row.error = data.error || "解析失败";
          row.selected = false;
        }
        return next;
      });
    });
  }, [parseId]);

  const startParse = async () => {
    if (urls.length === 0) {
      setFieldError("请粘贴至少一个有效链接");
      return;
    }
    setFieldError("");
    setRows(urls.map((url) => ({ url, status: "pending", selected: false })));
    setParsing(true);
    try {
      const res = await request<{ parseId: string }>("download.parseUrls", { urls });
      setParseId(res.parseId);
    } catch (err) {
      setFieldError(String(err));
      setParsing(false);
    }
  };

  const cancelParse = async () => {
    if (!parseId) return;
    await request("download.cancelParse", { parseId });
    setParsing(false);
  };

  useEffect(() => {
    if (!parsing || rows.length === 0) return;
    if (rows.every((r) => r.status !== "pending")) {
      setParsing(false);
    }
  }, [rows, parsing]);

  const createSelected = async () => {
    const selected = rows.filter((r) => r.selected && r.status === "ok");
    if (selected.length === 0) {
      setFieldError("请选择至少一个解析成功的条目");
      return;
    }
    setFieldError("");
    try {
      await request("download.createTasks", {
        urls: selected.map((r) => r.url),
        items: selected.map((r) => ({ url: r.url, title: r.title })),
      });
      pushToast({ kind: "success", title: `已加入 ${selected.length} 个任务` });
      setRoute("queue");
      const snap = await request<{ tasks: unknown[]; settings: unknown }>("app.getSnapshot");
      useAppStore.getState().hydrateSnapshot(snap as never);
    } catch (err) {
      setFieldError(String(err));
    }
  };

  const skipParseEnqueue = async () => {
    if (urls.length === 0) {
      setFieldError("请粘贴至少一个有效链接");
      return;
    }
    setFieldError("");
    try {
      await request("download.createTasks", { urls });
      pushToast({ kind: "info", title: "已跳过解析入队", detail: "下载开始后会补全标题" });
      setRoute("queue");
      const snap = await request<{ tasks: unknown[]; settings: unknown }>("app.getSnapshot");
      useAppStore.getState().hydrateSnapshot(snap as never);
    } catch (err) {
      setFieldError(String(err));
    }
  };

  const onDrop = useCallback((e: DragEvent) => {
    e.preventDefault();
    const dropped = e.dataTransfer.getData("text") || "";
    if (dropped) {
      setText((prev) => (prev ? `${prev}\n${dropped}` : dropped));
    }
  }, []);

  const disabled = connection !== "connected";

  return (
    <div className="page" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <header className="page-header">
        <h1>新建任务</h1>
        <p>粘贴一个或多个视频链接，解析确认后开始下载。</p>
      </header>

      <label className="field">
        <span className="field-label">视频链接</span>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          placeholder="https://..."
          disabled={disabled || parsing}
          aria-invalid={Boolean(fieldError)}
          aria-describedby={fieldError ? "new-task-error" : undefined}
        />
        {fieldError && (
          <span id="new-task-error" className="field-error">
            {fieldError}
          </span>
        )}
      </label>

      <div className="actions">
        {!parsing ? (
          <button type="button" className="primary" disabled={disabled} onClick={() => void startParse()}>
            解析链接
          </button>
        ) : (
          <button type="button" disabled={disabled} onClick={() => void cancelParse()}>
            取消解析
          </button>
        )}
        <button type="button" disabled={disabled || parsing} onClick={() => void skipParseEnqueue()}>
          跳过解析直接入队
        </button>
      </div>

      {rows.length > 0 && (
        <section className="panel">
          <div className="row">
            <h2>解析结果</h2>
            <button
              type="button"
              className="primary"
              disabled={disabled || parsing}
              onClick={() => void createSelected()}
            >
              开始下载
            </button>
          </div>
          <ul className="result-list">
            {rows.map((row, i) => (
              <li key={`${row.url}-${i}`}>
                <label className="result-row">
                  <input
                    type="checkbox"
                    checked={row.selected}
                    disabled={row.status !== "ok"}
                    onChange={(e) =>
                      setRows((prev) =>
                        prev.map((r, idx) =>
                          idx === i ? { ...r, selected: e.target.checked } : r,
                        ),
                      )
                    }
                  />
                  <div>
                    <strong>{row.title || row.url}</strong>
                    <div className="muted">
                      {row.status === "pending" && "解析中…"}
                      {row.status === "ok" && row.platform}
                      {row.status === "error" && row.error}
                      {row.status === "cancelled" && "已取消"}
                    </div>
                  </div>
                </label>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
