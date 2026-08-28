import type { AppSettings } from "../lib/types";

export function settingsFixture(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    download_dir: "C:\\Downloads", concurrent_downloads: 3, speed_limit: 0,
    proxy_enabled: false, proxy_url: "", default_quality: "best",
    download_subtitles: false, theme_mode: "light", auto_start_downloads: true,
    ...overrides,
  };
}
