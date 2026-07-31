/** 打开已完成任务时：优先用合并后的成品，避开 yt-dlp 中间分片路径。 */

import * as fs from "node:fs";

const FORMAT_FRAGMENT_RE = /\.f\d+\.(mp4|m4a|webm|mkv|opus|ogg)$/i;
const MERGED_EXTS = [".mp4", ".mkv", ".webm", ".m4a", ".opus"] as const;

export function resolveOpenablePath(target: string): string {
  const text = (target || "").trim();
  if (!text) return text;

  if (FORMAT_FRAGMENT_RE.test(text)) {
    const prefix = text.replace(FORMAT_FRAGMENT_RE, "");
    for (const ext of MERGED_EXTS) {
      const sibling = prefix + ext;
      if (fs.existsSync(sibling)) return sibling;
    }
  }

  return text;
}
