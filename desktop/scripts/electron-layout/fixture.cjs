const path = require("node:path");

function svgThumbnail(width, height, start, end, label) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${start}"/><stop offset="1" stop-color="${end}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><text x="50%" y="52%" dominant-baseline="middle" text-anchor="middle" fill="rgba(255,255,255,.72)" font-family="sans-serif" font-size="${Math.max(24, Math.floor(height / 8))}">${label}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function task(overrides) {
  return {
    id: "layout-task",
    url: "https://example.com/video",
    title: "生产路径布局任务",
    platform: "YouTube",
    thumbnail_url: "",
    status: "completed",
    progress: 100,
    downloaded_bytes: 52_000_000,
    total_bytes: 52_000_000,
    speed: "",
    eta: "",
    file_path: "",
    error_message: "",
    created_at: "2026-08-17T00:00:00Z",
    started_at: "2026-08-17T00:00:01Z",
    completed_at: "2026-08-17T00:01:00Z",
    quality: "1080p",
    postprocessing: "none",
    priority: 0,
    queue_order: 0,
    ...overrides,
  };
}

function createFixtureSnapshot(tempDir) {
  const output = (name) => path.join(tempDir, "downloads", name);
  return {
    settings: {
      download_dir: path.join(tempDir, "downloads"),
      concurrent_downloads: 3,
      speed_limit: 0,
      proxy_enabled: false,
      proxy_url: "",
      default_quality: "best",
      download_subtitles: false,
      subtitle_langs: "",
      embed_subs: false,
      download_sections: "",
      sponsorblock_remove: "",
      theme_mode: "dark",
      auto_start_downloads: false,
      clipboard_monitor: false,
      postprocessing: "none",
      postprocess_script: "",
      filename_template: "%(title)s.%(ext)s",
      menu_bar_mode: false,
      dock_progress: false,
      cookies_from_browser: "",
      embed_metadata: false,
      concurrent_fragments: 1,
      telemetry_enabled: false,
    },
    tasks: [
      task({
        id: "layout-pending",
        title: "等待下载的生产路径任务",
        status: "pending",
        progress: 0,
        file_path: "",
        completed_at: null,
        queue_order: 0,
        thumbnail_url: svgThumbnail(720, 960, "#202734", "#6b7280", "PORTRAIT"),
      }),
      task({
        id: "layout-dark",
        title: "深色媒体横幅",
        file_path: output("dark.mp4"),
        completed_at: "2026-08-17T00:06:00Z",
        thumbnail_url: svgThumbnail(1920, 1080, "#0b0d10", "#344054", "DARK"),
      }),
      task({
        id: "layout-bright",
        title: "亮图媒体焦点验收",
        file_path: output("bright.mp4"),
        completed_at: "2026-08-17T00:05:00Z",
        thumbnail_url: svgThumbnail(1920, 1080, "#ffffff", "#eef2f7", "BRIGHT"),
      }),
      task({
        id: "layout-four",
        title: "第四条滚动任务",
        file_path: output("four.mp4"),
        completed_at: "2026-08-17T00:04:00Z",
        thumbnail_url: svgThumbnail(1280, 720, "#334155", "#64748b", "FOUR"),
      }),
      task({
        id: "layout-five",
        title: "第五条滚动任务",
        file_path: output("five.mp4"),
        completed_at: "2026-08-17T00:03:00Z",
        thumbnail_url: svgThumbnail(1280, 720, "#3f3f46", "#71717a", "FIVE"),
      }),
      task({
        id: "layout-six",
        title: "第六条滚动任务",
        file_path: output("six.mp4"),
        completed_at: "2026-08-17T00:02:00Z",
        thumbnail_url: svgThumbnail(1280, 720, "#27272a", "#52525b", "SIX"),
      }),
    ],
  };
}

module.exports = { createFixtureSnapshot };
