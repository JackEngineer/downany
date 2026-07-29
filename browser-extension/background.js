/** Chrome MV3：媒体嗅探 + 有效性验证 + HTTP 桥入队，失败再回退 videodl://。 */

importScripts("shared.js");

const { classifyUrl, isYtdlpPreferredPage } = globalThis.VideoDlShared;

const BRIDGE_BASE = "http://127.0.0.1:17888";
const MENU_PAGE = "videodl-download-page";
const MENU_LINK = "videodl-download-link";
const MENU_SELECTION = "videodl-download-selection";
const MENU_MEDIA = "videodl-download-media";

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

/** 小于该体积的音视频文件视为装饰性内容（头像/emoji/广告碎片） */
const MIN_FILE_SIZE = 100 * 1024;
/** 单 tab 最大入库条目，防止恶意页面刷爆 */
const MAX_ITEMS_PER_TAB = 40;
const VERIFY_TIMEOUT_MS = 4000;

/** @type {Map<number, Map<string, MediaItem>>} */
const tabMedia = new Map();

/**
 * MV3 service worker 空闲约 30s 会被终止，内存 Map 会丢；
 * 用 chrome.storage.session 持久化，唤醒后可恢复（会话内有效）。
 */
const STORAGE_KEY_PREFIX = "tabMedia:";
const persistTimers = new Map();

/** 正在进行有效性验证的条目（键 tabId:urlKey），防止同 tab 并发重复验证 */
const pendingVerify = new Set();
/** 同组（同一视频的多码率清单）验证中去重，键为 tabId:groupKey */
const pendingGroups = new Set();

/**
 * 每 tab 代际号：导航/关闭时 +1。
 * 异步验证（最长数秒）期间页面可能已跳转，完成后对照代际，过期结果直接丢弃，
 * 避免上一个页面的媒体"复活"在新页面列表里。
 * @type {Map<number, number>}
 */
const tabGeneration = new Map();

function bumpTabGeneration(tabId) {
  tabGeneration.set(tabId, (tabGeneration.get(tabId) || 0) + 1);
}

/**
 * 页面级"正在播放的视频所属卡片"（content script 通过 playing 事件上报）。
 * 时间线/搜索页播放视频时 URL 不变，用它把媒体关联到可解析的详情页与可读标题。
 * @type {Map<number, {url: string, title: string, at: number}>}
 */
const tabActiveVideoPage = new Map();
const ACTIVE_VIDEO_PAGE_TTL = 300_000;

function resolvePageContext(tabId, fallbackUrl) {
  if (fallbackUrl && isYtdlpPreferredPage(fallbackUrl)) {
    return { url: fallbackUrl, title: "" };
  }
  const rec = tabActiveVideoPage.get(tabId);
  if (rec && Date.now() - rec.at < ACTIVE_VIDEO_PAGE_TTL) {
    return { url: rec.url, title: rec.title || "" };
  }
  return { url: fallbackUrl || "", title: "" };
}

/** playing 上报后，回填同 tab 里尚未关联详情页的条目 */
const BACKFILL_WINDOW_MS = 45_000;

function backfillTabMediaContext(tabId) {
  const rec = tabActiveVideoPage.get(tabId);
  const bucket = tabMedia.get(tabId);
  if (!rec || !bucket) return;
  let changed = false;
  for (const [k, v] of bucket) {
    if (v.pageUrl && isYtdlpPreferredPage(v.pageUrl)) continue;
    // 只回填发现时间与播放时间相近的条目，避免把旧视频错挂到最新播放上
    if (v.detectedAt && Math.abs(rec.at - v.detectedAt) > BACKFILL_WINDOW_MS) {
      continue;
    }
    v.pageUrl = rec.url;
    if (rec.title && !v.title) v.title = rec.title;
    bucket.set(k, v);
    changed = true;
  }
  if (changed) schedulePersist(tabId);
}

