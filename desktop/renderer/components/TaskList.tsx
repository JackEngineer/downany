import { useMemo } from "react";

import { isActiveStatus } from "../lib/format";
import type { TaskSnapshot } from "../lib/types";
import { useAppStore } from "../store/appStore";
import { DownloadCard } from "./DownloadCard";

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
      const ta = a.completed_at || a.created_at;
      const tb = b.completed_at || b.created_at;
      return tb.localeCompare(ta);
    });
}

export function TaskList() {
  const tasks = useAppStore((s) => s.tasks);
  const filter = useAppStore((s) => s.filter);
  const searchQuery = useAppStore((s) => s.searchQuery);
  const searchMode = useAppStore((s) => s.searchMode);

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
          t.platform.toLowerCase().includes(q),
      );
    }
    return list;
  }, [tasks, filter, searchQuery, searchMode]);

  if (tasks.length === 0) {
    return (
      <div className="drop-hint">
        <div className="drop-hint-icon" aria-hidden>
          ⇩
        </div>
        <p>把链接拖到这里，或在上方粘贴 URL 回车开始下载</p>
        <p className="muted">也可以从浏览器扩展一键发送</p>
      </div>
    );
  }

  if (visible.length === 0) {
    return <p className="muted list-empty">没有匹配的任务</p>;
  }

  return (
    <ul className="download-list">
      {visible.map((task) => (
        <DownloadCard key={task.id} task={task} />
      ))}
    </ul>
  );
}
