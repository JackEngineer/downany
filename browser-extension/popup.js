/** Popup：展示嗅探到的媒体列表，勾选后发送到下载器。 */

// shared.js 由 popup.html 先行引入
const {
  isYtdlpPreferredPage,
  normalizeYtdlpPageUrl,
  YTDLP_FRIENDLY_HOST_RE,
  isWeakPageTitle,
} = globalThis.VideoDlShared;

const HTTP_RE = /^https?:\/\/\S+/i;

const titleEl = document.getElementById("title");
const urlEl = document.getElementById("url");
const thumbEl = document.getElementById("thumb");
const statusEl = document.getElementById("status");
const countEl = document.getElementById("count");
const mediaListEl = document.getElementById("mediaList");
const emptyEl = document.getElementById("empty");
const toolbarEl = document.getElementById("toolbar");
const enqueueBtn = document.getElementById("enqueue");
const enqueuePageBtn = document.getElementById("enqueuePage");
const selectAllBtn = document.getElementById("selectAll");
const selectNoneBtn = document.getElementById("selectNone");

let currentUrl = "";
let currentTitle = "";
let currentTabId = null;
/** @type {Array<{url: string, type: string, source: string, size: number|null, pageUrl: string, pageTitle: string}>} */
let mediaItems = [];
/** @type {Set<string>} */
const selected = new Set();

function isHttpUrl(value) {
  return typeof value === "string" && HTTP_RE.test(value.trim());
}

function setStatus(kind, text) {
  if (!text) {
    statusEl.hidden = true;
    statusEl.textContent = "";
    statusEl.className = "status";
    return;
  }
  statusEl.hidden = false;
  statusEl.textContent = text;
  statusEl.className = `status ${kind}`;
}

function renderThumb(favIconUrl) {
  thumbEl.classList.remove("has-icon");
  thumbEl.style.backgroundImage = "";
  if (!favIconUrl) return;
  thumbEl.classList.add("has-icon");
  thumbEl.style.backgroundImage = `url("${favIconUrl}")`;
}

function formatSize(bytes) {
  if (bytes == null || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDuration(sec) {
  if (!sec || sec <= 0) return "";
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  }
  return `${m}:${String(r).padStart(2, "0")}`;
}

function displayName(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    const last = parts[parts.length - 1] || u.hostname;
    return decodeURIComponent(last).slice(0, 80);
  } catch {
    return url.slice(0, 80);
  }
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function typeLabel(type) {
  switch (type) {
    case "hls":
      return "HLS";
    case "dash":
      return "DASH";
    case "file":
      return "MP4";
    case "audio":
      return "音频";
    case "page":
      return "页面";
    default:
      return "媒体";
  }
}

function emptyHintFor(url) {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return "未检测到媒体流。请先在页面中播放视频，再打开本弹窗。";
  }
  if (YTDLP_FRIENDLY_HOST_RE.test(host)) {
    return (
      "未检测到媒体流：该站视频只有播放后才会发出流请求。\n" +
      "请先播放页面中的视频再打开本弹窗；或直接点下方「下载本页视频 / 仅发送页面链接」，交给 yt-dlp 解析（会带上登录态）。"
    );
  }
  return "未检测到媒体流。请先在页面中播放视频再打开本弹窗；或尝试「下载本页视频 / 仅发送页面链接」。";
}

function updateEnqueueButton() {
  const n = selected.size;
  enqueueBtn.disabled = n === 0 || !isHttpUrl(currentUrl);
  enqueueBtn.textContent = n > 0 ? `下载选中 (${n})` : "下载选中";
}

