import { useMemo } from "react";

import { sortDownloadTasks } from "../lib/downloadSorting";
import { EmptyState } from "./EmptyState";
import { PlaylistGroupCard } from "./PlaylistGroupCard";
import { QueueOrderControls } from "./QueueOrderControls";
import { isActiveStatus } from "../lib/format";
import { buildQueueUnits, type QueueUnit } from "../lib/queueOrdering";
import { t, useLocale } from "../i18n";
import type { TaskSnapshot } from "../lib/types";
import { useAppStore } from "../store/appStore";
import { MediaTaskBanner } from "./task/MediaTaskBanner";

type QueueItem =
  | { kind: "task"; task: TaskSnapshot }
  | { kind: "group"; groupId: string; tasks: TaskSnapshot[] };

function groupVisibleTasks(tasks: TaskSnapshot[]): QueueItem[] {
  const items: QueueItem[] = [];
  const groups = new Map<string, Extract<QueueItem, { kind: "group" }>>();
  for (const task of tasks) {
    const groupId = (task.group_id || "").trim();
    if (!groupId) {
      items.push({ kind: "task", task });
      continue;
    }
    const existing = groups.get(groupId);
    if (existing) {
      existing.tasks.push(task);
    } else {
      const item: Extract<QueueItem, { kind: "group" }> = { kind: "group", groupId, tasks: [task] };
      groups.set(groupId, item);
      items.push(item);
    }
  }
  return items;
}

export function TaskList() {
  const tasks = useAppStore((s) => s.tasks);
  const filter = useAppStore((s) => s.filter);
  const sortOrder = useAppStore((s) => s.sortOrder);
  const searchQuery = useAppStore((s) => s.searchQuery);
  const searchMode = useAppStore((s) => s.searchMode);
  const locale = useLocale();
  const ordering = useMemo(() => {
    const units = buildQueueUnits(tasks);
    const moves = new Map(units.map((unit, index) => [unit.key, {
      canMoveUp: index > 0 && units[index - 1].priority === unit.priority,
      canMoveDown: index + 1 < units.length && units[index + 1].priority === unit.priority,
    }]));
    return { moves };
  }, [tasks]);

  const visible = useMemo(() => {
    let list = sortDownloadTasks(tasks, sortOrder, filter === "completed");
    if (filter === "active") list = list.filter((t) => isActiveStatus(t.status));
    if (filter === "completed") list = list.filter((t) => t.status === "completed");
    const q = searchMode === "filter" ? searchQuery.trim().toLowerCase() : "";
    if (q) {
      list = list.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          t.url.toLowerCase().includes(q) ||
          t.platform.toLowerCase().includes(q) ||
          (t.group_title || "").toLowerCase().includes(q),
      );
    }
    return groupVisibleTasks(list);
  }, [tasks, sortOrder, filter, searchQuery, searchMode]);

  const controls = (key: QueueUnit["key"], label: string, active: boolean) => {
    const moves = ordering.moves.get(key);
    return active && moves
      ? <QueueOrderControls unitKey={key} label={label} {...moves} />
      : undefined;
  };

  if (tasks.length === 0) {
    return <EmptyState />;
  }

  if (visible.length === 0) {
    return <p className="muted list-empty">{t("empty.noMatch", locale)}</p>;
  }

  return (
    <ul className="download-list">
      {visible.map((item) =>
        item.kind === "group" ? (
          <PlaylistGroupCard key={item.groupId} tasks={item.tasks}
            queueControls={controls(`group:${item.groupId}`, item.tasks[0]?.group_title || t("group.title", locale),
              item.tasks.some((task) => isActiveStatus(task.status)))} />
        ) : (
          <MediaTaskBanner key={item.task.id} task={item.task} density="normal"
            queueControls={controls(`task:${item.task.id}`, item.task.title, isActiveStatus(item.task.status))} />
        ),
      )}
    </ul>
  );
}
