import { useEffect, useMemo, useState } from "react";

import { EmptyState, isOnboardingDismissed } from "./EmptyState";
import { PlaylistGroupCard } from "./PlaylistGroupCard";
import { isActiveStatus } from "../lib/format";
import { getLocale, t } from "../i18n";
import type { TaskSnapshot } from "../lib/types";
import { useAppStore } from "../store/appStore";
import { DownloadCard } from "./DownloadCard";

type QueueItem =
  | { kind: "task"; task: TaskSnapshot }
  | { kind: "group"; groupId: string; tasks: TaskSnapshot[] };

function sortTasks(tasks: TaskSnapshot[]): TaskSnapshot[] {
  const rank = (t: TaskSnapshot): number => {
    if (isActiveStatus(t.status)) return 0;
    if (t.status === "failed" || t.status === "cancelled") return 1;
    return 2;
  };
  return tasks
    .slice()
    .sort((a, b) => {
      const r = rank(a) - rank(b);
      if (r !== 0) return r;
      const orderA = a.queue_order ?? 0;
      const orderB = b.queue_order ?? 0;
      if (orderA !== orderB) return orderA - orderB;
      const ta = a.completed_at || a.created_at;
      const tb = b.completed_at || b.created_at;
      return tb.localeCompare(ta);
    });
}

function groupVisibleTasks(tasks: TaskSnapshot[]): QueueItem[] {
  const items: QueueItem[] = [];
  const seenGroups = new Set<string>();
  for (const task of tasks) {
    const groupId = (task.group_id || "").trim();
    if (!groupId) {
      items.push({ kind: "task", task });
      continue;
    }
    if (seenGroups.has(groupId)) continue;
    seenGroups.add(groupId);
    const groupTasks = tasks.filter((t) => (t.group_id || "").trim() === groupId);
    items.push({ kind: "group", groupId, tasks: groupTasks });
  }
  return items;
}

export function TaskList() {
  const tasks = useAppStore((s) => s.tasks);
  const filter = useAppStore((s) => s.filter);
  const searchQuery = useAppStore((s) => s.searchQuery);
  const searchMode = useAppStore((s) => s.searchMode);
  const [showOnboarding, setShowOnboarding] = useState(() => !isOnboardingDismissed());
  const locale = getLocale();

  useEffect(() => {
    const refresh = () => setShowOnboarding(!isOnboardingDismissed());
    window.addEventListener("downany:onboarding", refresh);
    window.addEventListener("downany:locale", refresh);
    return () => {
      window.removeEventListener("downany:onboarding", refresh);
      window.removeEventListener("downany:locale", refresh);
    };
  }, []);

  const visible = useMemo(() => {
    let list = sortTasks(tasks);
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
  }, [tasks, filter, searchQuery, searchMode]);

  if (tasks.length === 0) {
    if (showOnboarding) {
      return <EmptyState />;
    }
    return (
      <div className="drop-hint">
        <div className="drop-hint-icon" aria-hidden>
          ⇩
        </div>
        <p>{t("onboarding.paste", locale)}</p>
        <p className="muted">{t("onboarding.extension", locale)}</p>
      </div>
    );
  }

  if (visible.length === 0) {
    return <p className="muted list-empty">{t("empty.noMatch", locale)}</p>;
  }

  return (
    <ul className="download-list">
      {visible.map((item) =>
        item.kind === "group" ? (
          <PlaylistGroupCard key={item.groupId} tasks={item.tasks} />
        ) : (
          <DownloadCard key={item.task.id} task={item.task} />
        ),
      )}
    </ul>
  );
}