function renderMediaList() {
  mediaListEl.innerHTML = "";
  const has = mediaItems.length > 0;
  mediaListEl.hidden = !has;
  toolbarEl.hidden = !has;
  emptyEl.hidden = has;
  if (!has) {
    emptyEl.textContent = emptyHintFor(currentUrl);
  }
  countEl.textContent = has ? `检测到 ${mediaItems.length} 个` : "";

  for (const item of mediaItems) {
    const li = document.createElement("li");
    li.className = "media-item";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = selected.has(item.url);
    cb.addEventListener("change", () => {
      if (cb.checked) selected.add(item.url);
      else selected.delete(item.url);
      updateEnqueueButton();
    });

    const body = document.createElement("div");
    body.className = "media-body";

    const row = document.createElement("div");
    row.className = "media-row";

    const badge = document.createElement("span");
    badge.className = `badge ${item.type || "media"}`;
    badge.textContent = typeLabel(item.type);

    const meta = document.createElement("span");
    meta.className = "media-size";
    const bits = [];
    if (item.duration) bits.push(formatDuration(item.duration));
    if (item.variants > 1) bits.push(`${item.variants} 个清晰度`);
    if (item.enrichKind === "master") bits.push("多码率");
    // 页面解析条目的 CDN 嗅探体积不能代表最终下载大小，避免显示 700KB 误导
    if (item.type !== "page" && item.size) bits.push(formatSize(item.size));
    meta.textContent = bits.join(" · ");

    row.appendChild(badge);

    const pageUrl = item.pageUrl || currentUrl;
    if (item.nowPlaying) {
      const npBadge = document.createElement("span");
      npBadge.className = "badge playing";
      npBadge.textContent = "正在播放";
      row.appendChild(npBadge);
    } else if (item.type === "page" || (pageUrl && isYtdlpPreferredPage(pageUrl))) {
      const pageBadge = document.createElement("span");
      pageBadge.className = "badge page";
      pageBadge.textContent = "页面解析";
      row.appendChild(pageBadge);
    }

    if (meta.textContent) row.appendChild(meta);

    const name = document.createElement("p");
    name.className = "media-name";
    const candidates = [item.title, item.pageTitle, currentTitle];
    let shown = "";
    for (const c of candidates) {
      if (c && !isWeakPageTitle(c)) {
        shown = c;
        break;
      }
    }
    name.textContent = shown || displayName(item.url);
    name.title = item.pageUrl || item.url;

    const host = document.createElement("p");
    host.className = "media-host";
    if (item.type === "page") {
      host.textContent = "将由下载器解析完整视频";
    } else if (item.title) {
      host.textContent = `${hostOf(item.url)} · ${displayName(item.url)}`;
    } else {
      host.textContent = hostOf(item.url);
    }

    body.appendChild(row);
    body.appendChild(name);
    body.appendChild(host);

    li.appendChild(cb);
    li.appendChild(body);
    li.addEventListener("click", (e) => {
      if (e.target === cb) return;
      cb.checked = !cb.checked;
      if (cb.checked) selected.add(item.url);
      else selected.delete(item.url);
      updateEnqueueButton();
    });

    mediaListEl.appendChild(li);
  }

  updateEnqueueButton();
}

/** 把扫描结果转发给 background 入库；并返回页面元数据供弹窗刷新标题 */
async function forwardScan(tabId, payload) {
  if (payload && Array.isArray(payload.items) && payload.items.length > 0) {
    await chrome.runtime.sendMessage({
      type: "domMedia",
      tabId,
      pageUrl: payload.pageUrl,
      pageTitle: payload.pageTitle,
      items: payload.items,
    });
  }
  return payload || null;
}

async function rescanTab(tabId) {
  // 优先走已注入的 content script；扩展重载前的旧页面没有它，再临时注入扫描
  try {
    const payload = await chrome.tabs.sendMessage(tabId, { type: "rescan" });
    return await forwardScan(tabId, payload);
  } catch {
    // content script 未注入，走临时注入兜底
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["shared.js"],
    });
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        pageUrl: location.href,
        pageTitle: globalThis.VideoDlShared.extractVisibleTitle(
          document,
          location.href,
        ),
        items: globalThis.VideoDlShared.scanDom(document),
      }),
    });
    return await forwardScan(tabId, results && results[0] && results[0].result);
  } catch {
    return null;
  }
}

/**
 * 展示层合并：同一详情页（yt-dlp 页面解析）的多条直链只显示一条，
 * 并改写成「页面」条目（避免显示 CDN 哈希名 / 预览片体积）。
 */
function collapseItems(items) {
  const byPage = new Map();
  const out = [];
  for (const item of items) {
    if (item.pageUrl && isYtdlpPreferredPage(item.pageUrl)) {
      const pageKey = normalizeYtdlpPageUrl(item.pageUrl);
      const prev = byPage.get(pageKey);
      if (prev) {
        if (!prev.duration && item.duration) prev.duration = item.duration;
        if ((!prev.variants || prev.variants <= 1) && item.variants > 1) {
          prev.variants = item.variants;
        }
        // 同页多条候选：只在还没有靠谱标题时补齐，避免后到的弱/短标题盖掉推文正文
        if (!prev.title || isWeakPageTitle(prev.title)) {
          if (item.title && !isWeakPageTitle(item.title)) {
            prev.title = item.title;
          } else if (!prev.title && item.title) {
            prev.title = item.title;
          } else if (item.pageTitle && !isWeakPageTitle(item.pageTitle)) {
            prev.title = item.pageTitle;
          } else if (!prev.title && item.pageTitle) {
            prev.title = item.pageTitle;
          }
        }
        continue;
      }
      const pageItem = {
        ...item,
        url: pageKey,
        type: "page",
        pageUrl: pageKey,
        title: item.title || item.pageTitle || "",
        size: null,
      };
      byPage.set(pageKey, pageItem);
      out.push(pageItem);
      continue;
    }
    out.push(item);
  }
  return out;
}