/**
 * @typedef {{
 *   url: string,
 *   type: string,
 *   source: string,
 *   size: number|null,
 *   pageUrl: string,
 *   pageTitle: string,
 *   blob?: boolean,
 *   contentType?: string,
 *   duration?: number|null,
 *   variants?: number,
 *   resolution?: string|null,
 *   groupKey?: string,
 *   enrichKind?: string,
 *   detectedAt?: number,
 *   title?: string,
 * }} MediaItem
 */

function storageKey(tabId) {
  return STORAGE_KEY_PREFIX + String(tabId);
}

function schedulePersist(tabId) {
  const prev = persistTimers.get(tabId);
  if (prev) clearTimeout(prev);
  persistTimers.set(
    tabId,
    setTimeout(() => {
      persistTimers.delete(tabId);
      const bucket = tabMedia.get(tabId);
      const items = bucket ? Array.from(bucket.values()) : [];
      chrome.storage.session
        .set({ [storageKey(tabId)]: items })
        .catch(() => {});
    }, 400),
  );
}

function isHttpUrl(value) {
  return typeof value === "string" && HTTP_RE.test(value.trim());
}

function extractFirstHttpUrl(text) {
  if (!text) return null;
  const match = String(text).match(/https?:\/\/[^\s<>"'，。；、）)\]]+/i);
  if (!match) return null;
  return match[0].replace(/[.,;:!?]+$/g, "");
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

// ---- 清单解析 ----

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

async function fetchWithTimeout(url, options = {}, timeoutMs = VERIFY_TIMEOUT_MS) {
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
async function enrichPlaylist(url, pageUrl) {
  try {
    const headers = {};
    if (pageUrl) headers.Referer = pageUrl;
    const res = await fetchWithTimeout(url, {
      headers,
      credentials: "include",
    });
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
async function verifyFileUrl(url, pageUrl) {
  try {
    const headers = { Range: "bytes=0-0" };
    if (pageUrl) headers.Referer = pageUrl;
    const res = await fetchWithTimeout(url, {
      headers,
      credentials: "include",
    });
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

// ---- 入库 ----

function getTabBucket(tabId) {
  let bucket = tabMedia.get(tabId);
  if (!bucket) {
    bucket = new Map();
    tabMedia.set(tabId, bucket);
  }
  return bucket;
}

function tabItemCount(tabId) {
  const bucket = tabMedia.get(tabId);
  return bucket ? bucket.size : 0;
}

/**
 * @param {number} tabId
 * @param {Partial<MediaItem> & {url: string}} item
 */
function upsertMedia(tabId, item) {
  if (tabId < 0 || !item?.url) return;
  if (item.blob) return;
  if (!isHttpUrl(item.url) || isSegmentUrl(item.url)) return;

  const key = normalizeMediaKey(item.url);
  const bucket = getTabBucket(tabId);
  const prev = bucket.get(key);
  const merged = {
    url: item.url,
    type: item.type || (prev && prev.type) || classifyUrl(item.url),
    source: item.source || (prev && prev.source) || "network",
    size:
      item.size != null ? item.size : prev && prev.size != null ? prev.size : null,
    pageUrl: item.pageUrl || (prev && prev.pageUrl) || "",
    pageTitle: item.pageTitle || (prev && prev.pageTitle) || "",
    duration:
      item.duration != null
        ? item.duration
        : prev && prev.duration != null
          ? prev.duration
          : null,
    variants:
      item.variants != null
        ? item.variants
        : prev && prev.variants != null
          ? prev.variants
          : 0,
    resolution:
      item.resolution != null
        ? item.resolution
        : prev && prev.resolution != null
          ? prev.resolution
          : null,
    groupKey: item.groupKey || (prev && prev.groupKey) || "",
    enrichKind: item.enrichKind || (prev && prev.enrichKind) || "",
    detectedAt: (prev && prev.detectedAt) || Date.now(),
    title: item.title || (prev && prev.title) || "",
  };
  if (prev && prev.source === "network" && item.source === "dom") {
    merged.source = "network";
    merged.url = prev.url;
  }
  bucket.set(key, merged);
  schedulePersist(tabId);
  void updateBadge(tabId);
}

function findGroupEntry(bucket, groupKey) {
  if (!groupKey) return null;
  for (const [k, v] of bucket) {
    if (v.groupKey === groupKey) return { key: k, item: v };
  }
  return null;
}

/**
 * 候选入库管线：验证有效性并归并多码率清单后才展示。
 * 清单（m3u8/mpd）必须解析成功；文件必须确认是媒体且非碎片。
 */
async function ingestCandidate(tabId, item) {
  if (tabId < 0 || !item?.url) return;
  if (item.blob) return;
  if (!isHttpUrl(item.url) || isSegmentUrl(item.url)) return;

  const key = normalizeMediaKey(item.url);
  const verifyLock = `${tabId}:${key}`;
  const bucket = getTabBucket(tabId);
  if (bucket.has(key) || pendingVerify.has(verifyLock)) return;
  if (tabItemCount(tabId) >= MAX_ITEMS_PER_TAB) return;

  // 记录代际：验证期间页面导航/关闭的话，结果直接丢弃（防旧条目复活）
  const gen = tabGeneration.get(tabId) || 0;
  const isStale = () => (tabGeneration.get(tabId) || 0) !== gen;

  const ctx = resolvePageContext(tabId, item.pageUrl || "");
  const pageUrl = ctx.url;
  const cardTitle = ctx.title || item.title || "";

  // 已关联到 yt-dlp 详情页的条目：同详情页只保留一条
  // （实际发送的是页面链接，多条直链毫无区别）；
  // 例外：新候选可能是 master 清单，放行验证替换（拿多码率/时长信息）
  let pageDupKey = null;
  if (isYtdlpPreferredPage(pageUrl)) {
    for (const [k, v] of bucket) {
      if (v.pageUrl === pageUrl) {
        pageDupKey = k;
        break;
      }
    }
    if (pageDupKey != null) {
      const fileName = item.url.split("/").pop()?.split("?")[0] || "";
      const upgradeable =
        isPlaylistCandidate(item.url, item.type) &&
        /^(index|master|playlist)\.m3u8/i.test(fileName) &&
        bucket.get(pageDupKey)?.enrichKind !== "master";
      if (!upgradeable) return;
    }
  }

  if (isPlaylistCandidate(item.url, item.type)) {
    const groupKey = playlistGroupKey(item.url);
    const groupLock = `${tabId}:${groupKey}`;
    if (pendingGroups.has(groupLock)) return;
    const existing = findGroupEntry(bucket, groupKey);
    // 同组已有条目：仅当新候选可能是 master（文件名 index/master/playlist）才继续验证替换
    if (existing) {
      const fileName = item.url.split("/").pop()?.split("?")[0] || "";
      const maybeMaster = /^(index|master|playlist)\.m3u8/i.test(fileName);
      if (!maybeMaster || existing.item.enrichKind === "master") return;
    }

    pendingVerify.add(verifyLock);
    pendingGroups.add(groupLock);
    const info = await enrichPlaylist(item.url, pageUrl);
    pendingVerify.delete(verifyLock);
    pendingGroups.delete(groupLock);
    if (!info || isStale()) return; // 无效清单不入列；代际过期丢弃

    // 验证期间可能有同组条目抢先入库：只保留 master
    const late = findGroupEntry(bucket, groupKey);
    if (late) {
      const newIsMaster = info.kind === "master";
      if (late.item.enrichKind === "master" || !newIsMaster) return;
      bucket.delete(late.key);
    }
    // master 升级：替换同详情页的旧条目
    if (pageDupKey != null && info.kind === "master") {
      bucket.delete(pageDupKey);
    }
    upsertMedia(tabId, {
      ...item,
      title: cardTitle,
      type: info.kind === "dash" ? "dash" : "hls",
      duration: info.duration,
      variants: info.variants,
      resolution: info.bestResolution,
      groupKey,
      enrichKind: info.kind,
    });
    return;
  }

  // 防盗链可能返回大体积 HTML 错误页：声明的非媒体类型直接丢弃
  if (item.contentType && !contentTypeLooksMedia(item.contentType)) return;

  // 文件类：已知太小直接丢弃（装饰性内容）
  if (item.size != null && item.size < MIN_FILE_SIZE) return;

  if (item.size == null) {
    // 无大小信息（DOM 来源 / 响应无 Content-Length）：主动验证有效性
    pendingVerify.add(verifyLock);
    const verified = await verifyFileUrl(item.url, pageUrl);
    pendingVerify.delete(verifyLock);
    if (!verified || isStale()) return;
    if (verified.size != null && verified.size < MIN_FILE_SIZE) return;
    upsertMedia(tabId, { ...item, title: cardTitle, size: verified.size });
    return;
  }

  upsertMedia(tabId, { ...item, title: cardTitle });
}

function clearTabMedia(tabId) {
  bumpTabGeneration(tabId);
  tabMedia.delete(tabId);
  tabActiveVideoPage.delete(tabId);
  chrome.storage.session.remove(storageKey(tabId)).catch(() => {});
  void chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
}

async function listTabMedia(tabId) {
  let bucket = tabMedia.get(tabId);
  if (!bucket || bucket.size === 0) {
    // service worker 可能刚被唤醒：尝试从 session 存储恢复
    try {
      const key = storageKey(tabId);
      const data = await chrome.storage.session.get(key);
      const stored = data[key];
      if (Array.isArray(stored) && stored.length > 0) {
        bucket = new Map();
        for (const it of stored) {
          if (it && it.url) {
            bucket.set(normalizeMediaKey(it.url), it);
          }
        }
        tabMedia.set(tabId, bucket);
      }
    } catch {
      // ignore
    }
  }
  if (!bucket || bucket.size === 0) return [];
  return Array.from(bucket.values()).sort((a, b) => {
    const rank = { hls: 0, dash: 1, file: 2, audio: 3, media: 4 };
    const byType = (rank[a.type] ?? 9) - (rank[b.type] ?? 9);
    if (byType !== 0) return byType;
    // 同类型：master 清单优先，其次按发现时间倒序
    const masterA = a.enrichKind === "master" ? 0 : 1;
    const masterB = b.enrichKind === "master" ? 0 : 1;
    if (masterA !== masterB) return masterA - masterB;
    return (b.detectedAt || 0) - (a.detectedAt || 0);
  });
}

async function updateBadge(tabId) {
  const items = await listTabMedia(tabId);
  const count = items.length;
  try {
    await chrome.action.setBadgeBackgroundColor({ color: "#2563eb", tabId });
    await chrome.action.setBadgeText({
      tabId,
      text: count > 0 ? String(Math.min(count, 99)) : "",
    });
  } catch {
    // ignore
  }
}

async function flashBadge(text, color = "#2563eb", tabId = -1) {
  try {
    const target = tabId >= 0 ? { tabId } : {};
    await chrome.action.setBadgeBackgroundColor({ color, ...target });
    await chrome.action.setBadgeText({ text, ...target });
    setTimeout(() => {
      void chrome.action
        .setBadgeText({ text: "", ...target })
        .catch(() => {});
    }, 2000);
  } catch {
    // ignore
  }
}

function notify(title, message) {
  try {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon128.png",
      title,
      message,
    });
  } catch {
    // ignore
  }
}

async function getCookieHeader(url) {
  try {
    const cookies = await chrome.cookies.getAll({ url });
    if (!cookies || cookies.length === 0) return "";
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  } catch {
    return "";
  }
}

/** Referer 用页面地址；Cookie 取媒体资源所在域（跨域 CDN 才拿得到对应会话）。 */
async function buildHeadersForUrl(mediaUrl, pageUrl) {
  const headers = {};
  if (pageUrl || mediaUrl) headers.Referer = pageUrl || mediaUrl;
  const cookie = await getCookieHeader(mediaUrl);
  if (cookie) headers.Cookie = cookie;
  return headers;
}

/**
 * 发送前复核：签名 URL 有时效，过期的直接剔除而不是把错误任务塞给下载器。
 */
async function revalidateItems(prepared) {
  return Promise.all(
    prepared.map(async (item) => {
      const playlist = isPlaylistCandidate(item.url, item.type || "");
      const ok = playlist
        ? await enrichPlaylist(item.url, item.pageUrl)
        : await verifyFileUrl(item.url, item.pageUrl);
      return { item, ok: !!ok };
    }),
  );
}

/**
 * @param {{url: string, title?: string, headers?: Record<string,string>}[]} items
 */
async function enqueueViaBridge(items) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    const res = await fetch(`${BRIDGE_BASE}/enqueue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data && data.ok) {
      return { ok: true, count: data.count };
    }
    return {
      ok: false,
      error: (data && data.error) || `桥接失败 HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      ok: false,
      error: String(err?.message || err),
      bridgeDown: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 协议回退：仅支持单 URL（无 headers）。 */
async function enqueueViaProtocol(pageUrl) {
  const redirect =
    chrome.runtime.getURL("redirect.html") +
    `?url=${encodeURIComponent(pageUrl)}`;
  const tab = await chrome.tabs.create({ url: redirect, active: false });
  setTimeout(() => {
    if (tab?.id != null) {
      void chrome.tabs.remove(tab.id).catch(() => {});
    }
  }, 2500);
  return { ok: true, via: "protocol" };
}

// ---- 入队策略 ----

/**
 * @param {{url: string, title?: string, pageUrl?: string, type?: string}[]} rawItems
 * @param skipVerify 用户主动发送的页面/链接（非嗅探结果）跳过媒体有效性验证
 * @returns {{ ok: true, via?: string, count?: number, expired?: number } | { ok: false, error: string }}
 */
async function sendItemsToDownloader(
  rawItems,
  { silent = false, skipVerify = false, tabId = -1 } = {},
) {
  const prepared = [];
  for (const raw of rawItems) {
    const url = (raw.url || "").trim();
    if (!isHttpUrl(url)) continue;
    let pageUrl = raw.pageUrl || "";
    // 发送时兜底关联：条目展示层没挂上详情页的，用最近播放记录再试一次
    // （带时间窗，防止把别的视频错挂到当前播放上）
    if ((!pageUrl || !isYtdlpPreferredPage(pageUrl)) && tabId >= 0) {
      const rec = tabActiveVideoPage.get(tabId);
      const detectedAt = raw.detectedAt || 0;
      if (
        rec &&
        Date.now() - rec.at < ACTIVE_VIDEO_PAGE_TTL &&
        (!detectedAt || Math.abs(rec.at - detectedAt) <= BACKFILL_WINDOW_MS)
      ) {
        pageUrl = rec.url;
      }
    }
    // yt-dlp 擅长的单视频页：一律发页面链接（含 url 本身就是 watch 页的情况）。
    // 旧逻辑要求 pageUrl !== url，导致「下载选中」把 watch 页当媒体做 Range
    // 校验 → HTML 被判无效 →「链接已过期」；CDN 直链也会因签名失效失败。
    const preferredPage =
      (pageUrl && isYtdlpPreferredPage(pageUrl) && pageUrl) ||
      (isYtdlpPreferredPage(url) && url) ||
      "";
    const viaPage =
      !skipVerify && (!!preferredPage || !!raw.forcePage);
    let finalUrl = url;
    if (viaPage) {
      finalUrl = preferredPage || pageUrl || url;
    }
    const headers = await buildHeadersForUrl(finalUrl, pageUrl || finalUrl);
    prepared.push({
      url: finalUrl,
      title: raw.title || "",
      pageUrl,
      type: raw.type || "",
      viaPage,
      headers,
    });
  }

  if (prepared.length === 0) {
    const error = "没有有效的 http(s) 媒体链接";
    if (!silent) {
      await flashBadge("!", "#dc2626", tabId);
      notify("无法发送", error);
    }
    return { ok: false, error };
  }

  // 发送前复核有效性，剔除已过期链接
  // （页面链接由 yt-dlp 实时解析，不验证；viaPage 同理）
  let valid = prepared;
  let expired = 0;
  if (!skipVerify) {
    const direct = prepared.filter((p) => !p.viaPage);
    const viaPageItems = prepared.filter((p) => p.viaPage);
    const checks = await revalidateItems(direct);
    const okItems = [];
    for (const c of checks) {
      if (c.ok) {
        okItems.push(c.item);
        continue;
      }
      expired++;
      // 顺手移除死链接，避免重开弹窗再见到
      if (tabId >= 0) {
        const bucket = tabMedia.get(tabId);
        if (bucket) bucket.delete(normalizeMediaKey(c.item.url));
      }
    }
    if (tabId >= 0 && expired > 0) {
      schedulePersist(tabId);
      void updateBadge(tabId);
    }
    valid = [...viaPageItems, ...okItems];
  }

  if (valid.length === 0) {
    const error =
      "所选链接已过期（媒体地址有时效）。请重新播放视频，" +
      "或直接发送顶部「正在播放」条目。";
    if (!silent) {
      await flashBadge("!", "#dc2626", tabId);
      notify("无法发送", error);
    }
    return { ok: false, error, expired };
  }

  const bridge = await enqueueViaBridge(valid);
  if (bridge.ok) {
    if (!silent) {
      await flashBadge("✓", "#16a34a", tabId);
      notify(
        "已加入下载器",
        expired > 0
          ? `已发送 ${valid.length} 个任务，${expired} 条链接已过期被跳过`
          : `已发送 ${valid.length} 个任务`,
      );
    }
    return { ok: true, via: "bridge", count: valid.length, expired };
  }

  // 桥失败时对每个 URL 回退协议（无 header）
  try {
    for (const item of valid) {
      await enqueueViaProtocol(item.url);
    }
    if (!silent) {
      await flashBadge("✓", "#16a34a", tabId);
      notify(
        "已发送到下载器",
        bridge.bridgeDown
          ? "本机桥未连接，已改用协议投递；请确认下载器已启动"
          : "已改用协议投递",
      );
    }
    return { ok: true, via: "protocol", count: valid.length, expired };
  } catch (err) {
    const error =
      (bridge.bridgeDown
        ? "下载器未运行或桥未启动（请先打开 Electron 下载器）。"
        : "") + String(err?.message || err || bridge.error || "发送失败");
    if (!silent) {
      await flashBadge("!", "#dc2626", tabId);
      notify("无法发送", error);
    }
    return { ok: false, error };
  }
}

async function sendToDownloader(pageUrl, { silent = false } = {}) {
  // 页面 / 链接地址交给 yt-dlp 解析，不做媒体有效性验证
  return sendItemsToDownloader([{ url: pageUrl, pageUrl }], {
    silent,
    skipVerify: true,
  });
}

// ---- 网络嗅探 ----

function resolveTabId(details) {
  if (typeof details.tabId === "number" && details.tabId >= 0) {
    return details.tabId;
  }
  return -1;
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const tabId = resolveTabId(details);
    if (tabId < 0) return;
    if (!looksLikeMediaUrl(details.url)) return;
    chrome.tabs.get(tabId).then(
      (tab) => {
        void ingestCandidate(tabId, {
          url: details.url,
          type: classifyUrl(details.url),
          source: "network",
          pageUrl: tab.url || details.initiator || "",
          pageTitle: tab.title || "",
        });
      },
      () => {
        void ingestCandidate(tabId, {
          url: details.url,
          type: classifyUrl(details.url),
          source: "network",
          pageUrl: details.initiator || "",
          pageTitle: "",
        });
      },
    );
  },
  { urls: ["http://*/*", "https://*/*"] },
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const tabId = resolveTabId(details);
    if (tabId < 0) return;

    const headers = details.responseHeaders || [];
    let contentType = "";
    let contentLength = null;
    for (const h of headers) {
      const name = (h.name || "").toLowerCase();
      if (name === "content-type") contentType = h.value || "";
      if (name === "content-length") {
        const n = parseInt(h.value || "", 10);
        if (!Number.isNaN(n) && n > 0) contentLength = n;
      }
    }

    const byUrl = looksLikeMediaUrl(details.url);
    const byType = contentTypeLooksMedia(contentType);
    if (!byUrl && !byType) return;
    if (isSegmentUrl(details.url)) return;

    const type = classifyByContentType(contentType) || classifyUrl(details.url);

    chrome.tabs.get(tabId).then(
      (tab) => {
        void ingestCandidate(tabId, {
          url: details.url,
          type,
          source: "network",
          size: contentLength,
          contentType,
          pageUrl: tab.url || details.initiator || "",
          pageTitle: tab.title || "",
        });
      },
      () => {
        void ingestCandidate(tabId, {
          url: details.url,
          type,
          source: "network",
          size: contentLength,
          contentType,
          pageUrl: details.initiator || "",
          pageTitle: "",
        });
      },
    );
  },
  { urls: ["http://*/*", "https://*/*"] },
  ["responseHeaders"],
);

chrome.tabs.onRemoved.addListener((tabId) => {
  clearTabMedia(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" && changeInfo.url) {
    clearTabMedia(tabId);
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_PAGE,
      title: "用视频下载器下载此页面",
      contexts: ["page"],
    });
    chrome.contextMenus.create({
      id: MENU_LINK,
      title: "用视频下载器下载此链接",
      contexts: ["link"],
    });
    chrome.contextMenus.create({
      id: MENU_SELECTION,
      title: "用视频下载器下载选中链接",
      contexts: ["selection"],
    });
    chrome.contextMenus.create({
      id: MENU_MEDIA,
      title: "用视频下载器下载此媒体",
      contexts: ["video", "audio"],
    });
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;

  if (message.type === "domMedia") {
    const tabId =
      typeof message.tabId === "number" ? message.tabId : sender.tab?.id;
    if (typeof tabId === "number") {
      const items = message.items || [];
      for (const item of items) {
        void ingestCandidate(tabId, {
          url: item.url,
          type: item.type || classifyUrl(item.url || ""),
          source: item.source || "dom",
          blob: !!item.blob,
          pageUrl: message.pageUrl || sender.tab?.url || "",
          pageTitle: message.pageTitle || sender.tab?.title || "",
        });
      }
    }
    return false;
  }

  if (message.type === "activeVideoPage") {
    const tabId =
      typeof message.tabId === "number" ? message.tabId : sender.tab?.id;
    if (typeof tabId === "number" && message.pageUrl) {
      tabActiveVideoPage.set(tabId, {
        url: message.pageUrl,
        title: message.title || "",
        at: Date.now(),
      });
      backfillTabMediaContext(tabId);
    }
    return false;
  }

  if (message.type === "getMedia") {
    const tabId = message.tabId;
    void listTabMedia(tabId).then((items) => {
      void updateBadge(tabId);
      const rec = tabActiveVideoPage.get(tabId);
      const nowPlaying =
        rec && Date.now() - rec.at < ACTIVE_VIDEO_PAGE_TTL
          ? { url: rec.url, title: rec.title, at: rec.at }
          : null;
      sendResponse({ items, nowPlaying });
    });
    return true;
  }

  if (message.type === "enqueue") {
    const items = Array.isArray(message.items)
      ? message.items
      : message.url
        ? [{ url: message.url, pageUrl: message.pageUrl || message.url }]
        : [];
    void sendItemsToDownloader(items, {
      silent: true,
      skipVerify: !!message.skipVerify,
      tabId: typeof message.tabId === "number" ? message.tabId : -1,
    }).then((result) => {
      sendResponse(result);
    });
    return true;
  }

  return false;
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_LINK) {
    void sendToDownloader(info.linkUrl || "");
    return;
  }
  if (info.menuItemId === MENU_SELECTION) {
    const url = extractFirstHttpUrl(info.selectionText || "");
    void sendToDownloader(url || "");
    return;
  }
  if (info.menuItemId === MENU_MEDIA) {
    const src = info.srcUrl || "";
    void sendItemsToDownloader(
      [{ url: src, pageUrl: info.pageUrl || tab?.url || "" }],
      {},
    );
    return;
  }
  if (info.menuItemId === MENU_PAGE) {
    void sendToDownloader(info.pageUrl || "");
  }
});
