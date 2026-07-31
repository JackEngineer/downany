import { useEffect, useRef, useState } from "react";

import { onEvent, request } from "../lib/api";
import { createTasksAndRefresh } from "../lib/addFlow";
import { formatOptionLabel, formatSelectorValue } from "../lib/formats";
import type { FormatOption, ParseResultEvent } from "../lib/types";
import { useAppStore } from "../store/appStore";

interface ParseRow {
  url: string;
  status: "pending" | "ok" | "error" | "cancelled";
  title?: string;
  platform?: string;
  thumbnailUrl?: string;
  formats?: FormatOption[];
  formatValue?: string;
  audioOnly?: boolean;
  error?: string;
  selected: boolean;
}

/** 「自动开始下载」关闭时的添加确认弹层：先解析，再确认入队。 */
export function AddConfirmDialog() {
  const pendingAddUrls = useAppStore((s) => s.pendingAddUrls);
  const setPendingAddUrls = useAppStore((s) => s.setPendingAddUrls);
  const pushToast = useAppStore((s) => s.pushToast);
  const [rows, setRows] = useState<ParseRow[]>([]);
  const [parseId, setParseId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const startedRef = useRef(false);

  const open = pendingAddUrls !== null;

  useEffect(() => {
    if (!pendingAddUrls || startedRef.current) return;
    startedRef.current = true;
    setRows(
      pendingAddUrls.map((url) => ({ url, status: "pending", selected: false })),
    );
    request<{ parseId: string }>("download.parseUrls", { urls: pendingAddUrls })
      .then((res) => setParseId(res.parseId))
      .catch((err) => {
        pushToast({ kind: "error", title: "解析启动失败", detail: String(err) });
        setPendingAddUrls(null);
      });
  }, [pendingAddUrls, pushToast, setPendingAddUrls]);

  useEffect(() => {
    if (!open) {
      startedRef.current = false;
      setRows([]);
      setParseId(null);
    }
  }, [open]);

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
          row.thumbnailUrl = data.info.thumbnail_url;
          row.formats = data.info.formats || [];
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

  if (!open) return null;

  const parsing = rows.some((r) => r.status === "pending");

  const close = async () => {
    if (parseId) {
      await request("download.cancelParse", { parseId }).catch(() => undefined);
    }
    setPendingAddUrls(null);
  };

  const confirm = async () => {
    const selected = rows.filter((r) => r.selected && r.status === "ok");
    if (selected.length === 0) {
      pushToast({ kind: "warning", title: "请选择至少一个解析成功的条目" });
      return;
    }
    setSubmitting(true);
    try {
      await createTasksAndRefresh(
        selected.map((r) => r.url),
        selected.map((r) => ({
          url: r.url,
          title: r.title,
          thumbnail_url: r.thumbnailUrl,
          format_id: r.audioOnly ? undefined : r.formatValue || undefined,
          audio_only: r.audioOnly || undefined,
        })),
      );
      setPendingAddUrls(null);
    } catch (err) {
      pushToast({ kind: "error", title: "添加失败", detail: String(err) });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={() => void close()}>
      <div
        className="dialog dialog-wide"
        role="dialog"
        aria-modal="true"
        aria-label="确认下载"
        onClick={(e) => e.stopPropagation()}
      >
        <h2>确认下载</h2>
        <ul className="confirm-list">
          {rows.map((row) => (
            <li key={row.url}>
              <label className="confirm-row">
                <input
                  type="checkbox"
                  checked={row.selected}
                  disabled={row.status !== "ok"}
                  onChange={(e) =>
                    setRows((prev) =>
                      prev.map((r) =>
                        r.url === row.url ? { ...r, selected: e.target.checked } : r,
                      ),
                    )
                  }
                />
                {row.thumbnailUrl ? (
                  <img className="card-thumb" src={row.thumbnailUrl} alt="" />
                ) : (
                  <div className="card-thumb card-thumb-placeholder" aria-hidden>
                    {(row.platform || "视").slice(0, 1)}
                  </div>
                )}
                <div className="grow">
                  <strong>{row.title || row.url}</strong>
                  <div className="muted">
                    {row.status === "pending" && "解析中…"}
                    {row.status === "ok" && row.platform}
                    {row.status === "error" && row.error}
                    {row.status === "cancelled" && "已取消"}
                  </div>
                </div>
                {row.status === "ok" && (
                  <div className="confirm-options" onClick={(e) => e.preventDefault()}>
                    {row.formats && row.formats.length > 0 && !row.audioOnly && (
                      <select
                        value={row.formatValue || ""}
                        aria-label="画质"
                        onChange={(e) =>
                          setRows((prev) =>
                            prev.map((r) =>
                              r.url === row.url
                                ? { ...r, formatValue: e.target.value || undefined }
                                : r,
                            ),
                          )
                        }
                      >
                        <option value="">最佳画质</option>
                        {row.formats.map((f) => (
                          <option key={f.format_id} value={formatSelectorValue(f)}>
                            {formatOptionLabel(f)}
                          </option>
                        ))}
                      </select>
                    )}
                    <label className="confirm-audio">
                      <input
                        type="checkbox"
                        checked={Boolean(row.audioOnly)}
                        onChange={(e) =>
                          setRows((prev) =>
                            prev.map((r) =>
                              r.url === row.url
                                ? { ...r, audioOnly: e.target.checked }
                                : r,
                            ),
                          )
                        }
                      />
                      仅音频
                    </label>
                  </div>
                )}
              </label>
            </li>
          ))}
        </ul>
        <div className="dialog-actions">
          <button type="button" onClick={() => void close()}>
            取消
          </button>
          <button
            type="button"
            className="primary"
            disabled={parsing || submitting}
            onClick={() => void confirm()}
          >
            {parsing ? "解析中…" : "开始下载"}
          </button>
        </div>
      </div>
    </div>
  );
}
