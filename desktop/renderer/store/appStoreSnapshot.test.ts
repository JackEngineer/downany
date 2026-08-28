import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppSettings, AppSnapshot } from "../lib/types";
import { taskFixture } from "../test/taskFixture";
import { useAppStore } from "./appStore";

const settings: AppSettings = {
  download_dir: "C:\\Downloads", concurrent_downloads: 3, speed_limit: 0,
  proxy_enabled: false, proxy_url: "", default_quality: "best",
  download_subtitles: false, theme_mode: "system",
};

function deferredSnapshot() {
  let resolve: (snapshot: AppSnapshot) => void = () => undefined;
  const promise = new Promise<AppSnapshot>((finish) => { resolve = finish; });
  return { promise, resolve };
}

beforeEach(() => {
  useAppStore.setState({ tasks: [], settings, toasts: [] });
});

describe("request-scoped snapshot reconciliation", () => {
  it("invalidates pending requests without clearing tasks or preventing the next refresh", async () => {
    const known = taskFixture({ id: "known" });
    useAppStore.setState({ tasks: [known] });
    const pending = deferredSnapshot();
    const refresh = useAppStore.getState().refreshSnapshot(() => pending.promise);
    useAppStore.getState().invalidateSnapshotRequests();
    pending.resolve({ tasks: [], settings });
    await refresh;
    expect(useAppStore.getState().tasks).toEqual([known]);
    await useAppStore.getState().refreshSnapshot(async () => ({ tasks: [], settings }));
    expect(useAppStore.getState().tasks).toEqual([]);
  });

  it("accepts authoritative additions, removals and settings if no event overtakes the response", async () => {
    useAppStore.setState({ tasks: [taskFixture({ id: "old" })] });
    const snapshot = { tasks: [taskFixture({ id: "new" })], settings: { ...settings, concurrent_downloads: 5 } };
    await useAppStore.getState().refreshSnapshot(async () => snapshot);
    expect(useAppStore.getState().tasks).toEqual(snapshot.tasks);
    expect(useAppStore.getState().settings).toEqual(snapshot.settings);
  });

  it("retains completion, removal and additions received while a snapshot is pending", async () => {
    const original = [taskFixture({ id: "done", status: "downloading" }), taskFixture({ id: "removed" })];
    useAppStore.setState({ tasks: original });
    const pending = deferredSnapshot();
    const refresh = useAppStore.getState().refreshSnapshot(() => pending.promise);
    const completed = { ...original[0], status: "completed", progress: 100, file_path: "C:\\Downloads\\done.mp4" };
    const added = taskFixture({ id: "added" });
    useAppStore.getState().applyEvent({ event: "task.completed", payload: { task: completed } });
    useAppStore.getState().applyEvent({ event: "task.removed", payload: { taskId: "removed" } });
    useAppStore.getState().applyEvent({ event: "task.created", payload: { task: added } });
    pending.resolve({ tasks: original, settings });
    await refresh;
    expect(useAppStore.getState().tasks).toEqual([completed, added]);
  });

  it("remembers removed IDs even if they were absent when the request started", async () => {
    const pending = deferredSnapshot();
    const refresh = useAppStore.getState().refreshSnapshot(() => pending.promise);
    const ephemeral = taskFixture({ id: "ephemeral" });
    useAppStore.getState().applyEvent({ event: "task.created", payload: { task: ephemeral } });
    useAppStore.getState().applyEvent({ event: "task.removed", payload: { taskId: ephemeral.id } });
    useAppStore.getState().applyEvent({ event: "task.removed", payload: { taskId: "unseen" } });
    pending.resolve({ tasks: [ephemeral, taskFixture({ id: "unseen" })], settings });
    await refresh;
    expect(useAppStore.getState().tasks).toEqual([]);
  });

  it("merges only progress fields and never replaces a terminal snapshot with a progress patch", async () => {
    const tasks = [taskFixture({ id: "running", status: "downloading" }), taskFixture({ id: "done", status: "downloading" })];
    useAppStore.setState({ tasks });
    const pending = deferredSnapshot();
    const refresh = useAppStore.getState().refreshSnapshot(() => pending.promise);
    useAppStore.getState().applyTaskProgressBatch([{ taskId: "running", progress: 70, speed: "2 B/s" }, { taskId: "done", progress: 90 }]);
    useAppStore.getState().applyTaskProgressBatch([{ taskId: "running", downloaded_bytes: 7 }]);
    const completed = { ...tasks[1], status: "completed", progress: 100 };
    pending.resolve({ tasks: [{ ...tasks[0], progress: 20, queue_order: 4 }, completed], settings });
    await refresh;
    expect(useAppStore.getState().tasks).toEqual([
      { ...tasks[0], queue_order: 4, progress: 70, downloaded_bytes: 7, speed: "2 B/s" }, completed,
    ]);
  });

  it("preserves settings changed during a refresh", async () => {
    const pending = deferredSnapshot();
    const refresh = useAppStore.getState().refreshSnapshot(() => pending.promise);
    const changed = { ...settings, theme_mode: "dark" as const };
    useAppStore.getState().applyEvent({ event: "settings.changed", payload: { settings: changed } });
    pending.resolve({ tasks: [], settings });
    await refresh;
    expect(useAppStore.getState().settings).toEqual(changed);
  });

  it("keeps an applied reorder when another pending snapshot still contains the old order", async () => {
    const tasks = [taskFixture({ id: "first", queue_order: 0 }), taskFixture({ id: "second", queue_order: 1 })];
    useAppStore.setState({ tasks });
    const pending = deferredSnapshot();
    const refresh = useAppStore.getState().refreshSnapshot(() => pending.promise);
    useAppStore.getState().applyQueueOrder({ tasks: [{ ...tasks[1], queue_order: 0 }, { ...tasks[0], queue_order: 1 }], settings });
    pending.resolve({ tasks, settings });
    await refresh;
    expect(useAppStore.getState().tasks.map(({ id, queue_order }) => ({ id, queue_order }))).toEqual([
      { id: "first", queue_order: 1 }, { id: "second", queue_order: 0 },
    ]);
  });

  it("does not record progress discarded for a terminal task", async () => {
    const completed = taskFixture({ id: "done", status: "completed", progress: 100 });
    useAppStore.setState({ tasks: [completed] });
    const pending = deferredSnapshot();
    const refresh = useAppStore.getState().refreshSnapshot(() => pending.promise);
    useAppStore.getState().applyTaskProgressBatch([{ taskId: "done", progress: 10 }]);
    pending.resolve({ tasks: [completed], settings });
    await refresh;
    expect(useAppStore.getState().tasks[0]).toBe(completed);
  });

  it.each([false, true])("keeps the newer refresh when responses finish in reverse order (%s)", async (reverse) => {
    const first = deferredSnapshot();
    const second = deferredSnapshot();
    const firstRefresh = useAppStore.getState().refreshSnapshot(() => first.promise);
    const secondRefresh = useAppStore.getState().refreshSnapshot(() => second.promise);
    const old = { tasks: [taskFixture({ id: "old" })], settings };
    const latest = { tasks: [taskFixture({ id: "new" })], settings };
    if (reverse) {
      second.resolve(latest);
      await secondRefresh;
      first.resolve(old);
      await firstRefresh;
    } else {
      first.resolve(old);
      await firstRefresh;
      second.resolve(latest);
      await secondRefresh;
    }
    expect(useAppStore.getState().tasks).toEqual(latest.tasks);
  });

  it("does not overwrite a newer direct snapshot or a completed retry after failure", async () => {
    const pending = deferredSnapshot();
    const refresh = useAppStore.getState().refreshSnapshot(() => pending.promise);
    const latest = { tasks: [taskFixture({ id: "latest" })], settings };
    useAppStore.getState().hydrateSnapshot(latest);
    pending.resolve({ tasks: [], settings });
    await refresh;
    expect(useAppStore.getState().tasks).toEqual(latest.tasks);
    await expect(useAppStore.getState().refreshSnapshot(async () => { throw new Error("offline"); })).rejects.toThrow("offline");
    await useAppStore.getState().refreshSnapshot(async () => ({ tasks: [], settings }));
    expect(useAppStore.getState().tasks).toEqual([]);
  });

  it("does not add queue scans or notifications to progress handling while a refresh is pending", async () => {
    const tasks = Array.from({ length: 1000 }, (_, index) => taskFixture({ id: String(index), status: "downloading" }));
    useAppStore.setState({ tasks });
    const pending = deferredSnapshot();
    const refresh = useAppStore.getState().refreshSnapshot(() => pending.promise);
    const map = vi.spyOn(tasks, "map");
    const findIndex = vi.spyOn(tasks, "findIndex");
    const listener = vi.fn();
    const unsubscribe = useAppStore.subscribe(listener);
    try {
      useAppStore.getState().applyTaskProgressBatch(Array.from({ length: 100 }, (_, index) => ({ taskId: String(index), progress: 50 })));
      expect(map).toHaveBeenCalledTimes(1);
      expect(findIndex).not.toHaveBeenCalled();
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
      map.mockRestore();
      findIndex.mockRestore();
      pending.resolve({ tasks, settings });
      await refresh;
    }
    expect(useAppStore.getState().tasks[99].progress).toBe(50);
  });
});
