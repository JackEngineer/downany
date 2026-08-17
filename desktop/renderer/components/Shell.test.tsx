import "@testing-library/jest-dom/vitest";

import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppRoute, DesktopApi } from "../../electron/preload";
import { useAppStore } from "../store/appStore";
import { Shell } from "./Shell";

afterEach(cleanup);

let navigate: ((route: AppRoute) => void) | undefined;

beforeEach(() => {
  navigate = undefined;
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
    openSettings: vi.fn().mockResolvedValue(undefined),
    readClipboardText: vi.fn().mockResolvedValue(""),
    onNavigate: vi.fn((handler: (route: AppRoute) => void) => {
      navigate = handler;
      return () => undefined;
    }),
    onHighlightTask: vi.fn(() => () => undefined),
    onExternalEnqueue: vi.fn(() => () => undefined),
    onEvent: vi.fn(() => () => undefined),
  } satisfies Partial<DesktopApi>) as DesktopApi;
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
});
