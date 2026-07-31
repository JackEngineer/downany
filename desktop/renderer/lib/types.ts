import type { ConnectionState } from "../../electron/protocol";

export type { ConnectionState };

export type AppRoute = "new" | "queue" | "history" | "settings";

export type ListFilter = "all" | "active" | "completed" | "history";

export type SearchMode = "filter" | "network";

export interface NetSearchItem {
  url: string;
  title: string;
  duration: number;
  thumbnail_url: string;
  uploader: string;
  platform: string;
}

export interface NetSearchResultPayload {
  searchId: string;
  ok: boolean;
  query?: string;
  items?: NetSearchItem[];
  error?: string;
}

export interface FormatOption {
  format_id: string;
  ext: string;
  height: number;
  fps: number;
  filesize: number;
  tbr: number;
  video_only: boolean;
}

export interface TaskSnapshot {
  id: string;
  url: string;
  title: string;
  platform: string;
  thumbnail_url?: string;
  status: string;
  progress: number;
  downloaded_bytes: number;
  total_bytes: number;
  speed: string;
  eta: string;
  file_path: string;
  error_message: string;
  error_code?: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  quality?: string;
  format_id?: string | null;
  audio_only?: boolean;
  postprocessing?: string;
  priority?: number;
  queue_order?: number;
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
  auto_start_downloads?: boolean;
  clipboard_monitor?: boolean;
  postprocessing?: string;
  postprocess_script?: string;
  filename_template?: string;
  menu_bar_mode?: boolean;
  dock_progress?: boolean;
  cookies_from_browser?: string;
  embed_metadata?: boolean;
  concurrent_fragments?: number;
  telemetry_enabled?: boolean;
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

export interface PlaylistEntry {
  id?: string;
  title?: string;
  url: string;
}

export interface ParseResultEvent {
  parseId: string;
  index: number;
  url: string;
  ok: boolean;
  cancelled?: boolean;
  error?: string;
  entries?: PlaylistEntry[];
  info?: {
    title: string;
    duration: number;
    thumbnail_url: string;
    uploader: string;
    platform: string;
    file_size: number;
    formats?: FormatOption[];
  };
}
