/** 共享常量与纯函数：background(importScripts) / content.js / popup 三端复用。 */
(function () {
  "use strict";
  // 幂等：content script 重复注入 / executeScript 兜底时不重复声明
  if (globalThis.VideoDlShared) return;

  /**
   * yt-dlp 原生支持的单视频页面：发页面链接让 yt-dlp 实时解析，
   * 标题/清晰度/签名都是最新的，远比有时效的直链可靠。
   * 匹配 hostname + pathname（抖音 modal_id 另见 extractDouyinVideoId）。
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
    /(^|\.)pornhub\.com\/view_video\.php/i,
  ];

  /** yt-dlp 有 extractor 的站点（空态提示用，范围比页面规则宽） */
  const YTDLP_FRIENDLY_HOST_RE =
    /(^|\.)(x\.com|twitter\.com|youtube\.com|youtu\.be|bilibili\.com|b23\.tv|douyin\.com|tiktok\.com|weibo\.com|weibo\.cn|instagram\.com|weixin\.qq\.com|pornhub\.com|xiaohongshu\.com|xhslink\.com)$/i;

  const HTTP_RE = /^https?:\/\//i;

  const META_PROPS = [
    "og:video",
    "og:video:url",
    "og:video:secure_url",
    "og:audio",
    "twitter:player:stream",
  ];

  /** 从抖音页提取 aweme id：/video/{id} 或 ?modal_id= */
  function extractDouyinVideoId(pageUrl) {
    try {
      const u = new URL(pageUrl);
      const host = u.hostname.toLowerCase();
      if (host !== "douyin.com" && !host.endsWith(".douyin.com")) return null;
      if (host === "v.douyin.com") return null;
      const pathMatch = u.pathname.match(/\/video\/(\d+)/i);
      if (pathMatch) return pathMatch[1];
      const modal = u.searchParams.get("modal_id");
      if (modal && /^\d+$/.test(modal)) return modal;
      return null;
    } catch {
      return null;
    }
  }

  /**
   * 把可归一的页面改写成 yt-dlp 最稳妥的规范 URL。
   * 目前：抖音 jingxuan/discover/?modal_id= → /video/{id}
   */
  function normalizeYtdlpPageUrl(pageUrl) {
    const douyinId = extractDouyinVideoId(pageUrl);
    if (douyinId) return `https://www.douyin.com/video/${douyinId}`;
    return pageUrl;
  }

  /** 同一「可下载视频」标识：抖音用 aweme id，其它用归一化 URL。 */
  function videoIdentityKey(pageUrl) {
    const douyinId = extractDouyinVideoId(pageUrl);
    if (douyinId) return `douyin:${douyinId}`;
    try {
      if (isYtdlpPreferredPage(pageUrl)) {
        return `page:${normalizeYtdlpPageUrl(pageUrl)}`;
      }
      const u = new URL(pageUrl);
      return `path:${u.origin}${u.pathname}`;
    } catch {
      return `raw:${pageUrl || ""}`;
    }
  }

  /**
   * 与弹窗 collapse 一致的展示条数：同一页面解析视频只算 1。
   * @param {{pageUrl?: string, url?: string}[]} items
   */
  function countDisplayMedia(items) {
    if (!items || items.length === 0) return 0;
    const seen = new Set();
    let n = 0;
    for (const item of items) {
      const page = (item && (item.pageUrl || item.url)) || "";
      if (page && isYtdlpPreferredPage(page)) {
        const key = videoIdentityKey(page);
        if (seen.has(key)) continue;
        seen.add(key);
        n += 1;
        continue;
      }
      n += 1;
    }
    return n;
  }

  /**
   * 站点名 / yt-dlp 占位标题，不适合直接展示。
   * @param {string} title
   */
  function isWeakPageTitle(title) {
    const text = (title || "").trim();
    if (!text) return true;
    const lower = text.toLowerCase();
    if (
      lower === "instagram" ||
      lower === "instagram reels" ||
      lower === "reels" ||
      lower === "pornhub" ||
      lower === "youtube" ||
      lower === "bilibili" ||
      lower === "抖音" ||
      lower === "tiktok" ||
      lower === "x" ||
      lower === "twitter" ||
      lower === "home / x" ||
      /\/ x$/i.test(text)
    ) {
      return true;
    }
    if (/^video by\s+\S+$/i.test(text)) return true;
    return false;
  }

  /**
   * Instagram og:title 常为 `user on Instagram: "caption"`。
   * @param {string} text
   */
  function unwrapInstagramOgTitle(text) {
    const raw = (text || "").trim();
    if (!raw) return "";
    const m = raw.match(/^.+?\s+on\s+Instagram:\s*(.+)$/i);
    if (!m || !m[1]) return raw;
    let cap = m[1].trim();
    const q = cap[0];
    if (
      (q === '"' || q === "'" || q === "\u201c") &&
      cap.length >= 2 &&
      (cap.endsWith('"') || cap.endsWith("'") || cap.endsWith("\u201d"))
    ) {
      cap = cap.slice(1, -1).trim();
    }
    return cap || raw;
  }

  function isInstagramPostUrl(pageUrl) {
    try {
      const u = new URL(pageUrl);
      const host = u.hostname.toLowerCase();
      if (host !== "instagram.com" && !host.endsWith(".instagram.com")) {
        return false;
      }
      return /\/(p|reel|reels)\/[\w-]+/i.test(u.pathname);
    } catch {
      return false;
    }
  }

  /** Instagram /p|reel|reels/{shortcode}/ */
  function extractInstagramShortcode(pageUrl) {
    try {
      const u = new URL(pageUrl);
      const host = u.hostname.toLowerCase();
      if (host !== "instagram.com" && !host.endsWith(".instagram.com")) {
        return null;
      }
      const m = u.pathname.match(/\/(?:p|reel|reels)\/([\w-]+)/i);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  }

  function metaContent(doc, selector) {
    if (!doc || !doc.querySelector) return "";
    const el = doc.querySelector(selector);
    if (!el || typeof el.getAttribute !== "function") return "";
    const v = el.getAttribute("content");
    return (v || "").trim();
  }

  /**
   * Instagram SPA 切 Reel 时 og:* 常滞后；仅当 og:url 含当前 shortcode 才采信。
   */
  function instagramOgMatchesPage(doc, pageUrl) {
    const shortcode = extractInstagramShortcode(pageUrl);
    if (!shortcode) return false;
    const ogUrl = metaContent(doc, 'meta[property="og:url"]');
    if (!ogUrl) return false;
    try {
      return extractInstagramShortcode(ogUrl) === shortcode;
    } catch {
      return ogUrl.includes(shortcode);
    }
  }

  /** 优先从含当前 shortcode 的卡片/链接附近取可见文案。 */
  function extractInstagramDomCaption(doc, pageUrl) {
    const shortcode = extractInstagramShortcode(pageUrl);
    if (!shortcode || !doc || !doc.querySelector) return "";

    const link =
      doc.querySelector(
        `a[href*="/reel/${shortcode}"], a[href*="/reels/${shortcode}"], a[href*="/p/${shortcode}"]`,
      ) || null;
    const root =
      (link && (link.closest("article") || link.closest("section") || link.parentElement)) ||
      null;

    const scopes = root ? [root, doc] : [doc];
    const capSelectors = [
      'h1[dir="auto"]',
      'span[dir="auto"]',
      "h1",
      'div[role="menuitem"] span',
    ];
    for (const scope of scopes) {
      if (!scope || !scope.querySelector) continue;
      for (const sel of capSelectors) {
        const nodes = scope.querySelectorAll
          ? scope.querySelectorAll(sel)
          : [];
        for (const el of nodes) {
          const text = el && el.textContent ? el.textContent.trim() : "";
          if (text.length >= 2 && !isWeakPageTitle(text) && text.length <= 300) {
            // 用户名一行往往很短且无空格 hashtag；文案优先更长的
            if (text.length >= 4) return text.slice(0, 160);
          }
        }
      }
      // 单节点 querySelector 兜底（简易 Document mock）
      if (!scope.querySelectorAll) {
        for (const sel of capSelectors) {
          const el = scope.querySelector(sel);
          const text = el && el.textContent ? el.textContent.trim() : "";
          if (text.length >= 2 && !isWeakPageTitle(text)) {
            return text.slice(0, 160);
          }
        }
      }
    }
    return "";
  }

  /**
   * 从当前文档提取更靠谱的展示标题（抖音 / Instagram 文案优先于站点 document.title）。
   * @param {Document} doc
   * @param {string} [pageUrl]
   */
  function extractVisibleTitle(doc, pageUrl) {
    const href = pageUrl || (typeof location !== "undefined" ? location.href : "");
    if (extractDouyinVideoId(href) && doc) {
      const selectors = [
        '[data-e2e="browse-video-desc"]',
        '[data-e2e="video-desc"]',
        '[data-e2e="video-desc-content"]',
        '[data-e2e="aweme-title"]',
        '[data-e2e="detail-video-desc"]',
        ".video-info-detail .title",
        ".video-info-detail h1",
      ];
      for (const sel of selectors) {
        const el = doc.querySelector(sel);
        const text = el && el.textContent ? el.textContent.trim() : "";
        if (text.length >= 2 && !/^抖音/.test(text)) {
          return text.slice(0, 160);
        }
      }
      const ogTitle = metaContent(doc, 'meta[property="og:title"]');
      if (ogTitle && !/^抖音/.test(ogTitle) && !isWeakPageTitle(ogTitle)) {
        return ogTitle.slice(0, 160);
      }
    }

    if (isInstagramPostUrl(href) && doc) {
      // 1) 当前 shortcode 相关 DOM（SPA 切页后比 og 新）
      const domCap = extractInstagramDomCaption(doc, href);
      if (domCap) return domCap;

      // 2) 仅当 og:url 已切到当前 shortcode 才用 meta（避免上一条残留）
      if (instagramOgMatchesPage(doc, href)) {
        const ogTitle = unwrapInstagramOgTitle(
          metaContent(doc, 'meta[property="og:title"]'),
        );
        if (ogTitle && !isWeakPageTitle(ogTitle)) {
          return ogTitle.slice(0, 160);
        }
        const ogDesc = metaContent(doc, 'meta[property="og:description"]');
        if (ogDesc && !isWeakPageTitle(ogDesc)) {
          return ogDesc.slice(0, 160);
        }
        const nameDesc = metaContent(doc, 'meta[name="description"]');
        if (nameDesc && !isWeakPageTitle(nameDesc)) {
          return nameDesc.slice(0, 160);
        }
      }
      return "";
    }

    const pageTitle = (doc && doc.title) || "";
    return isWeakPageTitle(pageTitle) ? "" : pageTitle;
  }

  function isYtdlpPreferredPage(pageUrl) {
    try {
      if (extractDouyinVideoId(pageUrl)) return true;
      const u = new URL(pageUrl);
      return YTDLP_PAGE_RES.some((re) => re.test(u.hostname + u.pathname));
    } catch {
      return false;
    }
  }

  /** X/Twitter 视频 CDN（时间线嗅探到的多为 HLS m3u8） */
  function isTwitterMediaCdn(url) {
    try {
      const h = new URL(url).hostname.toLowerCase();
      if (h === "video.twimg.com" || h.endsWith(".video.twimg.com")) return true;
      if (h === "ton.twimg.com") return true;
      if (
        h.endsWith(".twimg.com") &&
        /\/(amplify_video|ext_tw_video|tweet_video|pu\/vid)\//i.test(url)
      ) {
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * 主页/时间线上的 twimg 直链若未挂到 /status/{id}，不要当独立下载项展示：
   * 会变成无文案的 HLS 文件名列表；应等播放关联详情页后再以「页面解析」收录。
   */
  function isOrphanTwitterCdn(mediaUrl, pageUrl) {
    if (!isTwitterMediaCdn(mediaUrl)) return false;
    return !isYtdlpPreferredPage(pageUrl || "");
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

  /**
   * 从当前文档挑一张可用封面（video.poster / 站点 CDN 图 / 非占位 og:image）。
   * 小红书等站 yt-dlp 页面解析常失败时，扩展侧封面是主要来源。
   * @param {Document} doc
   * @returns {string}
   */
  function pickPageThumbnail(doc) {
    if (!doc) return "";
    try {
      const videos = doc.querySelectorAll("video");
      for (const v of videos) {
        const poster = String(v.poster || "").trim();
        if (poster && HTTP_RE.test(poster)) return poster;
      }

      let best = "";
      let bestArea = -1;
      for (const img of doc.querySelectorAll("img[src]")) {
        const src = String(img.currentSrc || img.src || "").trim();
        if (!src || !HTTP_RE.test(src)) continue;
        if (!/(xhscdn|sns-webpic|xiaohongshu\.com\/.*\.(jpg|jpeg|png|webp))/i.test(src)) {
          continue;
        }
        if (/avatar|icon|logo|emoji|picasso-static|fe-platform/i.test(src)) continue;
        const w = Number(img.naturalWidth || img.width || 0) || 0;
        const h = Number(img.naturalHeight || img.height || 0) || 0;
        const area = w * h;
        if (area >= bestArea) {
          bestArea = area;
          best = src;
        }
      }
      if (best) return best;

      const og = doc.querySelector(
        'meta[property="og:image"], meta[name="og:image"]',
      );
      let ogUrl = og ? String(og.getAttribute("content") || "").trim() : "";
      if (ogUrl.startsWith("//")) ogUrl = "https:" + ogUrl;
      if (
        ogUrl &&
        HTTP_RE.test(ogUrl) &&
        !/picasso-static|fe-platform/i.test(ogUrl)
      ) {
        return ogUrl;
      }
    } catch {
      // ignore
    }
    return "";
  }

  globalThis.VideoDlShared = {
    YTDLP_PAGE_RES,
    YTDLP_FRIENDLY_HOST_RE,
    extractDouyinVideoId,
    normalizeYtdlpPageUrl,
    videoIdentityKey,
    countDisplayMedia,
    extractVisibleTitle,
    isWeakPageTitle,
    unwrapInstagramOgTitle,
    extractInstagramShortcode,
    isInstagramPostUrl,
    isYtdlpPreferredPage,
    isTwitterMediaCdn,
    isOrphanTwitterCdn,
    classifyUrl,
    scanDom,
    pickPageThumbnail,
  };
})();
