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

  it("渲染搜索结果与时长/上传者元信息", () => {
    useAppStore.setState({ netResults: [item()] });
    render(<NetSearchPanel />);
    expect(screen.getByText("lofi mix")).toBeInTheDocument();
    expect(screen.getByText(/someone · 1:01 · youtube/)).toBeInTheDocument();
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
});
