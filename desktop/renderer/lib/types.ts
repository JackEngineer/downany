import type { ConnectionState } from "../../electron/protocol";

export type { ConnectionState };

export type AppRoute = "new" | "queue" | "history" | "settings";

export interface TaskSnapshot {
  id: string;
  url: string;
  title: string;
  platform: string;
  status: string;
  progress: number;
  downloaded_bytes: number;
  total_bytes: number;
  speed: string;
  eta: string;
  file_path: string;
  error_message: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface AppSettings {
  download_dir: string;
  concurrent_downloads: number;
  speed_limit: number;
  proxy_enabled: boolean;
  proxy_url: string;
  default_quality: string;
  download_subtitles: boolean;
  theme_mode: "system" | "light" | "dark";
  [key: string]: unknown;
}

export interface AppSnapshot {
  tasks: TaskSnapshot[];
  settings: AppSettings;
}

export interface ToastItem {
  id: string;
  kind: "success" | "info" | "warning" | "error";
  title: string;
  detail?: string;
  sticky?: boolean;
}

export interface ProtocolEvent {
  event: string;
  payload: Record<string, unknown>;
}

export interface HistoryItem {
  id: string;
  url: string;
  title: string;
  platform: string;
  status: string;
  file_path: string;
  file_size: number;
  error_message: string;
  created_at: string | null;
}

export interface ParseResultEvent {
  parseId: string;
  index: number;
  url: string;
  ok: boolean;
  cancelled?: boolean;
  error?: string;
  info?: {
    title: string;
    duration: number;
    thumbnail_url: string;
    uploader: string;
    platform: string;
    file_size: number;
  };
}
