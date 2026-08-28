import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DesktopApi } from "../../../electron/preload";
import type { AppSnapshot } from "../../lib/types";
import { useAppStore } from "../../store/appStore";
import { deferred } from "../../test/deferred";
import { settingsFixture } from "../../test/settingsFixture";
import { taskFixture } from "../../test/taskFixture";
import { useTaskCommands } from "./useTaskCommands";

const settings = settingsFixture();
const request = vi.fn();
beforeEach(() => {
  request.mockReset();
  window.api = { request } as unknown as DesktopApi;
  useAppStore.setState({ tasks: [taskFixture()], settings, toasts: [] });
});
afterEach(cleanup);

describe("single-task commands", () => {
  it("keeps diagnostics exported when opening the folder alone fails", async () => {
    request.mockResolvedValue({ ok: true, path: "C:\\isolated\\diagnostics.zip" });
    window.api.showItemInFolder = vi.fn().mockRejectedValue(new Error("Cookie: fake-secret"));
    const { result } = renderHook(() => useTaskCommands(taskFixture()));
    await act(async () => { await result.current.exportDiagnostics(); });
    expect(useAppStore.getState().toasts.map(({ kind }) => kind)).toEqual(["success", "info"]);
    expect(JSON.stringify(useAppStore.getState().toasts)).not.toContain("fake-secret");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(["open", "reveal", "recognizePage", "openSettings"] as const)("handles a rejected %s without leaking the error", async (command) => {
    const failure = new Error("Cookie: fake-secret https://example.com/private C:\\private\\data");
    window.api.openPath = vi.fn().mockRejectedValue(failure);
    window.api.showItemInFolder = vi.fn().mockRejectedValue(failure);
    window.api.openExtractWindow = vi.fn().mockRejectedValue(failure);
    window.api.openSettings = vi.fn().mockRejectedValue(failure);
    const { result } = renderHook(() => useTaskCommands(taskFixture({ file_path: "C:\\test.mp4" })));
    await act(async () => { await expect(result.current[command]()).resolves.toBeUndefined(); });
    expect(useAppStore.getState().toasts.map(({ kind }) => kind)).toEqual(["error"]);
    expect(JSON.stringify(useAppStore.getState().toasts)).not.toContain("fake-secret");
  });

  it("treats an openPath error string as a failure, not a successful open", async () => {
    window.api.openPath = vi.fn().mockResolvedValue("File unavailable: C:\\private\\secret.mp4");
    const { result } = renderHook(() => useTaskCommands(taskFixture({ file_path: "C:\\test.mp4" })));
    await act(async () => { await result.current.open(); });
    expect(useAppStore.getState().toasts.map(({ kind }) => kind)).toEqual(["error"]);
    expect(JSON.stringify(useAppStore.getState().toasts)).not.toContain("secret.mp4");
  });

  it.each(["command", "update"])("keeps removal during the %s refresh", async (operation) => {
    const reply = deferred<AppSnapshot>();
    request.mockResolvedValueOnce({}).mockReturnValueOnce(reply.promise);
    const { result } = renderHook(() => useTaskCommands(taskFixture()));
    let finished: Promise<void> = Promise.resolve();
    await act(async () => {
      finished = operation === "command" ? result.current.run("download.pause") : result.current.update({ priority: 1 });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(request).toHaveBeenCalledWith("app.getSnapshot", {});
    act(() => useAppStore.getState().applyEvent({ event: "task.removed", payload: { taskId: "task-1" } }));
    await act(async () => { reply.resolve({ tasks: [taskFixture()], settings }); await finished; });
    expect(useAppStore.getState().tasks).toEqual([]);
  });

  it.each(["command", "update"])("does not misreport a successful %s when only refresh fails", async (operation) => {
    request.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("snapshot offline"));
    const { result } = renderHook(() => useTaskCommands(taskFixture()));
    await act(async () => {
      if (operation === "command") await result.current.run("download.pause");
      else await result.current.update({ priority: 1 });
    });
    expect(useAppStore.getState().toasts.map(({ kind }) => kind)).toEqual(["info"]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each(["command", "update"])("does not show private details on a rejected %s", async (operation) => {
    request.mockRejectedValue(new Error("Cookie: fake-secret https://example.com/private C:\\private\\data"));
    const { result } = renderHook(() => useTaskCommands(taskFixture()));
    await act(async () => {
      if (operation === "command") await result.current.run("download.pause");
      else await result.current.update({ priority: 1 });
    });
    expect(useAppStore.getState().toasts.map(({ kind }) => kind)).toEqual(["error"]);
    expect(JSON.stringify(useAppStore.getState().toasts)).not.toContain("fake-secret");
  });
});
