/** Content script：扫描 DOM 中的多媒体地址并上报 background。 */

(function () {
  "use strict";

  // shared.js 由 manifest content_scripts 先行注入
  const {
    scanDom,
    extractDouyinVideoId,
    normalizeYtdlpPageUrl,
    extractVisibleTitle,
    isWeakPageTitle,
    isInstagramPostUrl,
    pickPageThumbnail,
  } = globalThis.VideoDlShared;

  let debounceTimer = null;
  let observer = null;
  let lastHref = location.href;
  /** @type {ReturnType<typeof setTimeout>[]} */
  let igTitleRetryTimers = [];

  function currentTitle() {
    const extracted = extractVisibleTitle(document, location.href);
    if (extracted) return extracted;
    const docTitle = (document.title || "").trim();
    if (isWeakPageTitle(docTitle)) return "";
    return docTitle;
  }

  function clearIgTitleRetries() {
    for (const t of igTitleRetryTimers) clearTimeout(t);
    igTitleRetryTimers = [];
  }

  function reportActiveVideoPage(pageUrl, title) {
    try {
      chrome.runtime.sendMessage({
        type: "activeVideoPage",
        pageUrl,
        title: title || "",
      });
    } catch {
      // ignore
    }
  }

  function scheduleInstagramTitleRefresh(href) {
    clearIgTitleRetries();
    // SPA 切 Reel：DOM/og 常滞后，延迟补报标题
    for (const ms of [400, 1000, 2000]) {
      const timer = setTimeout(() => {
        if (location.href !== href) return;
        reportActiveVideoPage(normalizeYtdlpPageUrl(href), currentTitle());
        scheduleReport();
      }, ms);
      igTitleRetryTimers.push(timer);
    }
  }

  function report() {
    const items = scanDom(document);
    try {
      chrome.runtime.sendMessage({
        type: "domMedia",
        pageUrl: location.href,
        pageTitle: currentTitle(),
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

  function notifyNavigation() {
    const href = location.href;
    if (href === lastHref) return;
    lastHref = href;
    const title = currentTitle();
    try {
      chrome.runtime.sendMessage({
        type: "pageNavigated",
        pageUrl: href,
        pageTitle: title,
      });
    } catch {
      return;
    }
    const douyinId = extractDouyinVideoId(href);
    if (douyinId) {
      reportActiveVideoPage(normalizeYtdlpPageUrl(href), title);
    } else if (isInstagramPostUrl(href)) {
      reportActiveVideoPage(normalizeYtdlpPageUrl(href), title);
      scheduleInstagramTitleRefresh(href);
    }
    scheduleReport();
  }

  // SPA：抖音精选切 modal_id 不走完整刷新，需挂钩 history
  const origPushState = history.pushState;
  history.pushState = function (...args) {
    origPushState.apply(this, args);
    notifyNavigation();
  };
  const origReplaceState = history.replaceState;
  history.replaceState = function (...args) {
    origReplaceState.apply(this, args);
    notifyNavigation();
  };
  window.addEventListener("popstate", notifyNavigation);
  // 部分站点改 URL 不走 history API：短轮询兜底
  setInterval(notifyNavigation, 800);

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

    // 抖音精选/发现 modal：URL 上的 modal_id 即当前视频
    const douyinId = extractDouyinVideoId(location.href);
    if (douyinId) {
      return {
        pageUrl: normalizeYtdlpPageUrl(location.href),
        title: currentTitle(),
      };
    }

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
      // 全屏 gallery 模式：X 点开视频后 URL 即变为 /status/{id}/photo/n，
      // 去掉媒体序号尾巴，还原成可解析的详情页地址
      if (/\/status\/\d+/.test(location.pathname)) {
        const cleanPath = location.pathname.replace(
          /\/(photo|video)\/\d+$/,
          "",
        );
        return {
          pageUrl: location.origin + cleanPath,
          title: currentTitle(),
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
    if (!title) title = currentTitle();

    return { pageUrl, title: title.slice(0, 160) };
  }

  // 节流：同一详情页 1 秒内只上报一次（play/playing/seek 会频繁触发）
  let lastReportUrl = "";
  let lastReportAt = 0;

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
    const now = Date.now();
    if (card.pageUrl === lastReportUrl && now - lastReportAt < 1000) return;
    lastReportUrl = card.pageUrl;
    lastReportAt = now;
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
    if (!message) return false;
    if (message.type === "pageThumbnail") {
      sendResponse({
        thumbnail_url: pickPageThumbnail(document) || "",
        pageUrl: location.href,
        pageTitle: currentTitle(),
      });
      return false;
    }
    if (message.type !== "rescan") return false;
    sendResponse({
      pageUrl: location.href,
      pageTitle: currentTitle(),
      thumbnail_url: pickPageThumbnail(document) || "",
      items: scanDom(document),
    });
    return false;
  });

  report();
  startObserver();
  // 首次也同步一次导航态（刷新后恢复 modal / Reel 场景）
  try {
    const href = location.href;
    const douyinId = extractDouyinVideoId(href);
    if (douyinId || isInstagramPostUrl(href)) {
      chrome.runtime.sendMessage({
        type: "pageNavigated",
        pageUrl: href,
        pageTitle: currentTitle(),
      });
      reportActiveVideoPage(normalizeYtdlpPageUrl(href), currentTitle());
      if (isInstagramPostUrl(href)) {
        scheduleInstagramTitleRefresh(href);
      }
    }
  } catch {
    // ignore
  }
})();
