import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { activeTaskCount, applyProgressBatch, useAppStore } from "./appStore";
import type { AppSnapshot, TaskSnapshot } from "../lib/types";

function task(partial: Partial<TaskSnapshot> & { id: string }): TaskSnapshot {
  return {
    url: "https://example.com",
    title: "t",
    platform: "youtube",
    status: "pending",
    progress: 0,
    downloaded_bytes: 0,
    total_bytes: 0,
    speed: "0 B/s",
    eta: "暂无",
    file_path: "",
    error_message: "",
    created_at: "2026-01-01T00:00:00Z",
    started_at: null,
    completed_at: null,
    ...partial,
  };
}

describe("appStore", () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    useAppStore.setState({
      connection: "connecting",
      filter: "all",
      searchQuery: "",
      addFocusSignal: 0,
      tasks: [],
      settings: null,
      logDir: "",
      toasts: [],
    });
  });

  it("hydrates snapshot", () => {
    const snap: AppSnapshot = {
      tasks: [task({ id: "1", title: "A" })],
      settings: {
        download_dir: "/tmp",
        concurrent_downloads: 3,
        speed_limit: 0,
        proxy_enabled: false,
        proxy_url: "",
        default_quality: "best",
        download_subtitles: false,
        theme_mode: "system",
      },
    };
    useAppStore.getState().hydrateSnapshot(snap);
    expect(useAppStore.getState().tasks).toHaveLength(1);
    expect(useAppStore.getState().settings?.concurrent_downloads).toBe(3);
  });

  it("applies 100 progress patches to 1000 tasks with one scan and one notification", () => {
    const tasks = Array.from({ length: 1000 }, (_, index) => task({
      id: String(index), status: index === 99 ? "completed" : "downloading",
      progress: index === 99 ? 100 : 0,
    }));
    const map = vi.spyOn(tasks, "map");
    const findIndex = vi.spyOn(tasks, "findIndex");
    useAppStore.setState({ tasks });
    const listener = vi.fn();
    const unsubscribe = useAppStore.subscribe(listener);
    try {
      useAppStore.getState().applyEvent({ event: "task.progressBatch", payload: { updates: [
        ...Array.from({ length: 100 }, (_, index) => ({
          taskId: String(index), progress: 50, downloaded_bytes: 50, total_bytes: 100, speed: "1 B/s", eta: "50s",
        })),
        { taskId: "missing", progress: 20 },
      ] } });
      const result = useAppStore.getState().tasks;
      expect(map).toHaveBeenCalledTimes(1);
      expect(findIndex).not.toHaveBeenCalled();
      expect(listener).toHaveBeenCalledTimes(1);
      expect(result).toHaveLength(1000);
      expect(result[0]).toMatchObject({ progress: 50, downloaded_bytes: 50, speed: "1 B/s", eta: "50s" });
      expect(result[98].progress).toBe(50);
      expect(result[99]).toBe(tasks[99]);
      expect(result[100]).toBe(tasks[100]);
    } finally {
      unsubscribe();
    }
  });

  it("pure progress batches preserve terminal objects, identity and order", () => {
    const tasks = ["pending", "downloading", "paused", "completed", "failed", "cancelled"].map((status) =>
      task({ id: status, status, progress: 80 }));
    const updates = tasks.map(({ id }) => ({ taskId: id, progress: 90 }));
    const result = applyProgressBatch(tasks, updates);
    expect(result.map((item) => item.id)).toEqual(tasks.map((item) => item.id));
    expect(result.map((item) => item.progress)).toEqual([90, 90, 90, 80, 80, 80]);
    for (const index of [3, 4, 5]) expect(result[index]).toBe(tasks[index]);
    expect(tasks.every((item) => item.progress === 80)).toBe(true);
  });

  it("supports single progress events but never resurrects or regresses terminal tasks", () => {
    useAppStore.setState({ tasks: [task({ id: "active", status: "downloading" }),
      task({ id: "done", status: "completed", progress: 100 })] });
    useAppStore.getState().applyEvent({ event: "task.progress", payload: {
      taskId: "active", progress: { progress: 30, downloaded_bytes: 3, total_bytes: 10, _speed_str: "1 B/s" },
    } });
    for (const id of ["done", "removed"]) {
      useAppStore.getState().applyEvent({ event: "task.progress", payload: {
        taskId: id, task: task({ id, status: "downloading", progress: 99 }),
      } });
    }
    expect(useAppStore.getState().tasks).toHaveLength(2);
    expect(useAppStore.getState().tasks[0]).toMatchObject({ progress: 30, downloaded_bytes: 3, total_bytes: 10, speed: "1 B/s" });
    expect(useAppStore.getState().tasks[1]).toMatchObject({ status: "completed", progress: 100 });
  });

  it("updates task from event payload", () => {
    useAppStore.getState().hydrateSnapshot({
      tasks: [task({ id: "1", status: "downloading", progress: 10 })],
      settings: {
        download_dir: "/tmp",
        concurrent_downloads: 3,
        speed_limit: 0,
        proxy_enabled: false,
        proxy_url: "",
        default_quality: "best",
        download_subtitles: false,
        theme_mode: "system",
      },
    });
    useAppStore.getState().applyEvent({
      event: "task.completed",
      payload: {
        taskId: "1",
        task: task({ id: "1", status: "completed", progress: 100 }),
      },
    });
    expect(useAppStore.getState().tasks[0].status).toBe("completed");
    expect(useAppStore.getState().tasks[0].progress).toBe(100);
  });

  it("removes task on task.removed", () => {
    useAppStore.setState({ tasks: [task({ id: "1" }), task({ id: "2" })] });
    useAppStore.getState().applyEvent({
      event: "task.removed",
      payload: { taskId: "1" },
    });
    expect(useAppStore.getState().tasks.map((t) => t.id)).toEqual(["2"]);
  });

  it("counts active tasks", () => {
    expect(
      activeTaskCount([
        task({ id: "1", status: "downloading" }),
        task({ id: "2", status: "pending" }),
        task({ id: "3", status: "completed" }),
      ]),
    ).toBe(2);
  });

  it("tracks network search lifecycle", () => {
    const store = useAppStore.getState();
    store.startNetSearch("s-1");
    expect(useAppStore.getState().netSearching).toBe(true);
    expect(useAppStore.getState().netResults).toEqual([]);

    useAppStore.getState().applyEvent({
      event: "search.result",
      payload: {
        searchId: "s-1",
        ok: true,
        items: [
          {
            url: "https://www.youtube.com/watch?v=a",
            title: "A",
            duration: 10,
            thumbnail_url: "",
            uploader: "u",
            platform: "youtube",
          },
        ],
      },
    });
    const state = useAppStore.getState();
    expect(state.netSearching).toBe(false);
    expect(state.netResults).toHaveLength(1);
    expect(state.netError).toBe("");
  });

  it("ignores stale search results", () => {
    useAppStore.getState().startNetSearch("s-new");
    useAppStore.getState().applyEvent({
      event: "search.result",
      payload: { searchId: "s-old", ok: true, items: [{ url: "x" }] },
    });
    expect(useAppStore.getState().netSearching).toBe(true);
    expect(useAppStore.getState().netResults).toEqual([]);
  });

  it("surfaces search errors", () => {
    useAppStore.getState().startNetSearch("s-err");
    useAppStore.getState().applyEvent({
      event: "search.result",
      payload: { searchId: "s-err", ok: false, error: "网络不可达" },
    });
    const state = useAppStore.getState();
    expect(state.netSearching).toBe(false);
    expect(state.netError).toBe("网络不可达");
    expect(state.netResults).toEqual([]);
  });

  it("only applies a request failure to the matching network search", () => {
    useAppStore.getState().startNetSearch("s-new");

    useAppStore.getState().failNetSearch("s-old", "旧请求失败");
    expect(useAppStore.getState().netSearching).toBe(true);
    expect(useAppStore.getState().netError).toBe("");

    useAppStore.getState().failNetSearch("s-new", "网络不可达");
    expect(useAppStore.getState().netSearching).toBe(false);
    expect(useAppStore.getState().netError).toBe("网络不可达");
  });

  it("clearNetSearch resets state", () => {
    useAppStore.getState().startNetSearch("s-1");
    useAppStore.getState().clearNetSearch();
    const state = useAppStore.getState();
    expect(state.netSearchId).toBe("");
    expect(state.netSearching).toBe(false);
  });
});
