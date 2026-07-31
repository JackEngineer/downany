/**
 * 桌面侧媒体 URL / 清单嗅探（与 browser-extension/sniff-core.js 逻辑对齐的 TS 精简版）。
 */

const HTTP_RE = /^https?:\/\/\S+/i;

const MEDIA_EXT_RE =
  /\.(m3u8|mpd|mp4|webm|mkv|mov|m4v|mp3|m4a|aac|flac|ogg|wav)(?:$|[?#])/i;
const SEGMENT_EXT_RE = /\.(ts|m4s|cmfv|cmfa|cmft)(?:$|[?#])/i;

export type M3U8ParseResult = {
  kind: "master" | "media";
  variants: number;
  maxBandwidth: number;
  bestResolution: string | null;
  duration: number | null;
};

export type MediaTypeHint = "hls" | "dash" | "audio" | "file";

function isHttpUrl(value: string): boolean {
  return typeof value === "string" && HTTP_RE.test(value.trim());
}

export function isSegmentUrl(url: string): boolean {
  return SEGMENT_EXT_RE.test(url);
}

export function looksLikeMediaUrl(url: string): boolean {
  if (!isHttpUrl(url) || isSegmentUrl(url)) return false;
  return MEDIA_EXT_RE.test(url);
}

export function classifyByContentType(contentType: string | null | undefined): MediaTypeHint | null {
  if (!contentType) return null;
  const ct = contentType.toLowerCase().split(";")[0].trim();
  if (ct.includes("mpegurl") || ct.includes("m3u8")) return "hls";
  if (ct.includes("dash+xml")) return "dash";
  if (ct.startsWith("audio/")) return "audio";
  if (ct.startsWith("video/")) return "file";
  return null;
}

export function parseM3U8(text: string): M3U8ParseResult | null {
  if (!text || !text.trimStart().startsWith("#EXTM3U")) return null;
  const lines = text.split(/\r?\n/);
  let variants = 0;
  let bestResolution: string | null = null;
  let maxBandwidth = 0;
  let duration = 0;
  let hasSegments = false;
  for (const line of lines) {
    if (line.startsWith("#EXT-X-STREAM-INF")) {
      variants++;
      const bw = /BANDWIDTH=(\d+)/.exec(line);
      if (bw) maxBandwidth = Math.max(maxBandwidth, parseInt(bw[1], 10));
      const res = /RESOLUTION=(\d+x\d+)/.exec(line);
      if (res) bestResolution = res[1];
    } else if (line.startsWith("#EXTINF:")) {
      const d = /#EXTINF:([\d.]+)/.exec(line);
      if (d) {
        duration += parseFloat(d[1]);
        hasSegments = true;
      }
    }
  }
  if (variants === 0 && !hasSegments) return null;
  return {
    kind: variants > 0 ? "master" : "media",
    variants,
    maxBandwidth,
    bestResolution,
    duration: duration > 0 ? Math.round(duration) : null,
  };
}
