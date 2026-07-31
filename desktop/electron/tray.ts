/** 菜单栏模式：Tray 图标与菜单。 */
import { Menu, Tray, nativeImage } from "electron";

import type { TrackedTask } from "./taskTracker";

export interface TrayCallbacks {
  onShowWindow: () => void;
  onAddFromClipboard: () => void;
  onPauseAll: () => void;
  onResumeAll: () => void;
  onFocusTask: (taskId: string) => void;
  onQuit: () => void;
}

function buildTrayIcon(): Electron.NativeImage {
  // 运行时绘制 18x18 模板图标（下载箭头），避免打包资源路径问题
  const size = 18;
  const buffer = Buffer.alloc(size * size * 4);
  const set = (x: number, y: number) => {
    if (x < 0 || x >= size || y < 0 || y >= size) return;
    const i = (y * size + x) * 4;
    buffer[i] = 0;
    buffer[i + 1] = 0;
    buffer[i + 2] = 0;
    buffer[i + 3] = 255;
  };
  for (let y = 2; y <= 9; y += 1) {
    set(8, y);
    set(9, y);
  }
  for (let y = 8; y <= 14; y += 1) {
    const half = 14 - y;
    for (let x = 9 - half; x <= 8 + half; x += 1) set(x, y);
  }
  for (let x = 4; x <= 13; x += 1) {
    set(x, 15);
    set(x, 16);
  }
  const image = nativeImage.createFromBitmap(buffer, { width: size, height: size });
  image.setTemplateImage(true);
  return image;
}

function statusIcon(status: string): string {
  switch (status) {
    case "downloading":
      return "⬇︎";
    case "paused":
      return "⏸";
    case "completed":
      return "✓";
    case "failed":
      return "✗";
    default:
      return "…";
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export class TrayController {
  private tray: Tray | null = null;
  private activeCount = 0;
  private tasks: TrackedTask[] = [];

  constructor(private readonly callbacks: TrayCallbacks) {}

  get enabled(): boolean {
    return this.tray !== null;
  }

  enable(): void {
    if (this.tray) return;
    this.tray = new Tray(buildTrayIcon());
    this.rebuild();
  }

  disable(): void {
    this.tray?.destroy();
    this.tray = null;
  }

  update(activeCount: number, tasks: TrackedTask[]): void {
    this.activeCount = activeCount;
    this.tasks = tasks;
    this.rebuild();
  }

  private rebuild(): void {
    if (!this.tray) return;
    this.tray.setToolTip(
      this.activeCount > 0 ? `视频下载器 — ${this.activeCount} 个进行中` : "视频下载器",
    );
    const recent = this.tasks.slice(0, 5);
    const template: Electron.MenuItemConstructorOptions[] = [
      { label: "显示主窗口", click: () => this.callbacks.onShowWindow() },
      { type: "separator" },
    ];
    if (recent.length === 0) {
      template.push({ label: "暂无任务", enabled: false });
    } else {
      for (const task of recent) {
        template.push({
          label: `${statusIcon(task.status)} ${truncate(task.title || task.id, 24)}`,
          click: () => this.callbacks.onFocusTask(task.id),
        });
      }
    }
    template.push(
      { type: "separator" },
      { label: "从剪贴板添加 URL", click: () => this.callbacks.onAddFromClipboard() },
      { label: "全部暂停", click: () => this.callbacks.onPauseAll() },
      { label: "全部恢复", click: () => this.callbacks.onResumeAll() },
      { type: "separator" },
      { label: "退出 视频下载器", click: () => this.callbacks.onQuit() },
    );
    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }
}
