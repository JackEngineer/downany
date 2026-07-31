import { beforeEach, describe, expect, it } from "vitest";

import { activeTaskCount, useAppStore } from "./appStore";
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

  it("clearNetSearch resets state", () => {
    useAppStore.getState().startNetSearch("s-1");
    useAppStore.getState().clearNetSearch();
    const state = useAppStore.getState();
    expect(state.netSearchId).toBe("");
    expect(state.netSearching).toBe(false);
  });
});