/** 选体积最大的候选；无 size 时退回第一条。 */
function pickLargestItem(items) {
  if (!items || items.length === 0) return null;
  let best = items[0];
  let bestSize = typeof best.size === "number" ? best.size : -1;
  for (let i = 1; i < items.length; i++) {
    const s = typeof items[i].size === "number" ? items[i].size : -1;
    if (s > bestSize) {
      best = items[i];
      bestSize = s;
    }
  }
  return best;
}

async function loadMedia(tabId, { preserveSelection = false } = {}) {
  const result = await chrome.runtime.sendMessage({
    type: "getMedia",
    tabId,
  });
  const nowPlaying = result && result.nowPlaying;
  mediaItems = collapseItems((result && result.items) || []);

  // 「正在播放」快捷条目：由 play 事件直供，永远新鲜可下，置顶展示
  if (nowPlaying && isHttpUrl(nowPlaying.url)) {
    const playingKey = normalizeYtdlpPageUrl(nowPlaying.url);
    let merged = false;
    for (const m of mediaItems) {
      const mKey = normalizeYtdlpPageUrl(m.pageUrl || m.url);
      if (mKey === playingKey || m.url === nowPlaying.url) {
        m.nowPlaying = true;
        if (nowPlaying.title && !isWeakPageTitle(nowPlaying.title)) {
          m.title = nowPlaying.title;
        } else if (!m.title && nowPlaying.title) {
          m.title = nowPlaying.title;
        }
        merged = true;
      }
    }
    if (!merged) {
      mediaItems.unshift({
        url: playingKey,
        type: "page",
        source: "playing",
        size: null,
        pageUrl: playingKey,
        pageTitle: currentTitle,
        title: nowPlaying.title || currentTitle || "正在播放的视频",
        nowPlaying: true,
        detectedAt: nowPlaying.at || Date.now(),
      });
    }
  }

  if (!preserveSelection) {
    selected.clear();
    // 默认选中「正在播放」，否则体积最大的（避开抖音 1MB 预览片）
    const first =
      mediaItems.find((m) => m.nowPlaying) || pickLargestItem(mediaItems);
    if (first) selected.add(first.url);
  } else {
    const urls = new Set(mediaItems.map((m) => m.url));
    for (const u of Array.from(selected)) {
      if (!urls.has(u)) selected.delete(u);
    }
  }
  renderMediaList();
}

async function loadActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab) {
    titleEl.textContent = "无法读取当前标签页";
    urlEl.textContent = "";
    enqueueBtn.disabled = true;
    enqueuePageBtn.disabled = true;
    setStatus("error", "请打开一个网页后再试");
    return;
  }

  currentTabId = tab.id;
  currentUrl = (tab.url || "").trim();
  currentTitle = (tab.title || "").trim();
  if (isWeakPageTitle(currentTitle)) currentTitle = "";
  titleEl.textContent = currentTitle || hostOf(currentUrl) || "未命名页面";
  urlEl.textContent = currentUrl || "（无地址）";
  urlEl.title = currentUrl;
  renderThumb(tab.favIconUrl || "");

  if (!isHttpUrl(currentUrl)) {
    enqueueBtn.disabled = true;
    enqueuePageBtn.disabled = true;
    emptyEl.hidden = false;
    emptyEl.textContent = "当前页不是 http(s) 链接，无法识别媒体";
    setStatus("error", "当前页不是 http(s) 链接，无法发送");
    return;
  }

  enqueuePageBtn.disabled = false;
  // yt-dlp 原生支持的页面：页面链接是最可靠的下载方式，作为主推荐
  if (isYtdlpPreferredPage(currentUrl)) {
    enqueuePageBtn.textContent = "下载本页视频（推荐）";
    enqueuePageBtn.classList.add("recommended");
  } else {
    enqueuePageBtn.textContent = "仅发送页面链接";
    enqueuePageBtn.classList.remove("recommended");
  }
  setStatus("", "");

  if (typeof currentTabId === "number") {
    const live = await rescanTab(currentTabId);
    // 优先用页面实时标题 / URL（抖音 SPA 的 tab.title 常常滞后）
    if (live && live.pageUrl) {
      currentUrl = live.pageUrl;
      urlEl.textContent = currentUrl;
      urlEl.title = currentUrl;
    }
    if (live && live.pageTitle && live.pageTitle.trim() && !isWeakPageTitle(live.pageTitle)) {
      currentTitle = live.pageTitle.trim();
      titleEl.textContent = currentTitle;
    }
    if (isYtdlpPreferredPage(currentUrl)) {
      enqueuePageBtn.textContent = "下载本页视频（推荐）";
      enqueuePageBtn.classList.add("recommended");
    }
    await loadMedia(currentTabId);
    // 候选需经有效性验证后才入列，延迟补拉两次（保留勾选）
    setTimeout(() => {
      if (currentTabId != null) {
        void loadMedia(currentTabId, { preserveSelection: true });
      }
    }, 1500);
    setTimeout(() => {
      if (currentTabId != null) {
        void loadMedia(currentTabId, { preserveSelection: true });
      }
    }, 3500);
  }
}

