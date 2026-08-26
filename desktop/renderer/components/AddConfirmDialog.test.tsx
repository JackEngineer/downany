import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppSettings, ProtocolEvent } from "../lib/types";
import { useAppStore } from "../store/appStore";
import { AddConfirmDialog } from "./AddConfirmDialog";

const requestMock = vi.fn();
const onEventMock = vi.fn();
let eventHandler: ((event: ProtocolEvent) => void) | undefined;

const settings: AppSettings = {
  download_dir: "D:/Downloads",
  concurrent_downloads: 2,
  speed_limit: 0,
  proxy_enabled: false,
  proxy_url: "",
  default_quality: "best",
  download_subtitles: false,
  theme_mode: "system",
  auto_start_downloads: true,
};

function parseInfo(title: string) {
  return {
    title,
    duration: 60,
    thumbnail_url: "",
    uploader: "上传者",
    platform: "bilibili",
    file_size: 1024,
    formats: [],
  };
}

async function emitParseResult(event: ProtocolEvent): Promise<void> {
  await waitFor(() => expect(onEventMock).toHaveBeenCalledTimes(2));
  expect(eventHandler).toBeDefined();
  await act(async () => {
    eventHandler?.(event);
  });
}

describe("AddConfirmDialog playlist selection", () => {
  beforeEach(() => {
    eventHandler = undefined;
    requestMock.mockReset();
    requestMock.mockImplementation(async (method: string) => {
      if (method === "download.parseUrls") return { parseId: "parse-1" };
      if (method === "download.createTasks") {
        return { taskIds: ["task-1", "task-3"] };
      }
      if (method === "app.getSnapshot") return { tasks: [], settings };
      return { ok: true };
    });
    onEventMock.mockReset();
    onEventMock.mockImplementation(
      (handler: (event: ProtocolEvent) => void) => {
        eventHandler = handler;
        return () => undefined;
      },
    );
    (window as unknown as { api: Record<string, unknown> }).api = {
      request: requestMock,
      onEvent: onEventMock,
    };
    useAppStore.setState({
      pendingAddUrls: null,
      settings,
      tasks: [],
      toasts: [],
    });
  });

  afterEach(() => {
    cleanup();
    useAppStore.setState({ pendingAddUrls: null, toasts: [] });
  });

  it("submits selected playlist entries with one shared group identity", async () => {
    const parentUrl = "https://www.bilibili.com/video/BV1abc";
    useAppStore.setState({ pendingAddUrls: [parentUrl] });
    render(<AddConfirmDialog />);

    await emitParseResult({
      event: "download.parseResult",
      payload: {
        parseId: "parse-1",
        index: 0,
        url: parentUrl,
        ok: true,
        info: parseInfo("三集合集"),
        playlist: { id: "BV1abc", title: "三集合集", count: 3 },
        entries: [1, 2, 3].map((index) => ({
          id: `BV1abc-${index}`,
          title: `第 ${index} 集`,
          url: `${parentUrl}?p=${index}`,
          index,
          available: "1",
        })),
      },
    });

    expect(await screen.findByText("三集合集")).toBeInTheDocument();
    const selectors = screen.getAllByRole("checkbox", { name: "选择此条目" });
    expect(selectors).toHaveLength(3);
    fireEvent.click(selectors[1]);
    fireEvent.click(screen.getByRole("button", { name: "开始下载" }));

    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        "download.createTasks",
        expect.any(Object),
      ),
    );
    const createCall = requestMock.mock.calls.find(
      ([method]) => method === "download.createTasks",
    );
    const payload = createCall?.[1] as {
      urls: string[];
      items: Array<Record<string, unknown>>;
    };
    expect(payload.urls).toEqual([`${parentUrl}?p=1`, `${parentUrl}?p=3`]);
    expect(payload.items).toHaveLength(2);
    expect(payload.items.map((item) => item.playlist_index)).toEqual([1, 3]);
    expect(payload.items.map((item) => item.group_title)).toEqual([
      "三集合集",
      "三集合集",
    ]);
    expect(payload.items[0].group_id).toBeTruthy();
    expect(payload.items[1].group_id).toBe(payload.items[0].group_id);
  });

  it("keeps a one-entry parse as a normal ungrouped confirmation", async () => {
    const parentUrl = "https://www.bilibili.com/video/BV1single";
    useAppStore.setState({ pendingAddUrls: [parentUrl] });
    render(<AddConfirmDialog />);

    await emitParseResult({
      event: "download.parseResult",
      payload: {
        parseId: "parse-1",
        index: 0,
        url: parentUrl,
        ok: true,
        info: parseInfo("单集视频"),
        playlist: { id: "BV1single", title: "单集视频", count: 1 },
        entries: [
          {
            id: "BV1single",
            title: "单集视频",
            url: parentUrl,
            index: 1,
            available: "1",
          },
        ],
      },
    });

    expect(await screen.findByText("单集视频")).toBeInTheDocument();
    expect(screen.queryByText(/已选 \d+\/\d+/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "开始下载" }));

    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        "download.createTasks",
        expect.any(Object),
      ),
    );
    const createCall = requestMock.mock.calls.find(
      ([method]) => method === "download.createTasks",
    );
    const payload = createCall?.[1] as {
      urls: string[];
      items: Array<Record<string, unknown>>;
    };
    expect(payload.urls).toEqual([parentUrl]);
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]).toMatchObject({
      url: parentUrl,
      title: "单集视频",
    });
    expect(payload.items[0].group_id).toBeUndefined();
    expect(payload.items[0].group_title).toBeUndefined();
    expect(payload.items[0].playlist_index).toBeUndefined();
  });
});
