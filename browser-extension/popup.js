/** Popup：展示嗅探到的媒体列表，勾选后发送到下载器。 */

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

/** yt-dlp 可直接解析页面链接的站点，空态给更强提示 */
const YTDLP_FRIENDLY_HOST_RE =
  /(^|\.)(x\.com|twitter\.com|youtube\.com|youtu\.be|bilibili\.com|b23\.tv|douyin\.com|tiktok\.com|weibo\.com|weibo\.cn|instagram\.com|weixin\.qq\.com)$/i;

/** yt-dlp 原生支持的单视频页：发送时改为页面链接（与 background 保持一致） */
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

function isYtdlpPreferredPage(pageUrl) {
  try {
    const u = new URL(pageUrl);
    return YTDLP_PAGE_RES.some((re) => re.test(u.hostname + u.pathname));
  } catch {
    return false;
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
      "请先播放页面中的视频再打开本弹窗；或直接点下方「仅发送页面链接」，交给 yt-dlp 解析（会带上登录态）。"
    );
  }
  return "未检测到媒体流。请先在页面中播放视频再打开本弹窗；或尝试「仅发送页面链接」。";
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
    if (item.size) bits.push(formatSize(item.size));
    meta.textContent = bits.join(" · ");

    row.appendChild(badge);

    const pageUrl = item.pageUrl || currentUrl;
    if (item.nowPlaying) {
      const npBadge = document.createElement("span");
      npBadge.className = "badge playing";
      npBadge.textContent = "正在播放";
      row.appendChild(npBadge);
    } else if (
      pageUrl &&
      pageUrl !== item.url &&
      isYtdlpPreferredPage(pageUrl)
    ) {
      // yt-dlp 原生支持的页面：发送时会改为页面链接实时解析，标注来源
      const pageBadge = document.createElement("span");
      pageBadge.className = "badge page";
      pageBadge.textContent = "页面解析";
      row.appendChild(pageBadge);
    }

    if (meta.textContent) row.appendChild(meta);

    const name = document.createElement("p");
    name.className = "media-name";
    // 优先显示卡片提取的可读标题（推文文本等），否则退回 URL 文件名
    name.textContent = item.title || displayName(item.url);
    name.title = item.url;

    const host = document.createElement("p");
    host.className = "media-host";
    host.textContent = item.title
      ? `${hostOf(item.url)} · ${displayName(item.url)}`
      : hostOf(item.url);

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

async function rescanTab(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const HTTP_RE = /^https?:\/\//i;
        const out = [];
        const seen = new Set();
        function push(url, source) {
          if (!url || !HTTP_RE.test(url)) return;
          if (seen.has(url)) return;
          seen.add(url);
          const lower = url.toLowerCase().split("?")[0];
          let type = "media";
          if (lower.includes(".m3u8")) type = "hls";
          else if (lower.includes(".mpd")) type = "dash";
          else if (/\.(mp3|m4a|aac|flac|ogg|wav)(\b|$)/i.test(lower)) type = "audio";
          else if (/\.(mp4|webm|mkv|mov|m4v)(\b|$)/i.test(lower)) type = "file";
          out.push({ url, type, source });
        }
        document.querySelectorAll("video, audio").forEach((el) => {
          push(el.currentSrc || el.src || "", "dom");
          el.querySelectorAll("source").forEach((s) =>
            push(s.src || s.getAttribute("src") || "", "dom"),
          );
        });
        [
          "og:video",
          "og:video:url",
          "og:video:secure_url",
          "og:audio",
          "twitter:player:stream",
        ].forEach((prop) => {
          const meta = document.querySelector(
            `meta[property="${prop}"], meta[name="${prop}"]`,
          );
          if (meta) push(meta.getAttribute("content") || "", "meta");
        });
        return {
          pageUrl: location.href,
          pageTitle: document.title || "",
          items: out,
        };
      },
    });
    const payload = results && results[0] && results[0].result;
    if (payload && Array.isArray(payload.items) && payload.items.length > 0) {
      await chrome.runtime.sendMessage({
        type: "domMedia",
        tabId,
        pageUrl: payload.pageUrl,
        pageTitle: payload.pageTitle,
        items: payload.items,
      });
    }
  } catch {
    // 受限页无法注入
  }
}

/**
 * 展示层合并：同一详情页（yt-dlp 页面解析）的多条直链只显示一条，
 * 信息取最全的（时长/清晰度优先保留有值的）。
 */
function collapseItems(items) {
  const byPage = new Map();
  const out = [];
  for (const item of items) {
    if (item.pageUrl && isYtdlpPreferredPage(item.pageUrl)) {
      const prev = byPage.get(item.pageUrl);
      if (prev) {
        if (!prev.duration && item.duration) prev.duration = item.duration;
        if ((!prev.variants || prev.variants <= 1) && item.variants > 1) {
          prev.variants = item.variants;
        }
        if (!prev.title && item.title) prev.title = item.title;
        continue;
      }
      byPage.set(item.pageUrl, item);
      out.push(item);
      continue;
    }
    out.push(item);
  }
  return out;
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
    let merged = false;
    for (const m of mediaItems) {
      if (m.pageUrl === nowPlaying.url || m.url === nowPlaying.url) {
        m.nowPlaying = true;
        if (nowPlaying.title && !m.title) m.title = nowPlaying.title;
        merged = true;
      }
    }
    if (!merged) {
      mediaItems.unshift({
        url: nowPlaying.url,
        type: "page",
        source: "playing",
        size: null,
        pageUrl: nowPlaying.url,
        pageTitle: currentTitle,
        title: nowPlaying.title || "正在播放的视频",
        nowPlaying: true,
        detectedAt: nowPlaying.at || Date.now(),
      });
    }
  }

  if (!preserveSelection) {
    selected.clear();
    // 默认选中「正在播放」，否则第一条
    const first = mediaItems.find((m) => m.nowPlaying) || mediaItems[0];
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
  currentTitle = tab.title || "未命名页面";
  titleEl.textContent = currentTitle;
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
  }
  setStatus("", "");

  if (typeof currentTabId === "number") {
    await rescanTab(currentTabId);
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
  const items = mediaItems
    .filter((m) => selected.has(m.url))
    .map((m) => ({
      url: m.url,
      type: m.type || "",
      title: m.title || m.pageTitle || currentTitle,
      pageUrl: m.pageUrl || currentUrl,
      detectedAt: m.detectedAt || 0,
      forcePage: !!m.nowPlaying,
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
      enqueueBtn.textContent = "已发送";
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

enqueuePageBtn.addEventListener("click", async () => {
  if (!isHttpUrl(currentUrl)) return;

  enqueuePageBtn.disabled = true;
  enqueuePageBtn.textContent = "发送中…";
  setStatus("", "");

  try {
    const result = await chrome.runtime.sendMessage({
      type: "enqueue",
      url: currentUrl,
      pageUrl: currentUrl,
      skipVerify: true,
      items: [{ url: currentUrl, title: currentTitle, pageUrl: currentUrl }],
    });
    if (result && result.ok) {
      enqueuePageBtn.textContent = "已发送";
      setStatus("ok", "已发送页面链接到下载器");
      return;
    }
    const error = (result && result.error) || "发送失败";
    enqueuePageBtn.disabled = false;
    enqueuePageBtn.textContent = "仅发送页面链接";
    setStatus("error", error);
  } catch (err) {
    enqueuePageBtn.disabled = false;
    enqueuePageBtn.textContent = "仅发送页面链接";
    setStatus("error", String(err?.message || err));
  }
});

void loadActiveTab();
