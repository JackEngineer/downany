import { useEffect, useMemo, useRef, useState } from "react";

import { onEvent, openExtractWindow, request } from "../lib/api";
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
  playlistKey?: string;
  playlistTitle?: string;
  playlistIndex?: number;
  unavailable?: boolean;
}

function entryLooksUnavailable(entry: {
  title?: string;
  id?: string;
  available?: boolean | string;
}): boolean {
  return entry.available === false || entry.available === "0";
}

function canSelectRow(row: ParseRow): boolean {
  return row.status === "ok" && !row.unavailable;
}

type RenderBlock =
  | { kind: "single"; row: ParseRow; index: number }
  | {
      kind: "playlist";
      key: string;
      title: string;
      rows: { row: ParseRow; index: number }[];
    };

function parseRangeInput(text: string): Set<number> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const selected = new Set<number>();
  for (const part of trimmed.split(/[,，\s]+/)) {
    if (!part) continue;
    const range = part.match(/^(\d+)\s*[-–~至到]\s*(\d+)$/);
    if (range) {
      let start = Number(range[1]);
      let end = Number(range[2]);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      if (start > end) [start, end] = [end, start];
      for (let i = start; i <= end; i += 1) selected.add(i);
      continue;
    }
    const single = Number(part);
    if (Number.isFinite(single) && single > 0) selected.add(single);
  }
  return selected.size > 0 ? selected : null;
}

function buildBlocks(rows: ParseRow[]): RenderBlock[] {
  const blocks: RenderBlock[] = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    if (row.playlistKey) {
      const key = row.playlistKey;
      const group: { row: ParseRow; index: number }[] = [];
      while (i < rows.length && rows[i].playlistKey === key) {
        group.push({ row: rows[i], index: i });
        i += 1;
      }
      blocks.push({
        kind: "playlist",
        key,
        title: group[0]?.row.playlistTitle || "播放列表",
        rows: group,
      });
      continue;
    }
    blocks.push({ kind: "single", row, index: i });
    i += 1;
  }
  return blocks;
}

