import { useEffect, useState } from "react";

import type { DesktopApi } from "../../../electron/preload";
import type { TaskSnapshot } from "../../lib/types";
import { useAppStore } from "../../store/appStore";
import { ActionBar } from "../shell/ActionBar";
import { FilterBar } from "../shell/FilterBar";
import { WindowChrome } from "../shell/WindowChrome";
import {
  MediaTaskBanner,
  type ArtworkTone,
} from "../task/MediaTaskBanner";

const ARTWORK_COLORS: Record<ArtworkTone, [string, string, string]> = {
  dark: ["#11151b", "#242c36", "#090b0e"],
  medium: ["#314050", "#8c765b", "#1d242c"],
  light: ["#d7d0c1", "#8797a3", "#4d5660"],
};

function galleryArtwork(title: string, tone: ArtworkTone): string {
  const [start, middle, end] = ARTWORK_COLORS[tone];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="240" viewBox="0 0 1200 240">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${start}"/>
      <stop offset="0.55" stop-color="${middle}"/>
      <stop offset="1" stop-color="${end}"/>
    </linearGradient></defs>
    <rect width="1200" height="240" fill="url(#g)"/>
    <circle cx="930" cy="70" r="130" fill="rgba(255,255,255,.12)"/>
    <path d="M0 190 C220 120 390 230 610 160 S940 110 1200 170 V240 H0Z" fill="rgba(0,0,0,.24)"/>
    <text x="880" y="208" fill="rgba(255,255,255,.72)" font-size="28" font-family="sans-serif">${title}</text>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function galleryTask(
  status: TaskSnapshot["status"],
  tone: ArtworkTone,
  progress: number,
  overrides: Partial<TaskSnapshot> = {},
): TaskSnapshot {
  return {
    id: status,
    url: `https://example.com/${status}`,
    title: `Downany ${status} 状态示例`,
    platform: "youtube",
    thumbnail_url: galleryArtwork(status, tone),
    status,
    progress,
    downloaded_bytes: Math.round((128_600_000 * progress) / 100),
    total_bytes: 128_600_000,
    speed: "8.4 MB/s",
    eta: "00:18",
    file_path: "",
    error_message: "",
    created_at: "2026-08-16T10:00:00Z",
    started_at: "2026-08-16T10:01:00Z",
    completed_at: null,
    quality: "1080p",
    format_id: null,
    audio_only: false,
    postprocessing: "none",
    priority: 0,
    queue_order: 0,
    ...overrides,
  };
}

export const GALLERY_TASKS: TaskSnapshot[] = [
  galleryTask("pending", "dark", 0, {
    title: "准备下载的媒体",
    started_at: null,
  }),
  galleryTask("downloading", "medium", 58, { title: "正在下载的媒体" }),
  galleryTask("paused", "light", 42, { title: "暂停中的媒体" }),
  galleryTask("completed", "medium", 100, {
    title: "已完成的媒体",
    downloaded_bytes: 128_600_000,
    file_path: "/gallery/completed.mp4",
    completed_at: "2026-08-16T11:32:00Z",
  }),
  galleryTask("failed", "dark", 31, {
    title: "需要处理的媒体",
    error_code: "need_login",
    error_message: "Sign in to confirm your age",
  }),
  galleryTask("cancelled", "light", 0, {
    title: "已取消的媒体",
    thumbnail_url: "",
    platform: "bilibili",
    started_at: null,
  }),
];

const PRODUCT_TASKS: TaskSnapshot[] = [
  galleryTask("completed", "dark", 100, {
    id: "gallery-courtyard",
    title: "四合院门楼的大门也是整个合院的一个灵魂，安装之后效果立马呈现！#唐河四合院",
    platform: "douyin",
    downloaded_bytes: 128_600_000,
    file_path: "/gallery/courtyard.mp4",
    completed_at: "2026-08-16T18:32:00Z",
    quality: "1080p",
  }),
  galleryTask("completed", "medium", 100, {
    id: "gallery-ark",
    title: "火山方舟 - 体验",
    platform: "web",
    downloaded_bytes: 86_400_000,
    total_bytes: 86_400_000,
    file_path: "/gallery/ark.mp4",
    completed_at: "2026-08-16T18:18:00Z",
    quality: "1080p",
  }),
  galleryTask("completed", "light", 100, {
    id: "gallery-karpathy",
    title: "Andrej Karpathy 在 OpenAI 和 Tesla 工作了 8 年",
    platform: "twitter",
    downloaded_bytes: 52_100_000,
    total_bytes: 52_100_000,
    file_path: "/gallery/karpathy.mp4",
    completed_at: "2026-08-16T17:58:00Z",
    quality: "720p",
  }),
];

const GALLERY_TONES: Record<string, ArtworkTone> = {
  pending: "dark",
  downloading: "medium",
  paused: "light",
  completed: "medium",
  failed: "dark",
  cancelled: "light",
};

export function installGalleryApiMock(): void {
  const mock = {
    platform: "darwin",
    request: async (method: string) => {
      if (method === "search.query") return { searchId: "gallery-search" };
      if (method === "download.createTasks") return { taskIds: [] };
      if (method === "app.getSnapshot") return { tasks: GALLERY_TASKS, settings: null };
      return {};
    },
    openPath: async (target: string) => target,
    showItemInFolder: async () => undefined,
    openSettings: async () => undefined,
    openExtractWindow: async () => undefined,
    showTaskContextMenu: async () => null,
  } satisfies Partial<DesktopApi>;

  Object.defineProperty(window, "api", {
    configurable: true,
    writable: true,
    value: mock as DesktopApi,
  });
}

interface GallerySectionProps {
  title: string;
  description: string;
  density: "normal" | "compact";
  tasks: TaskSnapshot[];
  backdropMode?: "default" | "none";
}

function GallerySection({
  title,
  description,
  density,
  tasks,
  backdropMode = "default",
}: GallerySectionProps) {
  return (
    <section
      className="design-system-gallery__section"
      aria-labelledby={`${density}-density-title`}
      aria-describedby={`${density}-density-copy`}
      role="region"
    >
      <div className="design-system-gallery__section-head">
        <h2 id={`${density}-density-title`}>{title}</h2>
        <p id={`${density}-density-copy`}>{description}</p>
      </div>
      <ul className="download-list" data-backdrop-mode={backdropMode}>
        {tasks.map((task) => (
          <MediaTaskBanner
            key={task.id}
            task={task}
            density={density}
            artworkTone={GALLERY_TONES[task.id] ?? "medium"}
          />
        ))}
      </ul>
    </section>
  );
}

export function DesktopCoreGallery() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [reduceTransparency, setReduceTransparency] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth);

  useEffect(() => {
    useAppStore.setState({
      connection: "connected",
      filter: "all",
      searchMode: "filter",
      searchQuery: "",
      tasks: GALLERY_TASKS,
      settings: null,
      toasts: [],
    });
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    document.documentElement.dataset.reduceTransparency = String(
      reduceTransparency,
    );
  }, [reduceTransparency]);

  useEffect(() => {
    const updateWidth = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", updateWidth);
    return () => window.removeEventListener("resize", updateWidth);
  }, []);

  return (
    <div className="design-system-gallery">
      <div
        className="window-shell design-system-gallery__window"
        data-platform="darwin"
      >
        <div className="design-system-gallery__traffic-lights" aria-hidden>
          <span className="design-system-gallery__traffic-light design-system-gallery__traffic-light--close" />
          <span className="design-system-gallery__traffic-light design-system-gallery__traffic-light--minimize" />
          <span className="design-system-gallery__traffic-light design-system-gallery__traffic-light--zoom" />
        </div>
        <WindowChrome platform="darwin" />
        <ActionBar />
        <FilterBar />
        <main className="window-main design-system-gallery__main">
          <ul className="download-list design-system-gallery__product-queue">
            {PRODUCT_TASKS.map((task) => (
              <MediaTaskBanner
                key={task.id}
                task={task}
                artworkTone={
                  task.id === "gallery-courtyard"
                    ? "dark"
                    : task.id === "gallery-karpathy"
                      ? "light"
                      : "medium"
                }
              />
            ))}
          </ul>

          <details className="design-system-gallery__inspector">
            <summary>开发检查</summary>
            <div className="design-system-gallery__inspector-panel">
              <aside
                className="design-system-gallery__controls"
                aria-label="视觉检查控制"
              >
                <span aria-label="当前视口宽度">{viewportWidth}px</span>
                <button
                  type="button"
                  aria-pressed={theme === "dark"}
                  onClick={() => setTheme("dark")}
                >
                  深色
                </button>
                <button
                  type="button"
                  aria-pressed={theme === "light"}
                  onClick={() => setTheme("light")}
                >
                  浅色
                </button>
                <button
                  type="button"
                  aria-pressed={reduceTransparency}
                  onClick={() => setReduceTransparency((value) => !value)}
                >
                  减少透明
                </button>
              </aside>
              <GallerySection
                title="标准密度"
                description="保留完整玻璃层，覆盖等待、下载中与已暂停三态。"
                density="normal"
                tasks={GALLERY_TASKS.slice(0, 3)}
              />
              <GallerySection
                title="紧凑密度（无毛玻璃降级）"
                description="固定展示 completed、failed、cancelled，并用真实 token 强制无 backdrop-filter。"
                density="compact"
                tasks={GALLERY_TASKS.slice(3)}
                backdropMode="none"
              />
            </div>
          </details>
        </main>
      </div>
    </div>
  );
}
