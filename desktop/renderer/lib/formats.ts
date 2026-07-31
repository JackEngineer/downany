import { formatBytes } from "./format";
import type { FormatOption } from "./types";

/** 画质选项展示文案：1080p60 · mp4 · 512 MB */
export function formatOptionLabel(f: FormatOption): string {
  const fps = f.fps > 30 ? String(f.fps) : "";
  const parts = [`${f.height}p${fps}`];
  if (f.ext) parts.push(f.ext);
  if (f.filesize) parts.push(formatBytes(f.filesize));
  return parts.join(" · ");
}

/**
 * 传给 yt-dlp 的 format 表达式：
 * 纯视频格式需要合并音频轨（video_only → format_id+bestaudio）。
 */
export function formatSelectorValue(f: FormatOption): string {
  return f.video_only ? `${f.format_id}+bestaudio` : f.format_id;
}
