import type { TaskSnapshot } from "./types";
import { platformLabel } from "./format";
import { presentTask } from "../components/task/taskPresentation";
export function sourceName(task: Pick<TaskSnapshot, "platform" | "url">): string {
  try { const u = new URL(task.url); if (u.protocol === "file:") return "本地文件"; if (!["https:", "http:"].includes(u.protocol)) return "来源待确认"; return ["unknown", "", "generic"].includes(task.platform.toLowerCase()) ? u.hostname : platformLabel(task.platform); } catch { return "来源待确认"; }
}
export function taskState(task: TaskSnapshot): string { return task.status === "downloading" && task.progress >= 100 ? "正在处理与校验" : presentTask(task).label; }
