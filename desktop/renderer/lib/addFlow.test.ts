import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppSettings } from "./types";
import { submitAddText } from "./addFlow";
import { useAppStore } from "../store/appStore";

const requestMock = vi.fn();

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

describe("submitAddText playlist candidates", () => {
  beforeEach(() => {
    requestMock.mockReset();
    requestMock.mockResolvedValue({ taskIds: ["task-1"] });
    (window as unknown as { api: Record<string, unknown> }).api = {
      request: requestMock,
    };
    useAppStore.setState({
      pendingAddUrls: null,
      settings,
      tasks: [],
      toasts: [],
    });
  });

  afterEach(() => {
    useAppStore.setState({ pendingAddUrls: null, toasts: [] });
  });

  it("opens confirmation for a bare Bilibili video even with auto-start enabled", async () => {
    const url = "https://www.bilibili.com/video/BV1abc";

    await expect(submitAddText(url)).resolves.toEqual([url]);

    expect(useAppStore.getState().pendingAddUrls).toEqual([url]);
    expect(requestMock).not.toHaveBeenCalled();
  });
});
