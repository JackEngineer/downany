import "@testing-library/jest-dom/vitest";

import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppRoute, DesktopApi, ExternalEnqueuePayload } from "../../electron/preload";
import type { AppSnapshot } from "../lib/types";
import { useAppStore } from "../store/appStore";
import { deferred } from "../test/deferred";
import { settingsFixture } from "../test/settingsFixture";
import { taskFixture } from "../test/taskFixture";
import { Shell } from "./Shell";

afterEach(cleanup);

let navigate: ((route: AppRoute) => void) | undefined;
let enqueue: ((payload: ExternalEnqueuePayload) => void) | undefined;

beforeEach(() => {
  navigate = undefined;
  enqueue = undefined;
  localStorage.clear();
  useAppStore.setState({
    connection: "connected",
    filter: "all",
    searchMode: "network",
    searchQuery: "AI",
    netSearchId: "s-1",
    netSearching: false,
    netResults: [],
    netError: "",
    settings: null,
    tasks: [],
    toasts: [],
  });
  window.api = ({
    platform: "darwin",
    request: vi.fn().mockResolvedValue({}),
    setThemeSource: vi.fn().mockResolvedValue(undefined),
    openSettings: vi.fn().mockResolvedValue(undefined),
    readClipboardText: vi.fn().mockResolvedValue(""),
    onNavigate: vi.fn((handler: (route: AppRoute) => void) => {
      navigate = handler;
      return () => undefined;
    }),
    onHighlightTask: vi.fn(() => () => undefined),
    onExternalEnqueue: vi.fn((handler: (payload: ExternalEnqueuePayload) => void) => {
      enqueue = handler;
      return () => undefined;
    }),
    onEvent: vi.fn(() => () => undefined),
  } satisfies Partial<DesktopApi>) as unknown as DesktopApi;
});

describe("Shell network search workspace", () => {
  it("uses the only main scroll region and hides task filters", () => {
    render(<Shell />);

    const main = screen.getByRole("main");
    expect(within(main).getByRole("region", { name: "网络搜索结果" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "任务筛选" })).not.toBeInTheDocument();
    expect(main).toHaveClass("window-main--search");
  });

  it("returns to the task workspace for native queue navigation", () => {
    render(<Shell />);

    act(() => navigate?.("queue"));

    expect(useAppStore.getState().searchMode).toBe("filter");
    expect(screen.getByRole("group", { name: "任务筛选" })).toBeInTheDocument();
  });

  it("keeps a completed task when browser enqueue refresh returns an older snapshot", async () => {
    const reply = deferred<AppSnapshot>();
    vi.mocked(window.api.request).mockReturnValue(reply.promise);
    render(<Shell />);
    act(() => enqueue?.({ count: 1, urls: ["https://example.com/video.mp4"] }));
    const done = taskFixture({ status: "completed", progress: 100 });
    act(() => useAppStore.getState().applyEvent({ event: "task.completed", payload: { task: done } }));
    await act(async () => { reply.resolve({ tasks: [taskFixture()], settings: settingsFixture() }); });
    expect(useAppStore.getState().tasks).toEqual([done]);
  });

  it("handles browser refresh failure without claiming enqueue failed", async () => {
    vi.mocked(window.api.request).mockRejectedValue(new Error("private snapshot error"));
    render(<Shell />);
    await act(async () => enqueue?.({ count: 1, urls: ["https://example.com/video.mp4"] }));
    expect(useAppStore.getState().toasts.map(({ kind }) => kind)).toEqual(["success", "info"]);
  });

  it("does not expose the raw browser enqueue error", () => {
    render(<Shell />);
    act(() => enqueue?.({ count: 0, urls: [], error: "Cookie: fake-secret" }));
    expect(useAppStore.getState().toasts.map(({ kind }) => kind)).toEqual(["error"]);
    expect(JSON.stringify(useAppStore.getState().toasts)).not.toContain("fake-secret");
  });
});
