/** 菜单栏模式：Tray 图标与菜单。 */
import { Menu, Tray, nativeImage } from "electron";
import path from "node:path";

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
  // NativeImage discovers the paired @2x asset; macOS supplies light/dark tint.
  const file = process.platform === "darwin" ? "brand-trayTemplate.png" : "brand-tray.png";
  const image = nativeImage.createFromPath(path.join(__dirname, file));
  if (process.platform === "darwin") image.setTemplateImage(true);
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
      this.activeCount > 0 ? `百纳 — ${this.activeCount} 个进行中` : "百纳",
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
      { label: "退出 百纳", click: () => this.callbacks.onQuit() },
    );
    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }
}