selectAllBtn.addEventListener("click", () => {
  for (const item of mediaItems) selected.add(item.url);
  renderMediaList();
});

selectNoneBtn.addEventListener("click", () => {
  selected.clear();
  renderMediaList();
});

enqueueBtn.addEventListener("click", async () => {
  // YouTube/B站/抖音等详情页：选中嗅探到的 CDN 直链也应改走页面解析（与「下载本页」一致）
  const preferPage = isYtdlpPreferredPage(currentUrl);
  const pageCanonical = preferPage
    ? normalizeYtdlpPageUrl(currentUrl)
    : currentUrl;
  const items = mediaItems
    .filter((m) => selected.has(m.url))
    .map((m) => ({
      url: m.url,
      type: m.type || "",
      title: m.title || m.pageTitle || currentTitle,
      pageUrl: preferPage ? pageCanonical : m.pageUrl || currentUrl,
      detectedAt: m.detectedAt || 0,
      forcePage: !!m.nowPlaying || preferPage,
    }));
  if (items.length === 0) return;

  enqueueBtn.disabled = true;
  enqueueBtn.textContent = "发送中…";
  setStatus("", "");

  try {
    const result = await chrome.runtime.sendMessage({
      type: "enqueue",
      tabId: currentTabId,
      items,
    });
    if (result && result.ok) {
      // 已发送的条目移出列表并恢复按钮，避免重复发送
      const sentUrls = new Set(items.map((it) => it.url));
      mediaItems = mediaItems.filter((m) => !sentUrls.has(m.url));
      for (const u of sentUrls) selected.delete(u);
      renderMediaList();
      const expiredNote =
        result.expired > 0 ? `，${result.expired} 条已过期被跳过` : "";
      setStatus(
        "ok",
        `已发送 ${result.count ?? items.length} 个任务到下载器${expiredNote}`,
      );
      return;
    }
    const error = (result && result.error) || "发送失败";
    updateEnqueueButton();
    setStatus("error", error);
  } catch (err) {
    updateEnqueueButton();
    setStatus("error", String(err?.message || err));
  }
});

function pageEnqueueLabel() {
  return isYtdlpPreferredPage(currentUrl)
    ? "下载本页视频（推荐）"
    : "仅发送页面链接";
}

enqueuePageBtn.addEventListener("click", async () => {
  if (!isHttpUrl(currentUrl)) return;

  const pageUrl = normalizeYtdlpPageUrl(currentUrl);
  enqueuePageBtn.disabled = true;
  enqueuePageBtn.textContent = "发送中…";
  setStatus("", "");

  try {
    const result = await chrome.runtime.sendMessage({
      type: "enqueue",
      url: pageUrl,
      pageUrl,
      skipVerify: true,
      items: [{ url: pageUrl, title: currentTitle, pageUrl }],
    });
    if (result && result.ok) {
      enqueuePageBtn.textContent = "已发送";
      setStatus("ok", "已发送页面链接到下载器");
      return;
    }
    const error = (result && result.error) || "发送失败";
    enqueuePageBtn.disabled = false;
    enqueuePageBtn.textContent = pageEnqueueLabel();
    setStatus("error", error);
  } catch (err) {
    enqueuePageBtn.disabled = false;
    enqueuePageBtn.textContent = pageEnqueueLabel();
    setStatus("error", String(err?.message || err));
  }
});

void loadActiveTab();
