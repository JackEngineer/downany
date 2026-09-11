import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppSettings, AppSnapshot } from "./types";
import { createTasksAndRefresh, submitAddText } from "./addFlow";
import { useAppStore } from "../store/appStore";
import { deferred } from "../test/deferred";
import { taskFixture } from "../test/taskFixture";

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
    requestMock.mockImplementation(async (method) =>
      method === "settings.checkDownloadDir"
        ? { ready: true }
        : { taskIds: ["task-1"] },
    );
    (window as unknown as { api: Record<string, unknown> }).api = {
      request: requestMock,
      openSettings: vi.fn().mockResolvedValue(undefined),
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

  it("opens download settings instead of creating a task when the save location is unavailable", async () => {
    requestMock.mockImplementation(async (method) =>
      method === "settings.checkDownloadDir"
        ? { ready: false, reason: "output_path_invalid" }
        : { taskIds: ["unexpected"] },
    );

    await expect(
      createTasksAndRefresh(["https://example.com/video.mp4"]),
    ).resolves.toBe(false);

    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledWith("settings.checkDownloadDir", {});
    expect(window.api.openSettings).toHaveBeenCalledWith("download");
    expect(useAppStore.getState().toasts).toEqual([
      expect.objectContaining({
        kind: "error",
        title: "下载位置不可用",
        detail: "请选择可写入的下载目录后再试。",
        sticky: true,
      }),
    ]);
  });

  it("does not roll back a task completed while the post-create refresh was pending", async () => {
    const reply = deferred<AppSnapshot>();
    requestMock
      .mockResolvedValueOnce({ ready: true })
      .mockResolvedValueOnce({ taskIds: ["task-1"] })
      .mockReturnValueOnce(reply.promise);
    const created = createTasksAndRefresh(["https://example.com/video.mp4"]);
    await vi.waitFor(() => expect(requestMock).toHaveBeenCalledWith("app.getSnapshot", {}));
    const done = taskFixture({ status: "completed", progress: 100 });
    useAppStore.getState().applyEvent({ event: "task.completed", payload: { task: done } });
    reply.resolve({ tasks: [taskFixture()], settings });
    await created;
    expect(useAppStore.getState().tasks).toEqual([done]);
  });

  it("does not report successful creation as failed or create again when refresh fails", async () => {
    requestMock
      .mockResolvedValueOnce({ ready: true })
      .mockResolvedValueOnce({ taskIds: ["task-1"] })
      .mockRejectedValueOnce(new Error("snapshot offline"));
    await submitAddText("https://example.com/video.mp4");
    expect(requestMock.mock.calls.filter(([method]) => method === "download.createTasks")).toHaveLength(1);
    expect(useAppStore.getState().toasts.map(({ kind }) => kind)).toEqual(["success", "info"]);
    expect(useAppStore.getState().toasts.map(({ title }) => title)).not.toContain("添加失败");
  });

  it("keeps raw exceptions out of creation errors", async () => {
    requestMock.mockRejectedValue(new Error("Cookie: fake-secret https://example.com/private C:\\private\\data"));
    await submitAddText("https://example.com/video.mp4");
    expect(useAppStore.getState().toasts.some(({ kind }) => kind === "error")).toBe(true);
    expect(JSON.stringify(useAppStore.getState().toasts)).not.toMatch(/fake-secret|example.com\/private|private\\\\data/);
  });
});