function newGroupId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `g-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 「自动开始下载」关闭时的添加确认弹层：先解析，再确认入队。 */
export function AddConfirmDialog() {
  const pendingAddUrls = useAppStore((s) => s.pendingAddUrls);
  const setPendingAddUrls = useAppStore((s) => s.setPendingAddUrls);
  const pushToast = useAppStore((s) => s.pushToast);
  const [rows, setRows] = useState<ParseRow[]>([]);
  const [parseId, setParseId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [rangeDrafts, setRangeDrafts] = useState<Record<string, string>>({});
  const startedRef = useRef(false);

  const open = pendingAddUrls !== null;
  const blocks = useMemo(() => buildBlocks(rows), [rows]);

  useEffect(() => {
    if (!pendingAddUrls || startedRef.current) return;
    startedRef.current = true;
    setRows(
      pendingAddUrls.map((url) => ({ url, status: "pending", selected: false })),
    );
    request<{ parseId: string }>("download.parseUrls", {
      urls: pendingAddUrls,
      allow_playlist: true,
    })
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
      setRangeDrafts({});
    }
  }, [open]);

  useEffect(() => {
    return onEvent((event) => {
      if (event.event !== "download.parseResult") return;
      const data = event.payload as unknown as ParseResultEvent;
      if (!parseId || data.parseId !== parseId) return;
      setRows((prev) => {
        const next = prev.slice();
        const targetIndex = next.findIndex(
          (r) =>
            !r.playlistKey &&
            r.url === data.url &&
            (r.status === "pending" || r.status === "cancelled"),
        );
        const rowIndex = targetIndex >= 0 ? targetIndex : data.index;
        const row = next[rowIndex];
        if (!row) return prev;
        if (data.cancelled) {
          row.status = "cancelled";
          row.error = "已取消";
        } else if (data.ok && data.entries && data.entries.length > 1) {
          const playlistKey = `pl-${data.index}-${data.playlist?.id || data.url}`;
          const playlistTitle =
            data.playlist?.title || data.info?.title || "播放列表";
          const expanded: ParseRow[] = data.entries.map((entry, entryIdx) => {
            const rawIndex = entry.index;
            const playlistIndex =
              typeof rawIndex === "number"
                ? rawIndex
                : Number(rawIndex) || entryIdx + 1;
            const unavailable = entryLooksUnavailable(entry);
            const idTag = entry.id || entry.url;
            return {
              url: entry.url,
              status: "ok" as const,
              title: unavailable
                ? `已下架（${idTag}）`
                : entry.title || entry.id || entry.url,
              platform: data.info?.platform,
              thumbnailUrl: entry.thumbnail_url || undefined,
              formats: [],
              selected: !unavailable,
              playlistKey,
              playlistTitle,
              playlistIndex,
              unavailable,
              error: unavailable ? "上传者已删除或不可用，默认跳过" : undefined,
            };
          });
          next.splice(rowIndex, 1, ...expanded);
          return next;
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

  const updateGroupSelection = (
    key: string,
    mapper: (row: ParseRow) => ParseRow,
  ) => {
    setRows((prev) =>
      prev.map((row) => (row.playlistKey === key ? mapper(row) : row)),
    );
  };

  const applyRange = (key: string) => {
    const selected = parseRangeInput(rangeDrafts[key] || "");
    if (!selected) {
      pushToast({
        kind: "warning",
        title: "范围无效",
        detail: "请输入如 5-20 或 1,3,8-10",
      });
      return;
    }
    updateGroupSelection(key, (row) => ({
      ...row,
      selected: canSelectRow(row) && selected.has(row.playlistIndex || 0),
    }));
  };

  const confirm = async () => {
    const selected = rows.filter((r) => r.selected && r.status === "ok");
    if (selected.length === 0) {
      pushToast({ kind: "warning", title: "请选择至少一个解析成功的条目" });
      return;
    }
    setSubmitting(true);
    try {
      const groupIds = new Map<string, string>();
      await createTasksAndRefresh(
        selected.map((r) => r.url),
        selected.map((r) => {
          let group_id: string | undefined;
          let group_title: string | undefined;
          let playlist_index: number | undefined;
          if (r.playlistKey) {
            if (!groupIds.has(r.playlistKey)) {
              groupIds.set(r.playlistKey, newGroupId());
            }
            group_id = groupIds.get(r.playlistKey);
            group_title = r.playlistTitle;
            playlist_index = r.playlistIndex;
          }
          return {
            url: r.url,
            title: r.title,
            thumbnail_url: r.thumbnailUrl,
            format_id: r.audioOnly ? undefined : r.formatValue || undefined,
            audio_only: r.audioOnly || undefined,
            group_id,
            group_title,
            playlist_index,
          };
        }),
      );
      setPendingAddUrls(null);
    } catch (err) {
      pushToast({ kind: "error", title: "添加失败", detail: String(err) });
    } finally {
      setSubmitting(false);
    }
  };

  const renderRow = (row: ParseRow, opts?: { compact?: boolean }) => {
    const compact = Boolean(opts?.compact);
    const showThumb = Boolean(row.thumbnailUrl) || !compact;
    const toggleSelected = () => {
      if (!canSelectRow(row)) return;
      setRows((prev) =>
        prev.map((r) =>
          r.url === row.url && r.playlistKey === row.playlistKey
            ? { ...r, selected: !r.selected }
            : r,
        ),
      );
    };
    return (
      <div
        className={`confirm-row${row.unavailable ? " confirm-row-unavailable" : ""}${compact ? " confirm-row-compact" : ""}`}
        key={`${row.playlistKey || "s"}-${row.url}`}
      >
        <input
          type="checkbox"
          checked={row.selected}
          disabled={!canSelectRow(row)}
          aria-label="选择此条目"
          onChange={(e) =>
            setRows((prev) =>
              prev.map((r) =>
                r.url === row.url && r.playlistKey === row.playlistKey
                  ? { ...r, selected: e.target.checked }
                  : r,
              ),
            )
          }
        />
        {row.playlistIndex ? (
          <span className="confirm-index" aria-hidden>
            {String(row.playlistIndex).padStart(2, "0")}
          </span>
        ) : null}
        {showThumb ? (
          row.thumbnailUrl ? (
            <img
              className="card-thumb"
              src={row.thumbnailUrl}
              alt=""
              referrerPolicy="no-referrer"
              onClick={toggleSelected}
            />
          ) : (
            <div
              className="card-thumb card-thumb-placeholder"
              aria-hidden
              onClick={toggleSelected}
            >
              {(row.platform || "视").slice(0, 1)}
            </div>
          )
        ) : null}
        <button
          type="button"
          className="confirm-row-main"
          disabled={!canSelectRow(row)}
          onClick={toggleSelected}
        >
          <strong>{row.title || row.url}</strong>
          <span className="muted">
            {row.status === "pending" && "解析中…"}
            {row.status === "ok" && !row.unavailable && row.platform}
            {row.status === "ok" && row.unavailable && (
              <span className="danger-text">{row.error || "不可用"}</span>
            )}
            {row.status === "error" && row.error}
            {row.status === "cancelled" && "已取消"}
          </span>
        </button>
        {row.status === "error" && (
          <button
            type="button"
            className="link-btn"
            onClick={() => void openExtractWindow(row.url)}
          >
            用浏览器抓取
          </button>
        )}
        {row.status === "ok" && !row.unavailable && (
          <div className="confirm-options">
            {row.formats && row.formats.length > 0 && !row.audioOnly && (
              <select
                value={row.formatValue || ""}
                aria-label="画质"
                onChange={(e) =>
                  setRows((prev) =>
                    prev.map((r) =>
                      r.url === row.url && r.playlistKey === row.playlistKey
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
                      r.url === row.url && r.playlistKey === row.playlistKey
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
      </div>
    );
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
          {blocks.map((block) => {
            if (block.kind === "single") {
              return <li key={block.row.url}>{renderRow(block.row)}</li>;
            }
            const selectable = block.rows.filter((r) => canSelectRow(r.row));
            const selectedCount = selectable.filter((r) => r.row.selected).length;
            const skipped = block.rows.filter((r) => r.row.unavailable).length;
            return (
              <li key={block.key} className="confirm-playlist">
                <div className="confirm-playlist-header">
                  <div className="confirm-playlist-title">
                    <strong>{block.title}</strong>
                    <span className="muted">
                      已选 {selectedCount}/{selectable.length}
                      {skipped > 0 ? ` · 跳过不可用 ${skipped}` : ""}
                    </span>
                  </div>
                  <div className="confirm-playlist-toolbar">
                    <div className="confirm-playlist-actions">
                      <button
                        type="button"
                        onClick={() =>
                          updateGroupSelection(block.key, (row) => ({
                            ...row,
                            selected: canSelectRow(row),
                          }))
                        }
                      >
                        全选
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          updateGroupSelection(block.key, (row) => ({
                            ...row,
                            selected: false,
                          }))
                        }
                      >
                        全不选
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          updateGroupSelection(block.key, (row) => ({
                            ...row,
                            selected: canSelectRow(row) ? !row.selected : false,
                          }))
                        }
                      >
                        反选
                      </button>
                    </div>
                    <div className="confirm-range">
                      <input
                        className="confirm-range-input"
                        placeholder="5-20"
                        aria-label="选择范围"
                        value={rangeDrafts[block.key] || ""}
                        onChange={(e) =>
                          setRangeDrafts((prev) => ({
                            ...prev,
                            [block.key]: e.target.value,
                          }))
                        }
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            applyRange(block.key);
                          }
                        }}
                      />
                      <button type="button" onClick={() => applyRange(block.key)}>
                        应用范围
                      </button>
                    </div>
                  </div>
                </div>
                <ul className="confirm-playlist-items">
                  {block.rows.map(({ row }) => (
                    <li key={`${block.key}-${row.url}`}>
                      {renderRow(row, { compact: true })}
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
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
