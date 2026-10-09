import type { TaskSnapshot } from "./types";

export type DownloadSortOrder = "newest" | "oldest";

function sortDirection(order: DownloadSortOrder): number {
  switch (order) {
    case "newest": return -1;
    case "oldest": return 1;
    default: { const exhaustive: never = order; throw new Error(`Unknown sort order: ${exhaustive}`); }
  }
}

export function sortDownloadTasks(tasks: readonly TaskSnapshot[], order: DownloadSortOrder, completed = false): TaskSnapshot[] {
  const time = (task: TaskSnapshot) => {
    const value = Date.parse(completed ? task.completed_at || task.created_at : task.created_at);
    return Number.isFinite(value) ? value : 0;
  };
  const direction = sortDirection(order);
  return [...tasks].sort((a, b) => direction * (time(a) - time(b))
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
