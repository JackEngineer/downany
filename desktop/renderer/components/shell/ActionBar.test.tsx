import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DesktopApi } from "../../../electron/preload";
import { setLocale } from "../../i18n";
import { useAppStore } from "../../store/appStore";
import { ActionBar } from "./ActionBar";

const submitAddTextMock = vi.fn();
const requestMock = vi.fn();
const openExtractWindowMock = vi.fn();
const openSettingsMock = vi.fn();

vi.mock("../../lib/addFlow", () => ({
  submitAddText: (...args: unknown[]) => submitAddTextMock(...args),
}));

vi.mock("../../lib/api", () => ({
  request: (...args: unknown[]) => requestMock(...args),
  openExtractWindow: (...args: unknown[]) => openExtractWindowMock(...args),
}));

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  requestMock.mockResolvedValue({ tasks: [], settings: null });
  openExtractWindowMock.mockResolvedValue(undefined);
  openSettingsMock.mockResolvedValue(undefined);
  useAppStore.setState({
    connection: "connected",
    searchMode: "filter",
    searchQuery: "",
    toasts: [],
  });
  window.api = ({
    platform: "darwin",
    openSettings: openSettingsMock,
  } satisfies Partial<DesktopApi>) as DesktopApi;
});

describe("ActionBar", () => {
  it("submits the link from the explicit Add action", async () => {
    submitAddTextMock.mockResolvedValue(["https://example.com/video"]);
    render(<ActionBar />);
    fireEvent.change(screen.getByRole("textbox", { name: "添加下载链接" }), {
      target: { value: "https://example.com/video" },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    await waitFor(() =>
      expect(submitAddTextMock).toHaveBeenCalledWith("https://example.com/video"),
    );
  });

  it("opens and closes the search popover with focus restoration", () => {
    render(<ActionBar />);
    const trigger = screen.getByRole("button", { name: "搜索" });
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "搜索任务" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("dialog", { name: "搜索任务" }), {
      key: "Escape",
    });
    expect(
      screen.queryByRole("dialog", { name: "搜索任务" }),
    ).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("closes the search popover on outside pointerdown without closing for internal clicks", () => {
    render(<ActionBar />);
    const trigger = screen.getByRole("button", { name: "搜索" });
    fireEvent.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "搜索任务" });
    fireEvent.pointerDown(dialog);
    expect(screen.getByRole("dialog", { name: "搜索任务" })).toBeInTheDocument();

    fireEvent.pointerDown(document.body);
    expect(
      screen.queryByRole("dialog", { name: "搜索任务" }),
    ).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("closes the search popover when focus leaves it but stays open for internal focus moves", () => {
    render(<ActionBar />);
    const trigger = screen.getByRole("button", { name: "搜索" });
    fireEvent.click(trigger);

    const searchbox = screen.getByRole("searchbox", { name: "搜索任务" });
    const closeButton = screen.getByRole("button", { name: "关闭搜索" });
    const settingsButton = screen.getByRole("button", { name: "设置" });

    fireEvent.blur(searchbox, { relatedTarget: closeButton });
    expect(screen.getByRole("dialog", { name: "搜索任务" })).toBeInTheDocument();

    fireEvent.blur(searchbox, { relatedTarget: settingsButton });
    expect(
      screen.queryByRole("dialog", { name: "搜索任务" }),
    ).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("uses english locale strings in the search popover", () => {
    setLocale("en");
    render(<ActionBar />);

    const trigger = screen.getByRole("button", { name: "Search" });
    fireEvent.click(trigger);

    expect(screen.getByRole("dialog", { name: "Search tasks" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Search modes" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Web" }));
    expect(
      screen.getByRole("combobox", { name: "Search platform" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("searchbox", { name: "Search tasks" }),
    ).toHaveAttribute("placeholder", "Search online videos");
    expect(screen.getByRole("button", { name: "Close search" })).toBeInTheDocument();
  });

  it("requires a URL before opening webpage recognition", () => {
    render(<ActionBar />);
    fireEvent.click(screen.getByRole("button", { name: "网页识别" }));
    expect(useAppStore.getState().toasts.at(-1)?.title).toBe(
      "请先输入要识别的页面链接",
    );
    expect(openExtractWindowMock).not.toHaveBeenCalled();
  });

  it("opens settings from the dedicated icon action", () => {
    render(<ActionBar />);
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(openSettingsMock).toHaveBeenCalledOnce();
  });
});
