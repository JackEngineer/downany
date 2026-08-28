/** Pure protocol helpers, shared by Electron and Renderer; no Electron imports. */
export interface TaskProgressPatch {
  taskId: string;
  progress?: number;
  downloaded_bytes?: number;
  total_bytes?: number;
  speed?: string;
  eta?: string;
}

interface ProgressEvent {
  event: string;
  payload: Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function acceptsTaskProgress(status: string): boolean {
  return status === "pending" || status === "downloading" || status === "paused";
}

export function taskProgressPatch(event: ProgressEvent): TaskProgressPatch | null {
  if (event.event !== "task.progress") return null;
  const payload = event.payload || {};
  const task = record(payload.task);
  const rawId = payload.taskId || payload.task_id || task.id;
  if (typeof rawId !== "string" || !rawId.trim()) return null;
  if (task.id !== undefined && task.id !== rawId) return null;
  if (typeof task.status === "string" && !acceptsTaskProgress(task.status)) return null;
  const progress = record(payload.progress);
  const patch: TaskProgressPatch = { taskId: rawId };
  for (const key of ["progress", "downloaded_bytes", "total_bytes"] as const) {
    const value = task[key] ?? progress[key];
    if (typeof value === "number" && Number.isFinite(value)) patch[key] = value;
  }
  for (const [key, legacyKey] of [["speed", "_speed_str"], ["eta", "_eta_str"]] as const) {
    const value = task[key] ?? progress[legacyKey];
    if (typeof value === "string") patch[key] = value;
  }
  return Object.keys(patch).length > 1 ? patch : null;
}

/** One 100ms window for all task IDs; terminal/drop events remain immediate. */
export class TaskProgressRelay {
  private readonly latest = new Map<string, TaskProgressPatch>();
  private handle: unknown;
  private scheduled = false;
  private generation = 0;
  private disposed = false;

  constructor(
    private readonly onFlush: (updates: TaskProgressPatch[]) => void,
    private readonly schedule: (callback: () => void, delayMs: number) => unknown,
    private readonly cancel: (handle: unknown) => void,
    private readonly delayMs = 100,
  ) {}

  enqueue(event: ProgressEvent): void {
    if (this.disposed) return;
    const patch = taskProgressPatch(event);
    if (!patch) return;
    this.latest.set(patch.taskId, { ...this.latest.get(patch.taskId), ...patch });
    if (this.scheduled) return;
    this.scheduled = true;
    const generation = ++this.generation;
    this.handle = this.schedule(() => {
      if (this.disposed || this.generation !== generation) return;
      this.scheduled = false;
      this.handle = undefined;
      this.flush();
    }, this.delayMs);
  }

  drop(taskId: string): void {
    this.latest.delete(taskId);
    if (this.latest.size === 0) this.cancelPending();
  }

  flush(): void {
    this.cancelPending();
    if (this.disposed || this.latest.size === 0) return;
    const updates = [...this.latest.values()];
    this.latest.clear();
    this.onFlush(updates);
  }

  clear(): void {
    this.cancelPending();
    this.latest.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
  }

  private cancelPending(): void {
    this.generation += 1;
    if (this.scheduled) this.cancel(this.handle);
    this.scheduled = false;
    this.handle = undefined;
  }
}
