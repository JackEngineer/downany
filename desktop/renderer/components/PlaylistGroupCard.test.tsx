import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DesktopApi } from "../../electron/preload";
import { useAppStore } from "../store/appStore";
import { taskFixture } from "../test/taskFixture";
import { PlaylistGroupCard } from "./PlaylistGroupCard";
import { ToastHost } from "./ToastHost";

const requestMock = vi.fn();

function QueueGroup() {
  const tasks = useAppStore((state) => state.tasks);
  return <><ul><PlaylistGroupCard tasks={tasks} /></ul><ToastHost /></>;
}

function groupTask(id: string, status: string) {
  return taskFixture({ id, title: id, status, group_id: "playlist", group_title: "测试合集" });
}

function groupButton(name: string) {
  const group = document.querySelector<HTMLElement>(".playlist-group-actions")!;
  return within(group).getByRole("button", { name });
}

beforeEach(() => {
  requestMock.mockReset();
  useAppStore.setState({ tasks: [], toasts: [], connection: "connected" });
  window.api = { platform: "win32", request: requestMock } as unknown as DesktopApi;
});

afterEach(cleanup);

describe("PlaylistGroupCard atomic actions", () => {
  it("reports the applied action even if the following refresh fails", async () => {
    useAppStore.setState({ tasks: [groupTask("first", "pending")] });
    requestMock.mockResolvedValueOnce({ action: "pause", applied: [{ taskId: "first", status: "paused" }], deferred: [], skipped: [] })
      .mockRejectedValueOnce(new Error("Cookie: fake-secret"));
    render(<QueueGroup />);
    fireEvent.click(groupButton("暂停"));
    await waitFor(() => expect(useAppStore.getState().toasts).toHaveLength(2));
    expect(useAppStore.getState().toasts.map(({ kind }) => kind).sort()).toEqual(["info", "success"]);
    expect(screen.getByText("已暂停 1 项")).toBeInTheDocument();
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain("fake-secret");
  });

  it("closes the removal confirmation after removal succeeds but refresh fails", async () => {
    useAppStore.setState({ tasks: [groupTask("first", "pending")] });
    requestMock.mockResolvedValueOnce({ removed: ["first"], fileDeleteFailures: [] })
      .mockRejectedValueOnce(new Error("snapshot unavailable"));
    render(<QueueGroup />);
    fireEvent.click(groupButton("删除"));
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(useAppStore.getState().toasts).toHaveLength(2));
    expect(useAppStore.getState().toasts.map(({ kind }) => kind).sort()).toEqual(["info", "success"]);
    expect(screen.queryByRole("button", { name: "确认删除" })).not.toBeInTheDocument();
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it("pauses waiting members with one request and one authoritative refresh", async () => {
    const tasks = [groupTask("first", "pending"), groupTask("second", "pending"), groupTask("done", "completed")];
    const refreshed = tasks.map((task) => task.status === "pending" ? { ...task, status: "paused" } : task);
    useAppStore.setState({ tasks });
    requestMock.mockImplementation(async (method) => method === "app.getSnapshot"
      ? { tasks: refreshed, settings: null }
      : {
        action: "pause",
        applied: [{ taskId: "first", status: "paused" }, { taskId: "second", status: "paused" }],
        deferred: [],
        skipped: [{ taskId: "done", status: "completed", reason: "incompatible_status" }],
      });
    render(<QueueGroup />);

    fireEvent.click(groupButton("暂停"));

    expect(await screen.findByText("已暂停 2 项，1 项未更改")).toBeInTheDocument();
    expect(requestMock.mock.calls).toEqual([
      ["download.applyGroupAction", { groupId: "playlist", action: "pause" }],
      ["app.getSnapshot", {}],
    ]);
    expect(useAppStore.getState().tasks).toEqual(refreshed);
    expect(groupButton("恢复")).toBeEnabled();
  });

  it.each([
    ["resume", "paused", "恢复", "pending", "已恢复 1 项"],
    ["retry", "failed", "重试", "pending", "已重试 1 项"],
    ["cancel", "pending", "取消", "cancelled", "已取消 1 项"],
  ])("uses one group request for %s", async (action, status, label, nextStatus, title) => {
    const task = groupTask("first", status);
    useAppStore.setState({ tasks: [task] });
    requestMock.mockImplementation(async (method) => method === "app.getSnapshot"
      ? { tasks: [{ ...task, status: nextStatus }], settings: null }
      : { action, applied: [{ taskId: task.id, status: nextStatus }], deferred: [], skipped: [] });
    render(<QueueGroup />);

    fireEvent.click(groupButton(label));

    expect(await screen.findByText(title)).toBeInTheDocument();
    expect(requestMock.mock.calls).toEqual([
      ["download.applyGroupAction", { groupId: "playlist", action }],
      ["app.getSnapshot", {}],
    ]);
  });

  it("shows a failed group request without a success toast or a false refresh", async () => {
    useAppStore.setState({ tasks: [groupTask("first", "downloading")] });
    requestMock.mockRejectedValue(new Error("无法保存任务更改，请重试"));
    render(<QueueGroup />);

    fireEvent.click(groupButton("暂停"));

    expect(await screen.findByText("合集操作失败")).toBeInTheDocument();
    expect(useAppStore.getState().toasts).toHaveLength(1);
    expect(useAppStore.getState().toasts[0].kind).toBe("error");
    expect(useAppStore.getState().tasks[0].status).toBe("downloading");
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it("does not restore a running group member after a newer completion or removal event", async () => {
    const tasks = [groupTask("first", "paused"), groupTask("second", "paused")];
    const stale = tasks.map((task) => ({ ...task, status: "downloading", progress: 20 }));
    let finish: (result: unknown) => void = () => undefined;
    requestMock.mockImplementation((method) => method === "app.getSnapshot"
      ? new Promise((resolve) => { finish = resolve; })
      : Promise.resolve({ action: "resume", applied: tasks.map((task) => ({ taskId: task.id, status: "pending" })), deferred: [], skipped: [] }));
    useAppStore.setState({ tasks });
    render(<QueueGroup />);
    fireEvent.click(groupButton("恢复"));
    await waitFor(() => expect(requestMock).toHaveBeenCalledWith("app.getSnapshot", {}));

    const completed = { ...tasks[0], status: "completed", progress: 100, file_path: "C:\\Downloads\\first.mp4" };
    await act(async () => {
      useAppStore.getState().applyEvent({ event: "task.completed", payload: { task: completed } });
      useAppStore.getState().applyEvent({ event: "task.removed", payload: { taskId: "second" } });
      finish({ tasks: stale, settings: null });
    });

    expect(await screen.findByText("已恢复 2 项")).toBeInTheDocument();
    expect(useAppStore.getState().tasks).toEqual([completed]);
    expect(screen.getByText("1/1 完成 · 100%")).toBeInTheDocument();
  });

  it("does not describe a draining retry as already restarted", async () => {
    useAppStore.setState({ tasks: [groupTask("first", "cancelled")] });
    requestMock.mockImplementation(async (method) => method === "app.getSnapshot"
      ? { tasks: [groupTask("first", "paused")], settings: null }
      : { action: "retry", applied: [], deferred: [{ taskId: "first", status: "paused" }], skipped: [] });
    render(<QueueGroup />);

    fireEvent.click(groupButton("重试"));

    expect(await screen.findByText("1 项等待当前下载结束")).toBeInTheDocument();
    expect(screen.queryByText(/已重试/)).not.toBeInTheDocument();
    expect(useAppStore.getState().toasts[0].kind).toBe("info");
  });

  it("disables overlapping group actions until the response arrives", async () => {
    useAppStore.setState({ tasks: [groupTask("first", "downloading")] });
    let finish: (result: unknown) => void = () => undefined;
    requestMock.mockImplementation((method) => method === "app.getSnapshot"
      ? Promise.resolve({ tasks: [groupTask("first", "paused")], settings: null })
      : new Promise((resolve) => { finish = resolve; }));
    render(<QueueGroup />);

    fireEvent.click(groupButton("暂停"));
    fireEvent.click(groupButton("暂停"));
    expect(groupButton("暂停")).toBeDisabled();
    expect(groupButton("删除")).toBeDisabled();
    expect(requestMock).toHaveBeenCalledTimes(1);
    await act(async () => finish({
      action: "pause", applied: [{ taskId: "first", status: "paused" }], deferred: [], skipped: [],
    }));
    expect(await screen.findByText("已暂停 1 项")).toBeInTheDocument();
  });

  it("warns when queue removal succeeds but a local file cannot be deleted", async () => {
    const task = { ...groupTask("first", "completed"), file_path: "C:\\Downloads\\first.mp4" };
    useAppStore.setState({ tasks: [task] });
    requestMock.mockImplementation(async (method) => method === "app.getSnapshot"
      ? { tasks: [], settings: null }
      : { removed: [task.id], fileDeleteFailures: [{ taskId: task.id, message: "本地文件未删除" }] });
    render(<QueueGroup />);

    fireEvent.click(groupButton("删除"));
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));

    expect(await screen.findByText("已移除 1 项，1 个本地文件未删除")).toBeInTheDocument();
    expect(useAppStore.getState().toasts[0].kind).toBe("warning");
    expect(screen.queryByText(/含本地文件/)).not.toBeInTheDocument();
    expect(requestMock.mock.calls).toEqual([
      ["download.removeGroup", { groupId: "playlist", delete_files: true }],
      ["app.getSnapshot", {}],
    ]);
  });

  it("does not remove visible tasks after a queue removal failure", async () => {
    const task = groupTask("first", "pending");
    useAppStore.setState({ tasks: [task] });
    requestMock.mockRejectedValue(new Error("无法保存任务更改，请重试"));
    render(<QueueGroup />);
    fireEvent.click(groupButton("删除"));
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));

    await waitFor(() => expect(useAppStore.getState().toasts[0]?.kind).toBe("error"));
    expect(useAppStore.getState().tasks).toEqual([task]);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });
});
