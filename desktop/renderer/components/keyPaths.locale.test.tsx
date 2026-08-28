import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DesktopApi } from "../../electron/preload";
import { setLocale } from "../i18n";
import type { ProtocolEvent } from "../lib/types";
import { useAppStore } from "../store/appStore";
import { settingsFixture } from "../test/settingsFixture";
import { taskFixture } from "../test/taskFixture";
import { AddConfirmDialog } from "./AddConfirmDialog";
import { ConnectionGate } from "./ConnectionGate";
import { PlaylistGroupCard } from "./PlaylistGroupCard";
import { QueueOrderControls } from "./QueueOrderControls";
import { ActionBar } from "./shell/ActionBar";
import { MediaTaskBanner } from "./task/MediaTaskBanner";

const request = vi.fn();
let event: (value: ProtocolEvent) => void = () => undefined;
beforeEach(() => {
  localStorage.clear();
  setLocale("en");
  request.mockReset().mockImplementation(async (method) => method === "download.parseUrls" ? { parseId: "parse-1" } : {});
  window.api = {
    platform: "win32", request,
    onEvent: (handler: (value: ProtocolEvent) => void) => { event = handler; return () => undefined; },
    openExtractWindow: vi.fn().mockResolvedValue(undefined),
    openSettings: vi.fn().mockResolvedValue(undefined),
  } as unknown as DesktopApi;
  useAppStore.setState({ tasks: [], settings: settingsFixture(), toasts: [], connection: "connected", pendingAddUrls: null });
});
afterEach(() => { cleanup(); setLocale("zh-CN"); });

describe("English key download paths", () => {
  it("updates task actions and recovery explanations in a mounted row", () => {
    render(<MediaTaskBanner task={taskFixture({ status: "failed", error_code: "network", title: "我的任务" })} />);
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Network settings" })).toBeEnabled();
    expect(screen.getByText("我的任务")).toBeInTheDocument();
    act(() => setLocale("zh-CN"));
    expect(screen.getByRole("button", { name: "检查网络设置" })).toBeEnabled();
  });

  it("keeps the retry confirmation and cancel control in the selected language", () => {
    render(<MediaTaskBanner task={taskFixture({ status: "failed", error_code: "output_verification_failed" })} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    const dialog = screen.getByRole("alertdialog", { name: "Download this item again?" });
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(within(dialog).getByText(/will not overwrite existing files/)).toBeInTheDocument();
  });

  it("translates collection controls and the explicit local-file deletion choice", () => {
    render(<PlaylistGroupCard tasks={[taskFixture({ status: "paused", group_id: "g", group_title: "我的合集" })]} />);
    const actions = document.querySelector(".playlist-group-actions") as HTMLElement;
    expect(within(actions).getByRole("button", { name: "Resume" })).toBeEnabled();
    fireEvent.click(within(actions).getByRole("button", { name: "Delete" }));
    const confirmation = screen.getByRole("group", { name: "Confirm playlist deletion" });
    expect(within(confirmation).getByRole("checkbox", { name: /Also delete downloaded files/ })).not.toBeChecked();
  });

  it("translates queue order descriptions without changing the task title", () => {
    render(<QueueOrderControls unitKey="task:1" label="我的任务" canMoveUp canMoveDown />);
    expect(screen.getByRole("button", { name: "Move 我的任务 up" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Move 我的任务 to the top of this priority" })).toBeEnabled();
  });

  it("translates the download confirmation and retains parsed titles", async () => {
    useAppStore.setState({ pendingAddUrls: ["http://127.0.0.1/video.mp4"] });
    render(<AddConfirmDialog />);
    await waitFor(() => expect(request).toHaveBeenCalledWith("download.parseUrls", expect.any(Object)));
    await act(async () => event({ event: "download.parseResult", payload: {
      parseId: "parse-1", index: 0, url: "http://127.0.0.1/video.mp4", ok: true,
      info: { title: "原始标题", platform: "youtube", formats: [], thumbnail_url: "" },
    } }));
    expect(screen.getByRole("dialog", { name: "Confirm download" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start download" })).toBeEnabled();
    expect(screen.getByRole("checkbox", { name: "Audio only" })).toBeEnabled();
    expect(screen.getByText("原始标题")).toBeInTheDocument();
  });

  it("translates batch actions and connection recovery copy", () => {
    render(<><ActionBar /><ConnectionGate /></>);
    expect(screen.getByRole("menuitem", { name: "Pause all", hidden: true })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Open log folder" })).toBeDisabled();
    expect(document.body.textContent).not.toContain("Sidecar");
  });
});
