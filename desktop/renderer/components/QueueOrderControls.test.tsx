import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DesktopApi } from "../../electron/preload";
import { useAppStore } from "../store/appStore";
import { taskFixture } from "../test/taskFixture";
import { QueueOrderControls } from "./QueueOrderControls";
import { ToastHost } from "./ToastHost";

const requestMock = vi.fn();

beforeEach(() => {
  requestMock.mockReset();
  window.api = { platform: "win32", request: requestMock } as unknown as DesktopApi;
  useAppStore.setState({ tasks: [], toasts: [], connection: "connected" });
});
afterEach(cleanup);

describe("QueueOrderControls", () => {
  it("uses shared themed buttons that remain visible on dark media cards", () => {
    render(<QueueOrderControls unitKey="task:only" label="当前任务" canMoveUp canMoveDown />);
    for (const button of screen.getAllByRole("button")) {
      expect(button).toHaveClass("ui-button", "ui-button--ghost");
    }
  });

  it("uses the full current store and hydrates the returned authoritative order", async () => {
    const tasks = [
      taskFixture({ id: "hidden", title: "隐藏任务", queue_order: 0 }),
      taskFixture({ id: "visible", title: "显示任务", queue_order: 1 }),
      taskFixture({ id: "hidden-after", queue_order: 2 }),
      taskFixture({ id: "done", status: "completed", queue_order: 3 }),
    ];
    const authoritative = [tasks[2], tasks[1], tasks[0], tasks[3]].map((task, order) => ({ ...task, queue_order: order }));
    useAppStore.setState({ tasks, filter: "active", searchMode: "filter", searchQuery: "显示任务" });
    requestMock.mockResolvedValue({ tasks: authoritative, settings: null });
    render(<QueueOrderControls unitKey="task:visible" label="显示任务" canMoveUp canMoveDown />);

    fireEvent.click(screen.getByRole("button", { name: "上移显示任务" }));

    await waitFor(() => expect(useAppStore.getState().tasks).toEqual(authoritative));
    expect(requestMock.mock.calls).toEqual([
      ["download.reorder", { orderedIds: ["visible", "hidden", "hidden-after"] }],
    ]);
  });

  it("keeps keyboard-accessible controls disabled at the priority boundary", () => {
    render(<QueueOrderControls unitKey="task:only" label="当前任务" canMoveUp={false} canMoveDown={false} />);
    expect(screen.getByRole("button", { name: "上移当前任务" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "下移当前任务" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "将当前任务移到同优先级顶部" })).toBeDisabled();
  });

  it("applies only order fields after completion, removal and progress events overtake the response", async () => {
    const tasks = [
      taskFixture({ id: "first", status: "downloading", queue_order: 0 }),
      taskFixture({ id: "second", status: "downloading", queue_order: 1 }),
      taskFixture({ id: "removed", queue_order: 2 }),
    ];
    const stale = [tasks[1], tasks[0], tasks[2]].map((task, queue_order) => ({ ...task, queue_order }));
    let finish: (result: unknown) => void = () => undefined;
    requestMock.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    useAppStore.setState({ tasks });
    render(<QueueOrderControls unitKey="task:second" label="第二项" canMoveUp canMoveDown />);

    fireEvent.click(screen.getByRole("button", { name: "上移第二项" }));
    const completed = { ...tasks[0], status: "completed", progress: 100, file_path: "C:\\Downloads\\first.mp4" };
    const added = taskFixture({ id: "added", queue_order: 3 });
    await act(async () => {
      useAppStore.getState().applyEvent({ event: "task.completed", payload: { task: completed } });
      useAppStore.getState().applyEvent({ event: "task.removed", payload: { taskId: "removed" } });
      useAppStore.getState().applyTaskProgressBatch([{ taskId: "second", progress: 70 }]);
      useAppStore.getState().applyEvent({ event: "task.created", payload: { task: added } });
      finish({ tasks: stale, settings: null });
    });

    expect(useAppStore.getState().tasks).toEqual([
      { ...tasks[1], queue_order: 0, progress: 70 },
      { ...completed, queue_order: 1 },
      added,
    ]);
    expect(screen.getByRole("button", { name: "上移第二项" })).toBeEnabled();
  });

  it("leaves the store unchanged and reports failure when reorder is rejected", async () => {
    const tasks = [taskFixture({ id: "first" }), taskFixture({ id: "last", queue_order: 1 })];
    useAppStore.setState({ tasks });
    requestMock.mockRejectedValue(new Error("队列已变化，请刷新后重试"));
    render(<><QueueOrderControls unitKey="task:last" label="最后任务" canMoveUp canMoveDown={false} /><ToastHost /></>);
    fireEvent.click(screen.getByRole("button", { name: "上移最后任务" }));
    expect(await screen.findByText("调整顺序失败")).toBeInTheDocument();
    expect(useAppStore.getState().tasks).toEqual(tasks);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });
});
