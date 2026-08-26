import {
  formatBytes,
  platformLabel,
  statusLabel,
} from "../../lib/format";
import type { TaskSnapshot } from "../../lib/types";
import { failureRecoveryFor } from "./failureRecovery";

export type TaskVisualState =
  | "pending"
  | "downloading"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

export type TaskTone = "neutral" | "active" | "warning" | "success" | "danger";
export type TaskPrimaryAction = "pause" | "resume" | "open" | "retry" | null;

export interface TaskPresentation {
  status: TaskVisualState;
  label: string;
  tone: TaskTone;
  meta: string[];
  detail: string;
  primaryAction: TaskPrimaryAction;
  primaryLabel: string;
  showProgress: boolean;
  progress: number;
}

const STATE_VIEW = {
  pending: { tone: "neutral", primaryAction: null, primaryLabel: "" },
  downloading: { tone: "active", primaryAction: "pause", primaryLabel: "暂停" },
  paused: { tone: "warning", primaryAction: "resume", primaryLabel: "继续" },
  completed: { tone: "success", primaryAction: "open", primaryLabel: "打开" },
  failed: { tone: "danger", primaryAction: "retry", primaryLabel: "重试" },
  cancelled: { tone: "neutral", primaryAction: "retry", primaryLabel: "重新下载" },
  unknown: { tone: "neutral", primaryAction: null, primaryLabel: "" },
} as const satisfies Record<
  TaskVisualState,
  {
    tone: TaskTone;
    primaryAction: TaskPrimaryAction;
    primaryLabel: string;
  }
>;

export function toTaskVisualState(status: string): TaskVisualState {
  switch (status) {
    case "pending":
    case "downloading":
    case "paused":
    case "completed":
    case "failed":
    case "cancelled":
      return status;
    default:
      return "unknown";
  }
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function completedLabel(value: string, now: Date): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  return sameDay
    ? `今天 ${time}`
    : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

export function presentTask(
  task: TaskSnapshot,
  now = new Date(),
): TaskPresentation {
  const status = toTaskVisualState(task.status);
  const stateView = STATE_VIEW[status];
  const failure =
    status === "failed" ? failureRecoveryFor(task.error_code) : null;
  const bytes = formatBytes(task.total_bytes || task.downloaded_bytes);
  const meta = [platformLabel(task.platform)];
  if (task.quality && task.quality !== "best") meta.push(task.quality);
  if (bytes !== "—") meta.push(bytes);
  if (status === "completed" && task.completed_at) {
    const completed = completedLabel(task.completed_at, now);
    if (completed) meta.push(completed);
  }

  const transferDetail = [
    `${formatBytes(task.downloaded_bytes)} / ${formatBytes(task.total_bytes)}`,
    task.speed,
    task.eta,
  ]
    .filter((item) => item && item !== "—")
    .join(" · ");
  const detail =
    status === "failed"
      ? failure?.detail || ""
      : status === "completed"
        ? String(task.completion_note || "").trim()
        : status === "downloading" || status === "paused"
          ? transferDetail
          : "";
  const progress = Number.isFinite(Number(task.progress))
    ? Math.min(100, Math.max(0, Number(task.progress)))
    : 0;
  const canOpen = status !== "completed" || Boolean(task.file_path);
  const allowPrimary = canOpen && (failure?.retryable ?? true);

  return {
    status,
    label: statusLabel(status),
    tone: stateView.tone,
    meta,
    detail,
    primaryAction: allowPrimary ? stateView.primaryAction : null,
    primaryLabel: allowPrimary ? stateView.primaryLabel : "",
    showProgress: status === "downloading" || status === "paused",
    progress,
  };
}
