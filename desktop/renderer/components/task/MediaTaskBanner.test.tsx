import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAppStore } from "../../store/appStore";
import { taskFixture } from "../../test/taskFixture";
import { MediaTaskBanner } from "./MediaTaskBanner";

const requestMock = vi.fn();
const openPathMock = vi.fn();
const openSettingsMock = vi.fn();
const openExtractWindowMock = vi.fn();
const showItemInFolderMock = vi.fn();
const showTaskContextMenuMock = vi.fn();

vi.mock("../../lib/api", () => ({
  request: (...args: unknown[]) => requestMock(...args),
  openPath: (...args: unknown[]) => openPathMock(...args),
  openSettings: (...args: unknown[]) => openSettingsMock(...args),
  openExtractWindow: (...args: unknown[]) => openExtractWindowMock(...args),
}));

afterEach(cleanup);

beforeEach(() => {
  requestMock.mockReset();
  requestMock.mockResolvedValue({ tasks: [], settings: null });
  openPathMock.mockReset();
  openSettingsMock.mockReset();
  openSettingsMock.mockResolvedValue(undefined);
  openExtractWindowMock.mockReset();
  openExtractWindowMock.mockResolvedValue(undefined);
  showItemInFolderMock.mockReset();
  showItemInFolderMock.mockResolvedValue(undefined);
  showTaskContextMenuMock.mockReset();
  showTaskContextMenuMock.mockResolvedValue(null);
  useAppStore.setState({ tasks: [], settings: null, toasts: [] });
  (window as unknown as { api: Record<string, unknown> }).api = {
    platform: "darwin",
    showItemInFolder: showItemInFolderMock,
    showTaskContextMenu: showTaskContextMenuMock,
  };
});

