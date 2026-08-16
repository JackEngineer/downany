import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
const resizeDisconnectMock = vi.fn();
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const mediaBannerStyles = readFileSync(
  path.resolve(testDirectory, "../../styles/media-task-banner.css"),
  "utf8",
);
const appStyles = readFileSync(
  path.resolve(testDirectory, "../../styles.css"),
  "utf8",
).replace(/^@import .*;$/gm, "");
const designTokens = readFileSync(
  path.resolve(testDirectory, "../../../../design-system/tokens.css"),
  "utf8",
);
let resizeCallback: ResizeObserverCallback;

function getCssBlock(css: string, header: string): string | null {
  const headerStart = css.indexOf(header);
  if (headerStart < 0) return null;
  const blockStart = css.indexOf("{", headerStart + header.length);
  if (blockStart < 0) return null;

  let depth = 0;
  for (let index = blockStart; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    if (css[index] === "}") depth -= 1;
    if (depth === 0) return css.slice(blockStart + 1, index);
  }
  return null;
}

function expectTaskLayoutContract(tokens: string, styles: string): void {
  expect(tokens).toMatch(/^\s*--material-task-glass-width:\s*58%;\s*$/m);
  expect(tokens).not.toMatch(/^\s*--layout-task-narrow-viewport:/m);

  const bannerRules = getCssBlock(styles, ".media-task-banner");
  expect(bannerRules).toMatch(
    /grid-template-columns:\s*minmax\(0, var\(--material-task-glass-width\)\) minmax\(112px, 1fr\);/,
  );
  const glassRules = getCssBlock(styles, ".media-task-banner__glass");
  expect(glassRules).toMatch(/width:\s*var\(--material-task-glass-width\);/);
  const contentRules = getCssBlock(styles, ".media-task-banner__content");
  expect(contentRules).toMatch(/min-width:\s*0;/);
  expect(contentRules).toMatch(/width:\s*100%;/);
  expect(contentRules).toMatch(/box-sizing:\s*border-box;/);
  const actionRules = getCssBlock(styles, ".media-task-banner__actions");
  expect(actionRules).toMatch(/flex-wrap:\s*wrap;/);

  const compactRules = getCssBlock(styles, "@media (max-width: 760px)");
  expect(compactRules).not.toBeNull();
  expect(getCssBlock(compactRules ?? "", ".media-task-banner__actions")).toMatch(
    /min-width:\s*0;/,
  );
  expect(compactRules).not.toContain(".media-task-banner__glass");

  const narrowRules = getCssBlock(styles, "@media (max-width: 900px)");
  expect(narrowRules).not.toBeNull();
  expect(narrowRules).not.toContain(".media-task-banner__glass");
}

function installBannerCascade(): void {
  const style = document.createElement("style");
  style.dataset.testStyles = "media-task-banner-cascade";
  style.textContent = `${mediaBannerStyles}\n${appStyles}`;
  document.head.append(style);
}

class ResizeObserverMock implements ResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    resizeCallback = callback;
  }

  observe(): void {}
  unobserve(): void {}
  disconnect(): void {
    resizeDisconnectMock();
  }
  takeRecords(): ResizeObserverEntry[] {
    return [];
  }
}

function emitResize(target: Element, width: number, height: number): void {
  act(() => {
    resizeCallback(
      [{ target, contentRect: { width, height } } as ResizeObserverEntry],
      {} as ResizeObserver,
    );
  });
}

function loadImage(image: HTMLImageElement, width: number, height: number): void {
  Object.defineProperties(image, {
    naturalWidth: { configurable: true, value: width },
    naturalHeight: { configurable: true, value: height },
  });
  fireEvent.load(image);
}

function mockCanvasGray(channel: number): void {
  const pixels = new Uint8ClampedArray(16 * 16 * 4);
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = channel;
    pixels[index + 1] = channel;
    pixels[index + 2] = channel;
    pixels[index + 3] = 255;
  }
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
    getImageData: () => ({ data: pixels }),
  } as unknown as CanvasRenderingContext2D);
}

