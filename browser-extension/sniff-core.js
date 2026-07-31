/** 纯媒体嗅探/清单解析：无 chrome.*，background(importScripts) 与 Node 单测复用。 */
(function () {
  "use strict";
  if (globalThis.VideoDlSniffCore) return;

  const HTTP_RE = /^https?:\/\/\S+/i;

  /** 完整媒体 / 清单；分片后缀丢弃 */
  const MEDIA_EXT_RE =
    /\.(m3u8|mpd|mp4|webm|mkv|mov|m4v|mp3|m4a|aac|flac|ogg|wav)(?:$|[?#])/i;
  const SEGMENT_EXT_RE = /\.(ts|m4s|cmfv|cmfa|cmft)(?:$|[?#])/i;
  const PLAYLIST_EXT_RE = /\.(m3u8|mpd)(?:$|[?#])/i;

  const MEDIA_CONTENT_TYPES = [
    "application/vnd.apple.mpegurl",
    "application/x-mpegurl",
    "application/dash+xml",
    "application/mpegurl",
    "video/",
    "audio/",
  ];

  /** 去重时忽略的常见易变参数（签名/缓存/分段） */
  const VOLATILE_PARAMS = [
    "range",
    "bytes",
    "start",
    "end",
    "_",
    "t",
    "rn",
    "r",
    "v",
  ];

  const DEFAULT_VERIFY_TIMEOUT_MS = 4000;

  function isHttpUrl(value) {
    return typeof value === "string" && HTTP_RE.test(value.trim());
  }

  /** 去重键：去掉常见签名 / range / 缓存参数 */
  function normalizeMediaKey(url) {
    try {
      const u = new URL(url);
      VOLATILE_PARAMS.forEach((k) => u.searchParams.delete(k));
      return u.origin + u.pathname + (u.search || "");
    } catch {
      return url.split("#")[0];
    }
  }

  function classifyByContentType(contentType) {
    if (!contentType) return null;
    const ct = contentType.toLowerCase().split(";")[0].trim();
    if (ct.includes("mpegurl") || ct.includes("m3u8")) return "hls";
    if (ct.includes("dash+xml")) return "dash";
    if (ct.startsWith("audio/")) return "audio";
    if (ct.startsWith("video/")) return "file";
    return null;
  }

  function isSegmentUrl(url) {
    return SEGMENT_EXT_RE.test(url);
  }

  function isPlaylistCandidate(url, type) {
    return type === "hls" || type === "dash" || PLAYLIST_EXT_RE.test(url);
  }

  function looksLikeMediaUrl(url) {
    if (!isHttpUrl(url) || isSegmentUrl(url)) return false;
    return MEDIA_EXT_RE.test(url);
  }

  function contentTypeLooksMedia(contentType) {
    if (!contentType) return false;
    const ct = contentType.toLowerCase();
    return MEDIA_CONTENT_TYPES.some((p) => ct.includes(p) || ct.startsWith(p));
  }

  /**
   * 同一视频的多清晰度清单归并键：
   * X 形如 /ext_tw_video/{id}/pu/pl/{宽}x{高}/x.m3u8 → 截到 /pl/ 前；
   * 通用：去掉文件名，若目录名是清晰度（720x1280 / 1080p）再去一级。
   */
  function playlistGroupKey(url) {
    try {
      const u = new URL(url);
      const p = u.pathname;
      const plIdx = p.indexOf("/pl/");
      if (plIdx > 0) return u.origin + p.slice(0, plIdx);
      const parts = p.split("/").filter(Boolean);
      if (parts.length >= 2) {
        const dir = parts[parts.length - 2];
        parts.pop();
        if (/^\d{3,4}x\d{3,4}$|^\d{3,4}p$/i.test(dir)) parts.pop();
        return u.origin + "/" + parts.join("/");
      }
      return u.origin + p;
    } catch {
      return url;
    }
  }

  function parseM3U8(text) {
    if (!text || !text.trimStart().startsWith("#EXTM3U")) return null;
    const lines = text.split(/\r?\n/);
    let variants = 0;
    let bestResolution = null;
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

  function parseMPD(text) {
    if (!text || !text.includes("<MPD")) return null;
    const m =
      /mediaPresentationDuration="PT(?:(\d+)H)?(?:(\d+)M)?([\d.]+)S?"/.exec(text);
    let duration = null;
    if (m) {
      duration = Math.round(
        parseInt(m[1] || "0", 10) * 3600 +
          parseInt(m[2] || "0", 10) * 60 +
          parseFloat(m[3] || "0"),
      );
    }
    const periods = (text.match(/<Period[\s>]/g) || []).length || 1;
    return { kind: "dash", variants: periods, duration, bestResolution: null };
  }

  async function fetchWithTimeout(
    url,
    options = {},
    timeoutMs = DEFAULT_VERIFY_TIMEOUT_MS,
  ) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 拉取并解析清单，验证其真实有效；失败（404/403/超时/内容非清单）返回 null。
   */
  async function enrichPlaylist(url, pageUrl, timeoutMs) {
    try {
      const headers = {};
      if (pageUrl) headers.Referer = pageUrl;
      const res = await fetchWithTimeout(
        url,
        { headers, credentials: "include" },
        timeoutMs,
      );
      if (!res.ok) return null;
      const text = await res.text();
      const ct = res.headers.get("content-type") || "";
      if (PLAYLIST_EXT_RE.test(url) && url.toLowerCase().includes(".mpd")) {
        return parseMPD(text);
      }
      if (ct.includes("dash+xml")) return parseMPD(text);
      return parseM3U8(text);
    } catch {
      return null;
    }
  }

  /**
   * 用 Range 请求验证文件 URL 有效且确为媒体，并尝试取总大小。
   */
  async function verifyFileUrl(url, pageUrl, timeoutMs) {
    try {
      const headers = { Range: "bytes=0-0" };
      if (pageUrl) headers.Referer = pageUrl;
      const res = await fetchWithTimeout(
        url,
        { headers, credentials: "include" },
        timeoutMs,
      );
      if (!res.ok && res.status !== 206) return null;
      const ct = res.headers.get("content-type") || "";
      if (!contentTypeLooksMedia(ct)) {
        void res.body?.cancel().catch(() => {});
        return null;
      }
      let size = null;
      const cr = res.headers.get("content-range");
      if (cr) {
        const m = /\/(\d+)\s*$/.exec(cr);
        if (m) size = parseInt(m[1], 10);
      }
      if (size == null) {
        const cl = parseInt(res.headers.get("content-length") || "", 10);
        if (!Number.isNaN(cl) && res.status === 200) size = cl;
      }
      void res.body?.cancel().catch(() => {});
      return { size };
    } catch {
      return null;
    }
  }

  globalThis.VideoDlSniffCore = {
    DEFAULT_VERIFY_TIMEOUT_MS,
    isHttpUrl,
    normalizeMediaKey,
    classifyByContentType,
    isSegmentUrl,
    isPlaylistCandidate,
    looksLikeMediaUrl,
    contentTypeLooksMedia,
    playlistGroupKey,
    parseM3U8,
    parseMPD,
    enrichPlaylist,
    verifyFileUrl,
  };
})();
