import { isActiveStatus } from "./format";
import type { TaskSnapshot } from "./types";

export type QueueUnit =
  | { kind: "task"; key: `task:${string}`; taskIds: [string]; priority: number }
  | { kind: "group"; key: `group:${string}`; taskIds: string[]; priority: number };

export type QueueMove = "up" | "down" | "top";

function compareText(first: string, second: string): number {
  return first < second ? -1 : first > second ? 1 : 0;
}

export function compareQueueTasks(first: TaskSnapshot, second: TaskSnapshot): number {
  return (second.priority ?? 0) - (first.priority ?? 0)
    || (first.queue_order ?? 0) - (second.queue_order ?? 0)
    || compareText(first.created_at, second.created_at)
    || compareText(first.id, second.id);
}

export function comparePlaylistTasks(first: TaskSnapshot, second: TaskSnapshot): number {
  return (first.playlist_index ?? 0) - (second.playlist_index ?? 0)
    || compareText(first.created_at, second.created_at)
    || compareText(first.id, second.id);
}

export function buildQueueUnits(tasks: TaskSnapshot[]): QueueUnit[] {
  const active = tasks.filter((task) => isActiveStatus(task.status)).sort(compareQueueTasks);
  const units: QueueUnit[] = [];
  const groups = new Map<string, { unit: Extract<QueueUnit, { kind: "group" }>; tasks: TaskSnapshot[] }>();
  for (const task of active) {
    const groupId = task.group_id?.trim();
    if (!groupId) {
      units.push({ kind: "task", key: `task:${task.id}`, taskIds: [task.id], priority: task.priority ?? 0 });
      continue;
    }
    const existing = groups.get(groupId);
    if (existing) {
      existing.tasks.push(task);
    } else {
      const unit: Extract<QueueUnit, { kind: "group" }> = {
        kind: "group", key: `group:${groupId}`, taskIds: [], priority: task.priority ?? 0,
      };
      groups.set(groupId, { unit, tasks: [task] });
      units.push(unit);
    }
  }
  for (const { unit, tasks: members } of groups.values()) {
    unit.taskIds = members.sort(comparePlaylistTasks).map((task) => task.id);
  }
  return units;
}

export function moveQueueUnit(
  units: readonly QueueUnit[], key: QueueUnit["key"], move: QueueMove,
): string[] {
  const index = units.findIndex((unit) => unit.key === key);
  if (index < 0) throw new Error("队列已变化，请刷新后重试");
  let destination = index;
  const priority = units[index].priority;
  switch (move) {
    case "up":
      if (index > 0 && units[index - 1].priority === priority) destination -= 1;
      break;
    case "down":
      if (index + 1 < units.length && units[index + 1].priority === priority) destination += 1;
      break;
    case "top":
      while (destination > 0 && units[destination - 1].priority === priority) destination -= 1;
      break;
    default: {
      const exhaustive: never = move;
      throw new Error(`Unknown queue move: ${exhaustive}`);
    }
  }
  const reordered = [...units];
  const [unit] = reordered.splice(index, 1);
  reordered.splice(destination, 0, unit);
  return reordered.flatMap((item) => item.taskIds);
}
