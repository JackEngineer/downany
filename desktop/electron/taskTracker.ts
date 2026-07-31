/** 主进程侧的任务状态跟踪：驱动 Dock 角标/进度条与托盘菜单。 */

export interface TrackedTask {
  id: string;
  title: string;
  status: string;
  progress: number;
}

interface SnapshotLike {
  id?: string;
  title?: string;
  status?: string;
  progress?: number;
}

export class TaskTracker {
  private tasks = new Map<string, TrackedTask>();

  hydrate(list: SnapshotLike[]): void {
    this.tasks.clear();
    for (const t of list) {
      if (!t.id) continue;
      this.tasks.set(t.id, {
        id: t.id,
        title: t.title || "",
        status: t.status || "pending",
        progress: typeof t.progress === "number" ? t.progress : 0,
      });
    }
  }

  applyEvent(event: { event: string; payload: Record<string, unknown> }): void {
    const payload = event.payload || {};
    const taskId = String(payload.taskId || payload.task_id || "");
    const incoming = payload.task as SnapshotLike | undefined;

    if (event.event === "task.removed" && taskId) {
      this.tasks.delete(taskId);
      return;
    }

    if (incoming && incoming.id) {
      const prev = this.tasks.get(incoming.id);
      const next: TrackedTask = {
        id: incoming.id,
        title: incoming.title ?? prev?.title ?? "",
        status: incoming.status ?? prev?.status ?? "pending",
        progress:
          typeof incoming.progress === "number"
            ? incoming.progress
            : prev?.progress ?? 0,
      };
      // 重新插入以把最近活跃的任务移到末尾
      this.tasks.delete(incoming.id);
      this.tasks.set(incoming.id, next);
      return;
    }

    if (event.event === "task.progress" && taskId && payload.progress) {
      const prev = this.tasks.get(taskId);
      if (!prev) return;
      const progress = payload.progress as { progress?: number };
      this.tasks.set(taskId, {
        ...prev,
        progress:
          typeof progress.progress === "number" ? progress.progress : prev.progress,
      });
    }
  }

  activeCount(): number {
    let count = 0;
    for (const t of this.tasks.values()) {
      if (t.status === "downloading" || t.status === "pending") count += 1;
    }
    return count;
  }

  /** 聚合进度 0..1；无进行中任务时返回 -1。 */
  aggregateProgress(): number {
    const active = [...this.tasks.values()].filter(
      (t) => t.status === "downloading" || t.status === "pending",
    );
    if (active.length === 0) return -1;
    const sum = active.reduce(
      (acc, t) => acc + Math.min(100, Math.max(0, t.progress)),
      0,
    );
    return sum / active.length / 100;
  }

  /** 最近任务（按最近活跃排序）。 */
  recent(limit = 5): TrackedTask[] {
    return [...this.tasks.values()].slice(-limit).reverse();
  }
}