vi.mock("../../lib/api", () => ({
  request: (...args: unknown[]) => requestMock(...args),
  openPath: (...args: unknown[]) => openPathMock(...args),
  openSettings: (...args: unknown[]) => openSettingsMock(...args),
  openExtractWindow: (...args: unknown[]) => openExtractWindowMock(...args),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("data-theme");
  document
    .querySelectorAll('[data-test-styles="media-task-banner-cascade"]')
    .forEach((node) => node.remove());
});

beforeEach(() => {
  globalThis.ResizeObserver = ResizeObserverMock;
  resizeDisconnectMock.mockReset();
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
    expect(glass).toBeInTheDocument();
    expect(content).toBeInTheDocument();
    expect(actions).toBeInTheDocument();
  });

  it("keeps the rename field owned by dark media styling in the light theme", () => {
    installBannerCascade();
    document.documentElement.dataset.theme = "light";
    render(<MediaTaskBanner task={taskFixture()} />);
    fireEvent.doubleClick(screen.getByText("示例视频"));

    const input = screen.getByRole("textbox", {
      name: "重命名任务",
    }) as HTMLInputElement;
    input.focus();
    const computed = getComputedStyle(input);

    expect(computed.boxSizing).toBe("border-box");
    expect(computed.maxWidth).toBe("560px");
    expect(mediaBannerStyles).toMatch(
      /\.media-task-banner input\.media-task-banner__title-input\s*\{[^}]*background:\s*var\(--task-glass-tint,[^}]*color:\s*var\(--color-text-on-media\);/s,
    );
    expect(mediaBannerStyles).toMatch(
      /\.media-task-banner input\.media-task-banner__title-input:focus(?:-visible)?\s*\{[^}]*border-color:\s*var\(--color-focus-ring\);[^}]*box-shadow:\s*0 0 0 2px var\(--color-focus-ring\);/s,
    );
  });

  it("locks the 58 percent Reading Glass and 760px no-overflow layout contract", () => {
    expectTaskLayoutContract(designTokens, mediaBannerStyles);
    expect(mediaBannerStyles).toMatch(
      /\.media-task-banner__artwork-focus\s*\{[^}]*mask-image:\s*linear-gradient\([^}]*var\(--material-task-focus-feather\)/s,
    );
    expect(mediaBannerStyles).toMatch(
      /data-artwork-shape="portrait"[^}]*\.media-task-banner__artwork-focus,[^}]*data-artwork-shape="unknown"[^}]*\.media-task-banner__artwork-focus\s*\{[^}]*object-fit:\s*contain;/s,
    );
  });

  it("rejects mutations to the 58 percent and 760px layout contracts", () => {
    expect(() =>
      expectTaskLayoutContract(
        designTokens.replace(
          "--material-task-glass-width: 58%;",
          "--material-task-glass-width: 68%;",
        ),
        mediaBannerStyles,
      ),
    ).toThrow();
    expect(() =>
      expectTaskLayoutContract(
        designTokens,
        mediaBannerStyles.replace(/@media \(max-width: 760px\)[\s\S]*$/, ""),
      ),
    ).toThrow();
  });

  it("waits for ambient measurement before mounting a lazy focus layer", () => {
    const { container } = render(
      <MediaTaskBanner
        task={taskFixture({ thumbnail_url: "https://example.com/portrait.jpg" })}
      />,
    );

    expect(
      container.querySelector(".media-task-banner__artwork-ambient"),
    ).toHaveAttribute("loading", "lazy");
    expect(container.querySelector(".media-task-banner__artwork-focus")).toBeNull();
  });

  it("uses ambient plus contained focus media for weak portrait artwork", () => {
    mockCanvasGray(255);
    const { container } = render(
      <MediaTaskBanner
        task={taskFixture({ thumbnail_url: "https://example.com/portrait.jpg" })}
      />,
    );
    const banner = container.querySelector(".media-task-banner") as HTMLElement;
    emitResize(banner, 1200, 108);
    const ambient = container.querySelector(
      ".media-task-banner__artwork-ambient",
    ) as HTMLImageElement;
    loadImage(ambient, 720, 960);

    expect(banner).toHaveAttribute("data-media-quality", "weak");
    expect(banner).toHaveAttribute("data-artwork-shape", "portrait");
    expect(banner).toHaveAttribute("data-artwork-tone", "light");
    expect(
      container.querySelectorAll(".media-task-banner__artwork-focus"),
    ).toHaveLength(1);
    expect(
      container.querySelector(".media-task-banner__artwork-focus"),
    ).toHaveAttribute("loading", "lazy");
  });

  it("hides only a failed focus layer while preserving ambient media", () => {
    mockCanvasGray(180);
    const { container } = render(
      <MediaTaskBanner
        task={taskFixture({ thumbnail_url: "https://example.com/portrait.jpg" })}
      />,
    );
    const ambient = container.querySelector(
      ".media-task-banner__artwork-ambient",
    ) as HTMLImageElement;
    emitResize(container.querySelector(".media-task-banner") as HTMLElement, 1200, 108);
    loadImage(ambient, 720, 960);

    const focus = container.querySelector(
      ".media-task-banner__artwork-focus",
    ) as HTMLImageElement;
    fireEvent.error(focus);

    expect(container.querySelector(".media-task-banner__artwork-focus")).toBeNull();
    expect(container.querySelector(".media-task-banner__artwork-ambient")).toBe(ambient);
    expect(container.querySelector(".media-task-banner")).toHaveAttribute(
      "data-media-quality",
      "weak",
    );
  });

  it("ignores late load and error events from the previous artwork URL", () => {
    mockCanvasGray(255);
    const firstTask = taskFixture({
      thumbnail_url: "https://example.com/first.jpg",
    });
    const { container, rerender } = render(<MediaTaskBanner task={firstTask} />);
    const banner = container.querySelector(".media-task-banner") as HTMLElement;
    const staleAmbient = container.querySelector(
      ".media-task-banner__artwork-ambient",
    ) as HTMLImageElement;
    Object.defineProperties(staleAmbient, {
      naturalWidth: { configurable: true, value: 720 },
      naturalHeight: { configurable: true, value: 960 },
    });

    rerender(
      <MediaTaskBanner
        task={{ ...firstTask, thumbnail_url: "https://example.com/second.jpg" }}
      />,
    );
    const currentAmbient = container.querySelector(
      ".media-task-banner__artwork-ambient",
    ) as HTMLImageElement;
    fireEvent.load(staleAmbient);
    fireEvent.error(staleAmbient);

    expect(currentAmbient).not.toBe(staleAmbient);
    expect(banner).toHaveAttribute("data-media-quality", "weak");
    expect(banner).toHaveAttribute("data-artwork-shape", "unknown");
    expect(banner).toHaveAttribute("data-artwork-tone", "light");
    expect(container.querySelector(".media-task-banner__artwork-focus")).toBeNull();
    expect(currentAmbient).toHaveAttribute(
      "src",
      "https://example.com/second.jpg",
    );
  });

  it("retries a previously broken artwork URL when it becomes current again", () => {
    const firstTask = taskFixture({
      thumbnail_url: "https://example.com/first.jpg",
    });
    const { container, rerender } = render(<MediaTaskBanner task={firstTask} />);
    fireEvent.error(
      container.querySelector(
        ".media-task-banner__artwork-ambient",
      ) as HTMLImageElement,
    );
    expect(container.querySelector(".media-task-banner")).toHaveAttribute(
      "data-media-quality",
      "missing",
    );

    rerender(
      <MediaTaskBanner
        task={{ ...firstTask, thumbnail_url: "https://example.com/second.jpg" }}
      />,
    );
    expect(
      container.querySelector(".media-task-banner__artwork-ambient"),
    ).toHaveAttribute("src", "https://example.com/second.jpg");

    rerender(<MediaTaskBanner task={firstTask} />);
    expect(
      container.querySelector(".media-task-banner__artwork-ambient"),
    ).toHaveAttribute("src", "https://example.com/first.jpg");
    expect(container.querySelector(".media-task-banner")).toHaveAttribute(
      "data-media-quality",
      "weak",
    );
  });

  it("treats zero-sized artwork as missing without mounting focus media", () => {
    mockCanvasGray(100);
    const { container } = render(
      <MediaTaskBanner
        task={taskFixture({ thumbnail_url: "https://example.com/invalid.jpg" })}
      />,
    );
    const banner = container.querySelector(".media-task-banner") as HTMLElement;
    emitResize(banner, 1200, 108);
    loadImage(
      container.querySelector(
        ".media-task-banner__artwork-ambient",
      ) as HTMLImageElement,
      0,
      0,
    );

    expect(banner).toHaveAttribute("data-media-quality", "missing");
    expect(container.querySelector(".media-task-banner__artwork-focus")).toBeNull();
    expect(
      container.querySelector(".media-task-banner__artwork-placeholder"),
    ).toBeInTheDocument();
  });

  it("disconnects its banner observer on unmount", () => {
    const { unmount } = render(<MediaTaskBanner task={taskFixture()} />);

    unmount();

    expect(resizeDisconnectMock).toHaveBeenCalledTimes(1);
  });

  it("removes the focus layer for a standard landscape image", () => {
    mockCanvasGray(0);
    const { container } = render(
      <MediaTaskBanner
        task={taskFixture({ thumbnail_url: "https://example.com/wide.jpg" })}
      />,
    );
    const banner = container.querySelector(".media-task-banner") as HTMLElement;
    emitResize(banner, 1200, 108);
    loadImage(
      container.querySelector(
        ".media-task-banner__artwork-ambient",
      ) as HTMLImageElement,
      1920,
      1080,
    );

    expect(banner).toHaveAttribute("data-media-quality", "standard");
    expect(banner).toHaveAttribute("data-artwork-tone", "dark");
    expect(container.querySelector(".media-task-banner__artwork-focus")).toBeNull();
  });

  it("reclassifies standard artwork when the banner grows past its natural width", () => {
    mockCanvasGray(100);
    const { container } = render(
      <MediaTaskBanner
        task={taskFixture({ thumbnail_url: "https://example.com/wide.jpg" })}
      />,
    );
    const banner = container.querySelector(".media-task-banner") as HTMLElement;
    const ambient = container.querySelector(
      ".media-task-banner__artwork-ambient",
    ) as HTMLImageElement;
    emitResize(banner, 1000, 108);
    loadImage(ambient, 1280, 720);
    expect(banner).toHaveAttribute("data-media-quality", "standard");

    emitResize(banner, 1400, 108);
    expect(banner).toHaveAttribute("data-media-quality", "weak");
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
    expect(container.querySelector(".media-task-banner")).toHaveAttribute(
      "data-media-quality",
      "missing",
    );
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
    expect(container.querySelector(".media-task-banner")).toHaveAttribute(
      "data-media-quality",
      "missing",
    );
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
