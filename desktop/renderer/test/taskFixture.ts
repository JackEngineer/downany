import type { TaskSnapshot } from "../lib/types";

export function taskFixture(
  overrides: Partial<TaskSnapshot> = {},
): TaskSnapshot {
  return {
    id: "task-1",
    url: "https://example.com/video",
    title: "示例视频",
    platform: "youtube",
    thumbnail_url: "",
    status: "pending",
    progress: 0,
    downloaded_bytes: 0,
    total_bytes: 0,
    speed: "—",
    eta: "—",
    file_path: "",
    error_message: "",
    completion_note: "",
    created_at: "2026-08-16T10:00:00Z",
    started_at: null,
    completed_at: null,
    quality: "best",
    format_id: null,
    audio_only: false,
    postprocessing: "none",
    priority: 0,
    queue_order: 0,
    ...overrides,
  };
}
