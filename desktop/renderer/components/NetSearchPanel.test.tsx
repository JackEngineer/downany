import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NetSearchPanel } from "./NetSearchPanel";
import type { NetSearchItem } from "../lib/types";
import { useAppStore } from "../store/appStore";

const requestMock = vi.fn();

afterEach(() => cleanup());

function item(partial: Partial<NetSearchItem> = {}): NetSearchItem {
  return {
    url: "https://www.youtube.com/watch?v=a",
    title: "lofi mix",
    duration: 61,
    thumbnail_url: "",
    uploader: "someone",
    platform: "youtube",
    ...partial,
  };
}

describe("NetSearchPanel", () => {
  beforeEach(() => {
    requestMock.mockReset();
    requestMock.mockResolvedValue({ taskIds: ["t1"], tasks: [], settings: null });
    (window as unknown as { api: unknown }).api = {
      request: requestMock,
      onEvent: () => () => undefined,
      onState: () => () => undefined,
      getConnectionState: async () => "connected",
    };
    useAppStore.setState({
      searchMode: "network",
      netSearchId: "s-1",
      netSearching: false,
      netResults: [],
      netError: "",
      tasks: [],
      toasts: [],
    });
  });

  it("filter 模式下不渲染", () => {
    useAppStore.setState({ searchMode: "filter" });
    const { container } = render(<NetSearchPanel />);
    expect(container).toBeEmptyDOMElement();
  });

  it("提供常驻平台、关键词和明确搜索动作", () => {
    render(<NetSearchPanel />);

    expect(screen.getByRole("heading", { name: "网络视频" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "搜索平台" })).toHaveValue("youtube");
    expect(screen.getByRole("searchbox", { name: "搜索网络视频" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "搜索" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "返回下载列表" })).toBeInTheDocument();
  });

  it("进入网络搜索后直接聚焦关键词输入框", async () => {
    render(<NetSearchPanel />);

    await waitFor(() => {
      expect(screen.getByRole("searchbox", { name: "搜索网络视频" })).toHaveFocus();
    });
  });

  it("在发请求前登记 searchId，不丢失立即返回的结果", async () => {
    requestMock.mockImplementationOnce(async (method, payload) => {
      expect(method).toBe("search.query");
      const searchId = String((payload as { searchId?: string }).searchId || "");
      expect(searchId).not.toBe("");
      useAppStore.getState().applyEvent({
        event: "search.result",
        payload: {
          searchId,
          ok: true,
          items: [item({ title: "即时结果" })],
        },
      });
      return { searchId };
    });
    useAppStore.setState({ searchQuery: "本地任务", netSearchId: "", netResults: [] });
    render(<NetSearchPanel />);

    fireEvent.change(screen.getByRole("searchbox", { name: "搜索网络视频" }), {
      target: { value: "AI" },
    });
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));

    expect(await screen.findByText("即时结果")).toBeInTheDocument();
    expect(useAppStore.getState().netSearching).toBe(false);
    expect(useAppStore.getState().searchQuery).toBe("本地任务");
  });

  it("渲染搜索结果与时长/上传者元信息", () => {
    useAppStore.setState({ netResults: [item()] });
    render(<NetSearchPanel />);
    expect(screen.getByText("lofi mix")).toBeInTheDocument();
    expect(screen.getByText(/someone · 1:01 · YouTube/)).toBeInTheDocument();
    expect(screen.getByText("1 个结果")).toBeInTheDocument();
  });

  it("搜索中与错误状态的提示", () => {
    useAppStore.setState({ netSearching: true });
    const { rerender } = render(<NetSearchPanel />);
    expect(screen.getByText("正在搜索…")).toBeInTheDocument();

    useAppStore.setState({ netSearching: false, netError: "网络不可达" });
    rerender(<NetSearchPanel />);
    expect(screen.getByText(/网络不可达/)).toBeInTheDocument();
  });

  it("点击下载将结果入队", async () => {
    const target = item();
    useAppStore.setState({ netResults: [target] });
    render(<NetSearchPanel />);
    fireEvent.click(screen.getByRole("button", { name: "下载" }));
    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith(
        "download.createTasks",
        expect.objectContaining({
          urls: [target.url],
          items: [
            {
              url: target.url,
              title: target.title,
              thumbnail_url: target.thumbnail_url,
            },
          ],
        }),
      );
    });
  });

  it("清除结果重置搜索状态", () => {
    useAppStore.setState({ netResults: [item()] });
    render(<NetSearchPanel />);
    fireEvent.click(screen.getByRole("button", { name: "清除结果" }));
    expect(useAppStore.getState().netSearchId).toBe("");
    expect(useAppStore.getState().netResults).toEqual([]);
  });

  it("返回下载列表时退出网络搜索并清理结果", () => {
    useAppStore.setState({ netResults: [item()] });
    render(<NetSearchPanel />);

    fireEvent.click(screen.getByRole("button", { name: "返回下载列表" }));

    expect(useAppStore.getState().searchMode).toBe("filter");
    expect(useAppStore.getState().netResults).toEqual([]);
  });
});
