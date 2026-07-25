/** 窗口几何持久化。 */
import * as fs from "node:fs";
import * as path from "node:path";
import { app, BrowserWindow, Rectangle, screen } from "electron";

export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized?: boolean;
}

const DEFAULT_STATE: WindowState = {
  width: 1100,
  height: 720,
};

function statePath(): string {
  return path.join(app.getPath("userData"), "window-state.json");
}

export function loadWindowState(): WindowState {
  try {
    const raw = fs.readFileSync(statePath(), "utf8");
    const parsed = JSON.parse(raw) as WindowState;
    if (
      typeof parsed.width === "number" &&
      typeof parsed.height === "number" &&
      parsed.width >= 400 &&
      parsed.height >= 300
    ) {
      return { ...DEFAULT_STATE, ...parsed };
    }
  } catch {
    // ignore
  }
  return { ...DEFAULT_STATE };
}

export function saveWindowState(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  const isMaximized = win.isMaximized();
  const bounds: Rectangle = isMaximized ? win.getNormalBounds() : win.getBounds();
  const state: WindowState = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    isMaximized,
  };
  try {
    fs.writeFileSync(statePath(), JSON.stringify(state), "utf8");
  } catch {
    // ignore
  }
}

/** 若坐标落在可见显示器外则居中。 */
export function sanitizeBounds(state: WindowState): WindowState {
  const displays = screen.getAllDisplays();
  if (state.x == null || state.y == null) return state;
  const visible = displays.some((d) => {
    const b = d.bounds;
    return (
      state.x! >= b.x - 50 &&
      state.y! >= b.y - 50 &&
      state.x! < b.x + b.width &&
      state.y! < b.y + b.height
    );
  });
  if (visible) return state;
  const { width, height } = state;
  return { width, height };
}
