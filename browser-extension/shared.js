/** 共享常量与纯函数：background(importScripts) / content.js / popup 三端复用。 */
(function () {
  "use strict";
  // 幂等：content script 重复注入 / executeScript 兜底时不重复声明
  if (globalThis.VideoDlShared) return;

  /**
   * yt-dlp 原生支持的单视频页面：发页面链接让 yt-dlp 实时解析，
   * 标题/清晰度/签名都是最新的，远比有时效的直链可靠。
   * 匹配 hostname + pathname。
   */
  const YTDLP_PAGE_RES = [
    /(^|\.)(x\.com|twitter\.com)\/[^/]+\/status\/\d+/i,
    /(^|\.)youtube\.com\/watch/i,
    /(^|\.)youtu\.be\/[\w-]+/i,
    /(^|\.)bilibili\.com\/video\//i,
    /(^|\.)b23\.tv\/[\w-]+/i,
    /(^|\.)douyin\.com\/video\//i,
    /(^|\.)tiktok\.com\/@[^/]+\/video\//i,
    /(^|\.)instagram\.com\/(p|reel|reels)\//i,
  ];

  /** yt-dlp 有 extractor 的站点（空态提示用，范围比页面规则宽） */
  const YTDLP_FRIENDLY_HOST_RE =
    /(^|\.)(x\.com|twitter\.com|youtube\.com|youtu\.be|bilibili\.com|b23\.tv|douyin\.com|tiktok\.com|weibo\.com|weibo\.cn|instagram\.com|weixin\.qq\.com)$/i;

  const HTTP_RE = /^https?:\/\//i;

  const META_PROPS = [
    "og:video",
    "og:video:url",
    "og:video:secure_url",
    "og:audio",
    "twitter:player:stream",
  ];

  function isYtdlpPreferredPage(pageUrl) {
    try {
      const u = new URL(pageUrl);
      return YTDLP_PAGE_RES.some((re) => re.test(u.hostname + u.pathname));
    } catch {
      return false;
    }
  }

  function classifyUrl(url) {
    const lower = url.toLowerCase().split("?")[0];
    if (lower.includes(".m3u8")) return "hls";
    if (lower.includes(".mpd")) return "dash";
    if (/\.(mp3|m4a|aac|flac|ogg|wav)(\b|$)/i.test(lower)) return "audio";
    if (/\.(mp4|webm|mkv|mov|m4v)(\b|$)/i.test(lower)) return "file";
    return "media";
  }

  /**
   * DOM 媒体扫描（纯函数，SW 中仅定义不执行）。
   * blob: 地址不上报——background 无法利用，只会浪费消息。
   * @param {Document} doc
   * @returns {{url: string, type: string, source: string}[]}
   */
  function scanDom(doc) {
    const out = [];
    const seen = new Set();
    const push = (url, source) => {
      if (!url || typeof url !== "string") return;
      const trimmed = url.trim();
      if (!trimmed || !HTTP_RE.test(trimmed)) return;
      if (seen.has(trimmed)) return;
      seen.add(trimmed);
      out.push({ url: trimmed, type: classifyUrl(trimmed), source });
    };

    doc.querySelectorAll("video, audio").forEach((el) => {
      push(el.currentSrc || el.src || "", "dom");
      el.querySelectorAll("source").forEach((src) => {
        push(src.src || src.getAttribute("src") || "", "dom");
      });
    });

    doc.querySelectorAll("source[src]").forEach((src) => {
      const parent = src.parentElement;
      if (parent && (parent.tagName === "VIDEO" || parent.tagName === "AUDIO")) {
        return;
      }
      push(src.src || src.getAttribute("src") || "", "dom");
    });

    for (const prop of META_PROPS) {
      const meta = doc.querySelector(
        `meta[property="${prop}"], meta[name="${prop}"]`,
      );
      if (meta) push(meta.getAttribute("content") || "", "meta");
    }

    return out;
  }

  globalThis.VideoDlShared = {
    YTDLP_PAGE_RES,
    YTDLP_FRIENDLY_HOST_RE,
    isYtdlpPreferredPage,
    classifyUrl,
    scanDom,
  };
})();
