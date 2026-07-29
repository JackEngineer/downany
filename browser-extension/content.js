/** Content script：扫描 DOM 中的多媒体地址并上报 background。 */

(function () {
  "use strict";

  const HTTP_RE = /^https?:\/\//i;
  const BLOB_RE = /^blob:/i;
  const META_PROPS = [
    "og:video",
    "og:video:url",
    "og:video:secure_url",
    "og:audio",
    "twitter:player:stream",
  ];

  let debounceTimer = null;
  let observer = null;

  function classifyUrl(url) {
    const lower = url.toLowerCase().split("?")[0];
    if (lower.includes(".m3u8")) return "hls";
    if (lower.includes(".mpd")) return "dash";
    if (/\.(mp3|m4a|aac|flac|ogg|wav)(\b|$)/i.test(lower)) return "audio";
    if (/\.(mp4|webm|mkv|mov|m4v)(\b|$)/i.test(lower)) return "file";
    return "media";
  }

  function pushCandidate(out, seen, url, source) {
    if (!url || typeof url !== "string") return;
    const trimmed = url.trim();
    if (!trimmed) return;
    if (BLOB_RE.test(trimmed)) {
      const key = `blob:${source}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({
        url: trimmed,
        type: "stream",
        source,
        blob: true,
      });
      return;
    }
    if (!HTTP_RE.test(trimmed)) return;
    if (seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push({
      url: trimmed,
      type: classifyUrl(trimmed),
      source,
      blob: false,
    });
  }

  function scanDom() {
    const out = [];
    const seen = new Set();

    document.querySelectorAll("video, audio").forEach((el) => {
      const current = el.currentSrc || el.src || "";
      pushCandidate(out, seen, current, "dom");
      el.querySelectorAll("source").forEach((src) => {
        pushCandidate(out, seen, src.src || src.getAttribute("src") || "", "dom");
      });
    });

    document.querySelectorAll("source[src]").forEach((src) => {
      const parent = src.parentElement;
      if (parent && (parent.tagName === "VIDEO" || parent.tagName === "AUDIO")) {
        return;
      }
      pushCandidate(out, seen, src.src || src.getAttribute("src") || "", "dom");
    });

    for (const prop of META_PROPS) {
      const meta = document.querySelector(
        `meta[property="${prop}"], meta[name="${prop}"]`,
      );
      if (meta) {
        pushCandidate(out, seen, meta.getAttribute("content") || "", "meta");
      }
    }

    return out;
  }

  function report() {
    const items = scanDom();
    try {
      chrome.runtime.sendMessage({
        type: "domMedia",
        pageUrl: location.href,
        pageTitle: document.title || "",
        items,
      });
    } catch {
      // extension context invalidated
    }
  }

  function scheduleReport() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(report, 300);
  }

  // ---- 正在播放的视频 → 关联其所属帖子/视频页 ----
  // X 时间线/搜索页播放视频时页面 URL 不变，但真实下载应走 yt-dlp
  // 的站点解析（直链签名易过期）。找到 video 所在卡片的详情链接上报。

  const VIDEO_PAGE_LINK_PATTERNS = [
    /\/status\/\d+/, // X / Twitter
    /\/watch\?v=/, // YouTube
    /\/video\/(BV\w+|\d+)/i, // Bilibili / 抖音
    /\/(p|reel|reels)\/[\w-]+/i, // Instagram
  ];

  const VIDEO_PAGE_HOST_RE =
    /(^|\.)(x\.com|twitter\.com|youtube\.com|bilibili\.com|douyin\.com|instagram\.com)$/i;

  /** 找到 video 所属的卡片，返回详情页链接与卡片内可读标题 */
  function findVideoCard(video) {
    if (!VIDEO_PAGE_HOST_RE.test(location.hostname)) return null;
    let container = video.closest("article");
    if (!container) {
      // 向上找包含详情链接的祖先（最多 6 层）
      let node = video.parentElement;
      for (let i = 0; i < 6 && node; i++) {
        if (
          node.querySelector(
            "a[href*='/status/'], a[href*='/watch'], a[href*='/video/'], a[href*='/reel/'], a[href*='/p/']",
          )
        ) {
          container = node;
          break;
        }
        node = node.parentElement;
      }
    }
    if (!container) {
      // 全屏 gallery 模式：X 点开视频后 URL 即变为 /status/{id}/photo/n
      if (/\/status\/\d+/.test(location.pathname)) {
        return {
          pageUrl: location.origin + location.pathname,
          title: document.title || "",
        };
      }
      return null;
    }

    let pageUrl = null;
    // 只取属于本层卡片的链接，排除嵌套引用推文里的 /status/ 链接
    const anchors = Array.from(container.querySelectorAll("a[href]")).filter(
      (a) => !a.closest("article") || a.closest("article") === container,
    );
    // 优先时间戳链接（指向本推文本身），再退回第一个匹配的链接
    const tsLink = anchors.find(
      (a) =>
        a.querySelector("time") &&
        /\/status\/\d+/.test(a.getAttribute("href") || ""),
    );
    const firstMatch = anchors.find((a) =>
      VIDEO_PAGE_LINK_PATTERNS.some((re) => re.test(a.getAttribute("href") || "")),
    );
    const chosen = tsLink || firstMatch;
    if (chosen) {
      pageUrl = new URL(chosen.getAttribute("href"), location.origin).href.split(
        "?",
      )[0];
    }
    if (!pageUrl) return null;

    // 卡片内可读标题：X 推文文本 → YouTube 标题 → 链接 title 属性
    // 同样排除嵌套引用块，避免与 pageUrl 错配
    let title = "";
    const ownTweetText = Array.from(
      container.querySelectorAll('[data-testid="tweetText"]'),
    ).find((t) => !t.closest("article") || t.closest("article") === container);
    if (ownTweetText && ownTweetText.textContent.trim()) {
      title = ownTweetText.textContent.trim();
    }
    if (!title) {
      const heading = container.querySelector("#video-title, h3, h2");
      if (heading && heading.textContent.trim()) {
        title = heading.textContent.trim();
      }
    }
    if (!title) {
      const titled = container.querySelector("a[title]");
      if (titled && titled.getAttribute("title").trim()) {
        title = titled.getAttribute("title").trim();
      }
    }

    return { pageUrl, title: title.slice(0, 120) };
  }

  const onPlay = (e) => {
    const v = e.target;
    if (
      typeof HTMLVideoElement !== "undefined" &&
      !(v instanceof HTMLVideoElement)
    ) {
      return;
    }
    const card = findVideoCard(v);
    if (!card) return;
    try {
      chrome.runtime.sendMessage({
        type: "activeVideoPage",
        pageUrl: card.pageUrl,
        title: card.title,
      });
    } catch {
      // extension context invalidated
    }
  };

  // play 触发最早（预加载/自动播放即报），playing 兜底
  document.addEventListener("play", onPlay, true);
  document.addEventListener("playing", onPlay, true);

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(() => scheduleReport());
    if (document.documentElement) {
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["src", "content"],
      });
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== "rescan") return false;
    const items = scanDom();
    sendResponse({
      pageUrl: location.href,
      pageTitle: document.title || "",
      items,
    });
    return false;
  });

  report();
  startObserver();
})();