describe("MediaTaskBanner", () => {
  it("renders artwork, shade, one reading glass and content layers", () => {
    const { container } = render(
      <MediaTaskBanner
        task={taskFixture({ thumbnail_url: "https://example.com/thumb.jpg" })}
      />,
    );
    const glass = container.querySelector(".media-task-banner__glass") as HTMLDivElement;
    const content = container.querySelector(".media-task-banner__content") as HTMLDivElement;
    const actions = container.querySelector(".media-task-banner__actions") as HTMLDivElement;

    expect(container.querySelectorAll(".media-task-banner__artwork")).toHaveLength(1);
    expect(container.querySelectorAll(".media-task-banner__shade")).toHaveLength(1);
    expect(container.querySelectorAll(".media-task-banner__glass")).toHaveLength(1);
    expect(container.querySelectorAll(".media-task-banner__content")).toHaveLength(1);
    expect(glass.style.zIndex).toBe("");
    expect(content.style.zIndex).toBe("3");
    expect(actions.style.zIndex).toBe("4");
    expect(container.querySelector(".media-task-banner")).toHaveAttribute(
      "data-artwork-tone",
      "medium",
    );
  });

  it("accepts an explicit artwork tone", () => {
    const { container } = render(
      <MediaTaskBanner task={taskFixture()} artworkTone="light" />,
    );
    expect(container.querySelector(".media-task-banner")).toHaveAttribute(
      "data-artwork-tone",
      "light",
    );
  });

  it.each([
    ["downloading", "暂停", "download.pause"],
    ["paused", "继续", "download.resume"],
    ["failed", "重试", "download.retry"],
    ["cancelled", "重新下载", "download.retry"],
  ] as const)("runs the direct %s action", async (status, label, method) => {
    render(<MediaTaskBanner task={taskFixture({ status })} />);
    fireEvent.click(screen.getByRole("button", { name: label }));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(method, { taskId: "task-1" }),
    );
  });

  it("opens a completed file and does not show a green progress line", () => {
    const { container } = render(
      <MediaTaskBanner
        task={taskFixture({ status: "completed", file_path: "/tmp/video.mp4" })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "打开" }));
    expect(openPathMock).toHaveBeenCalledWith("/tmp/video.mp4");
    expect(container.querySelector(".media-task-banner__progress")).toBeNull();
  });

  it("exposes a clamped accessible progress value", () => {
    render(
      <MediaTaskBanner task={taskFixture({ status: "downloading", progress: 130 })} />,
    );
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
  });

  it("renders the artwork placeholder immediately when thumbnail_url is empty", () => {
    const { container } = render(
      <MediaTaskBanner task={taskFixture({ thumbnail_url: "", platform: "bilibili" })} />,
    );

    expect(container.querySelector(".media-task-banner__artwork img")).toBeNull();
    expect(
      container.querySelector(".media-task-banner__artwork-placeholder"),
    ).toHaveTextContent("B");
  });

  it("falls back after a broken thumbnail", () => {
    const { container } = render(
      <MediaTaskBanner
        task={taskFixture({ thumbnail_url: "https://example.com/broken.jpg" })}
      />,
    );
    const image = container.querySelector(".media-task-banner__artwork img");
    expect(image).not.toBeNull();
    fireEvent.error(image as HTMLImageElement);
    expect(container.querySelector(".media-task-banner__artwork img")).toBeNull();
    expect(
      container.querySelector(".media-task-banner__artwork-placeholder"),
    ).toHaveTextContent("Y");
  });

  it("offers the exact login-recovery actions", async () => {
    render(
      <MediaTaskBanner
        task={taskFixture({ status: "failed", error_code: "need_login" })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("download.retry", {
        taskId: "task-1",
      }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "导入浏览器登录状态" }),
    );
    expect(openSettingsMock).toHaveBeenCalledWith();

    fireEvent.click(screen.getByRole("button", { name: "网页识别" }));
    expect(openExtractWindowMock).toHaveBeenCalledWith(
      "https://example.com/video",
    );
  });

  it("renames on double click and submits the exact update payload", async () => {
    render(<MediaTaskBanner task={taskFixture()} />);
    fireEvent.doubleClick(screen.getByText("示例视频"));
    const input = screen.getByRole("textbox", { name: "重命名任务" });
    fireEvent.change(input, { target: { value: "新的标题" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("download.updateTask", {
        taskId: "task-1",
        title: "新的标题",
      }),
    );
  });

  it("focuses and selects the title when rename starts from the more menu", async () => {
    render(<MediaTaskBanner task={taskFixture()} />);
    const trigger = screen.getByRole("button", { name: "更多操作" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));

    await waitFor(() => {
      const input = screen.getByRole("textbox", { name: "重命名任务" }) as HTMLInputElement;
      expect(document.activeElement).toBe(input);
      expect(input.selectionStart).toBe(0);
      expect(input.selectionEnd).toBe("示例视频".length);
    });
  });

  it("focuses and selects the title when rename starts from the native context menu", async () => {
    showTaskContextMenuMock.mockResolvedValueOnce("rename");
    const { container } = render(<MediaTaskBanner task={taskFixture()} />);
    fireEvent.contextMenu(container.querySelector("#task-task-1") as HTMLElement);

    await waitFor(() => {
      const input = screen.getByRole("textbox", { name: "重命名任务" }) as HTMLInputElement;
      expect(document.activeElement).toBe(input);
      expect(input.selectionStart).toBe(0);
      expect(input.selectionEnd).toBe("示例视频".length);
    });
  });

  it("sends the exact pending template to the native context menu", () => {
    const { container } = render(<MediaTaskBanner task={taskFixture()} />);
    fireEvent.contextMenu(container.querySelector("#task-task-1") as HTMLElement);
    expect(showTaskContextMenuMock).toHaveBeenCalledWith([
      { id: "rename", label: "重命名" },
      { id: "extract", label: "网页识别" },
      { id: "separator-download", label: "", type: "separator" },
      { id: "priority-high", label: "设为高优先级" },
      { id: "audio-toggle", label: "仅音频 (MP3)", enabled: true },
      { id: "pp:none", label: "无后处理", enabled: true },
      { id: "pp:mp4", label: "转换为 MP4", enabled: true },
      { id: "pp:mp3", label: "提取音频 (MP3)", enabled: true },
      { id: "pp:script", label: "自定义脚本", enabled: true },
      { id: "cancel", label: "取消下载" },
    ]);
  });

  it("dispatches the action returned by the native context menu", async () => {
    showTaskContextMenuMock.mockResolvedValueOnce("cancel");
    const { container } = render(<MediaTaskBanner task={taskFixture()} />);
    fireEvent.contextMenu(container.querySelector("#task-task-1") as HTMLElement);
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("download.cancel", {
        taskId: "task-1",
      }),
    );
  });

  it("reveals a completed file from the more menu", async () => {
    render(
      <MediaTaskBanner
        task={taskFixture({ status: "completed", file_path: "/tmp/video.mp4" })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "在文件夹中显示" }));
    await waitFor(() =>
      expect(showItemInFolderMock).toHaveBeenCalledWith("/tmp/video.mp4"),
    );
  });

  it("does not invent a direct action for a pending task", () => {
    const { container } = render(<MediaTaskBanner task={taskFixture()} />);
    expect(
      container.querySelector(".media-task-banner__primary-action"),
    ).toBeNull();
  });

  it("keeps only one task menu open", () => {
    render(
      <ul>
        <MediaTaskBanner task={taskFixture({ id: "one" })} />
        <MediaTaskBanner task={taskFixture({ id: "two" })} />
      </ul>,
    );
    const triggers = screen.getAllByRole("button", { name: "更多操作" });
    fireEvent.click(triggers[0]);
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    fireEvent.click(triggers[1]);
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(screen.getByRole("menu")).toHaveAttribute("data-task-id", "two");
  });

  it("closes the menu on Escape and restores trigger focus", async () => {
    render(<MediaTaskBanner task={taskFixture()} />);
    const trigger = screen.getByRole("button", { name: "更多操作" });
    fireEvent.click(trigger);

    const menu = screen.getByRole("menu");
    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
      expect(document.activeElement).toBe(trigger);
    });

    expect(menu).not.toBeInTheDocument();
  });

  it("closes the menu on outside pointerdown", async () => {
    render(
      <div>
        <button type="button">outside</button>
        <MediaTaskBanner task={taskFixture()} />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.pointerDown(screen.getByRole("button", { name: "outside" }));

    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });
  });

  it("supports ArrowUp Down Home End keyboard navigation inside the menu", async () => {
    render(<MediaTaskBanner task={taskFixture()} />);
    const trigger = screen.getByRole("button", { name: "更多操作" });

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "重命名" }));
    });

    const menu = screen.getByRole("menu");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "网页识别" }));

    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "取消下载" }));

    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "自定义脚本" }));

    fireEvent.keyDown(menu, { key: "Home" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "重命名" }));
  });

  it("renders a check icon for the active postprocessing item and dispatches updates", async () => {
    render(
      <MediaTaskBanner task={taskFixture({ postprocessing: "mp4", status: "paused" })} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));

    const mp4Item = screen.getByRole("menuitem", { name: "转换为 MP4" });
    const noneItem = screen.getByRole("menuitem", { name: "无后处理" });

    expect(mp4Item.querySelector('svg[data-icon="check"]')).not.toBeNull();
    expect(noneItem.querySelector('svg[data-icon="check"]')).toBeNull();

    fireEvent.click(screen.getByRole("menuitem", { name: "提取音频 (MP3)" }));

    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("download.updateTask", {
        taskId: "task-1",
        postprocessing: "mp3",
      }),
    );
  });
});
