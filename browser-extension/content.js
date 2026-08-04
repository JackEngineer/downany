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
    findVideoCard,
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
    const card = findVideoCard(v, location, currentTitle);
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
