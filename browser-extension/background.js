/** Chrome MV3：媒体嗅探 + 有效性验证 + HTTP 桥入队，失败再回退 downany://。 */

importScripts("shared.js", "sniff-core.js");

const {
  classifyUrl,
  isYtdlpPreferredPage,
  normalizeYtdlpPageUrl,
  videoIdentityKey,
  extractDouyinVideoId,
  countDisplayMedia,
  isOrphanTwitterCdn,
} = globalThis.VideoDlShared;

const {
  isHttpUrl,
  normalizeMediaKey,
  classifyByContentType,
  isSegmentUrl,
  isPlaylistCandidate,
  looksLikeMediaUrl,
  contentTypeLooksMedia,
  playlistGroupKey,
  enrichPlaylist,
  verifyFileUrl,
} = globalThis.VideoDlSniffCore;

const BRIDGE_BASE = "http://127.0.0.1:17888";
/** 官网下载页（占位，见 docs/COMMERCIAL.md） */
const DOWNLOAD_SITE_URL = "https://downany.app/download";
const INSTALL_GUIDE_OPEN_KEY = "installGuideOpenedAt";
const INSTALL_GUIDE_COOLDOWN_MS = 60_000;
const MENU_PAGE = "downany-download-page";
const MENU_LINK = "downany-download-link";
const MENU_SELECTION = "downany-download-selection";
const MENU_MEDIA = "downany-download-media";

/** 小于该体积的音视频文件视为装饰性内容（头像/emoji/广告碎片） */
const MIN_FILE_SIZE = 100 * 1024;
/** 单 tab 最大入库条目，防止恶意页面刷爆 */
const MAX_ITEMS_PER_TAB = 40;

/** 已发送任务（扩展侧跟踪，供弹窗/页内按钮看进度） */
const SENT_TASKS_KEY = "sentTasks";
const SENT_TASKS_MAX = 20;
const POLL_INTERVAL_MS = 1500;
const POLL_BACKOFF_MS = 5000;
const POLL_MAX_AGE_MS = 30 * 60 * 1000;
const POLL_MAX_FAILS = 5;
const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "unknown",
]);

/** @type {ReturnType<typeof setTimeout>|null} */
let pollTimer = null;
let pollFails = 0;
let pollRunning = false;
/** 工具栏角标：正在下载（pending+downloading）数量 */
let activeDownloadCount = 0;

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
/** 每个 tab 当前「视频身份」，切视频时用于清空旧嗅探结果 */
const tabVideoKey = new Map();

function rememberVideoKey(tabId, pageUrl) {
  const key = videoIdentityKey(pageUrl || "");
  const prev = tabVideoKey.get(tabId);
  if (prev && prev !== key) {
    clearTabMedia(tabId);
  }
  tabVideoKey.set(tabId, key);
  pruneTabMediaToCurrentVideo(tabId);
  void updateBadge(tabId);
  return key;
}

function setActiveVideoPage(tabId, pageUrl, title) {
  const canonical = normalizeYtdlpPageUrl(pageUrl) || pageUrl;
  rememberVideoKey(tabId, canonical);
  tabActiveVideoPage.set(tabId, {
    url: canonical,
    title: title || "",
    at: Date.now(),
  });
  backfillTabMediaContext(tabId);
  pruneTabMediaToCurrentVideo(tabId);
  void updateBadge(tabId);
}

/** 抖音 / Instagram 等页面解析：只保留当前视频相关条目，去掉上一条残留。 */
function pruneTabMediaToCurrentVideo(tabId) {
  const currentKey = tabVideoKey.get(tabId);
  if (
    !currentKey ||
    !(currentKey.startsWith("douyin:") || currentKey.startsWith("page:"))
  ) {
    return;
  }
  const bucket = tabMedia.get(tabId);
  if (!bucket || bucket.size === 0) return;

  let changed = false;
  let keepKey = null;
  for (const [k, v] of bucket) {
    const page = v.pageUrl || "";
    const idFromPage = page ? extractDouyinVideoId(page) : null;
    if (idFromPage || (page && isYtdlpPreferredPage(page))) {
      if (videoIdentityKey(page) !== currentKey) {
        bucket.delete(k);
        changed = true;
        continue;
      }
      // 同一视频的多条 CDN：只留一条（体积更大 / master 优先）
      if (keepKey == null) {
        keepKey = k;
      } else {
        const prev = bucket.get(keepKey);
        const preferNew =
          (v.enrichKind === "master" && prev.enrichKind !== "master") ||
          (v.enrichKind === prev.enrichKind &&
            (v.size || 0) > (prev.size || 0));
        if (preferNew) {
          bucket.delete(keepKey);
          keepKey = k;
        } else {
          bucket.delete(k);
        }
        changed = true;
      }
      continue;
    }
    // 无 pageUrl 的孤儿 CDN：若不是最近跟着当前播放出现的，丢掉
    const rec = tabActiveVideoPage.get(tabId);
    if (
      !rec ||
      !v.detectedAt ||
      Math.abs(rec.at - v.detectedAt) > BACKFILL_WINDOW_MS
    ) {
      bucket.delete(k);
      changed = true;
    }
  }

  if (changed) {
    schedulePersist(tabId);
  }
}

function resolvePageContext(tabId, fallbackUrl) {
  const rec = tabActiveVideoPage.get(tabId);
  if (fallbackUrl && isYtdlpPreferredPage(fallbackUrl)) {
    const canonical = normalizeYtdlpPageUrl(fallbackUrl);
    if (
      rec &&
      Date.now() - rec.at < ACTIVE_VIDEO_PAGE_TTL &&
      videoIdentityKey(rec.url) === videoIdentityKey(canonical)
    ) {
      return { url: canonical, title: rec.title || "" };
    }
    return { url: canonical, title: "" };
  }
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

function extractFirstHttpUrl(text) {
  if (!text) return null;
  const match = String(text).match(/https?:\/\/[^\s<>"'，。；、）)\]]+/i);
  if (!match) return null;
  return match[0].replace(/[.,;:!?]+$/g, "");
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

  // X 主页/时间线：未挂到 /status/{id} 的 twimg HLS 不入库（否则全是无标题 m3u8）
  if (isOrphanTwitterCdn(item.url, pageUrl)) {
    return;
  }

  // 已关联到 yt-dlp 详情页的条目：同一视频只保留一条
  // （实际发送的是页面链接，多条直链毫无区别）；
  // 例外：新候选可能是 master 清单，放行验证替换（拿多码率/时长信息）
  let pageDupKey = null;
  if (isYtdlpPreferredPage(pageUrl)) {
    const wantKey = videoIdentityKey(pageUrl);
    for (const [k, v] of bucket) {
      if (v.pageUrl && videoIdentityKey(v.pageUrl) === wantKey) {
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
  tabVideoKey.delete(tabId);
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

  // 恢复后按当前视频再剪枝一次，避免 session 里旧条目把角标撑大
  pruneTabMediaToCurrentVideo(tabId);
  bucket = tabMedia.get(tabId);
  if (!bucket || bucket.size === 0) return [];

  let items = Array.from(bucket.values()).filter(
    (v) => !isOrphanTwitterCdn(v.url, v.pageUrl || ""),
  );
  const currentKey = tabVideoKey.get(tabId);
  if (currentKey && currentKey.startsWith("douyin:")) {
    items = items.filter((v) => {
      const page = v.pageUrl || "";
      if (page && (extractDouyinVideoId(page) || isYtdlpPreferredPage(page))) {
        return videoIdentityKey(page) === currentKey;
      }
      const rec = tabActiveVideoPage.get(tabId);
      return Boolean(
        rec &&
          v.detectedAt &&
          Math.abs(rec.at - v.detectedAt) <= BACKFILL_WINDOW_MS,
      );
    });
  }

  return items.sort((a, b) => {
    const rank = { hls: 0, dash: 1, file: 2, audio: 3, media: 4, page: 0 };
    const byType = (rank[a.type] ?? 9) - (rank[b.type] ?? 9);
    if (byType !== 0) return byType;
    // 同类型：master 清单优先，其次按发现时间倒序
    const masterA = a.enrichKind === "master" ? 0 : 1;
    const masterB = b.enrichKind === "master" ? 0 : 1;
    if (masterA !== masterB) return masterA - masterB;
    return (b.detectedAt || 0) - (a.detectedAt || 0);
  });
}

function countActiveDownloads(tasks) {
  let n = 0;
  for (const t of tasks || []) {
    const s = String(t?.status || "").toLowerCase();
    if (s === "downloading" || s === "pending" || s === "paused") n += 1;
  }
  return n;
}

/** 工具栏角标优先展示「正在下载数量」；无下载时再回落到当前页媒体数。 */
async function updateDownloadBadge(tasks) {
  const list = Array.isArray(tasks) ? tasks : await loadSentTasks();
  const active = countActiveDownloads(list);
  activeDownloadCount = active;
  try {
    if (active > 0) {
      await chrome.action.setBadgeBackgroundColor({ color: "#2563eb" });
      await chrome.action.setBadgeText({
        text: String(Math.min(active, 99)),
      });
      await chrome.action.setTitle({
        title: `百纳 · ${active} 个下载中（点开看进度）`,
      });
      return;
    }
    await chrome.action.setBadgeText({ text: "" });
    await chrome.action.setTitle({ title: "用百纳下载" });
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs[0]?.id;
    if (typeof tabId === "number" && tabId >= 0) {
      await updateMediaBadge(tabId);
    }
  } catch {
    // ignore
  }
}

async function updateMediaBadge(tabId) {
  if (activeDownloadCount > 0) return;
  const items = await listTabMedia(tabId);
  const count = countDisplayMedia(items);
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

async function updateBadge(tabId) {
  if (activeDownloadCount > 0) {
    await updateDownloadBadge();
    return;
  }
  await updateMediaBadge(tabId);
}

async function flashBadge(text, color = "#2563eb", tabId = -1) {
  try {
    const target = tabId >= 0 ? { tabId } : {};
    await chrome.action.setBadgeBackgroundColor({ color, ...target });
    await chrome.action.setBadgeText({ text, ...target });
    setTimeout(() => {
      void (async () => {
        try {
          if (activeDownloadCount > 0) {
            await updateDownloadBadge();
            return;
          }
          await chrome.action.setBadgeText({ text: "", ...target });
          if (tabId >= 0) await updateMediaBadge(tabId);
        } catch {
          // ignore
        }
      })();
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

/** 合并 Cookie 头：靠前的源优先（同名不覆盖）。 */
function mergeCookieHeaders(...parts) {
  const map = new Map();
  for (const part of parts) {
    if (!part || typeof part !== "string") continue;
    for (const pair of part.split(";")) {
      const idx = pair.indexOf("=");
      if (idx <= 0) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (!name || map.has(name)) continue;
      map.set(name, value);
    }
  }
  if (map.size === 0) return "";
  return Array.from(map.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

/**
 * Referer 用页面地址；Cookie 优先页面域（抖音 extractor 需要 douyin.com），
 * 再合并媒体 CDN 域 Cookie。
 */
async function buildHeadersForUrl(mediaUrl, pageUrl) {
  const headers = {};
  if (pageUrl || mediaUrl) headers.Referer = pageUrl || mediaUrl;
  const pageCookie = pageUrl ? await getCookieHeader(pageUrl) : "";
  const mediaCookie =
    mediaUrl && mediaUrl !== pageUrl ? await getCookieHeader(mediaUrl) : "";
  // 页面域无 Cookie 时，对抖音再试 www.douyin.com（精选页可能是子路径同域）
  let siteFallback = "";
  if (
    !pageCookie &&
    pageUrl &&
    /douyin\.com/i.test(pageUrl) &&
    !/^https?:\/\/www\.douyin\.com\/?$/i.test(pageUrl)
  ) {
    siteFallback = await getCookieHeader("https://www.douyin.com/");
  }
  // Instagram：reel/p 页 Cookie 可能不全，补 www.instagram.com 会话
  if (/instagram\.com/i.test(pageUrl || mediaUrl || "")) {
    const igRoot = await getCookieHeader("https://www.instagram.com/");
    siteFallback = mergeCookieHeaders(siteFallback, igRoot);
  }
  const cookie = mergeCookieHeaders(pageCookie, siteFallback, mediaCookie);
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

// ---- 已发送任务跟踪（桥返回 taskIds 后轮询 /tasks） ----

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(String(status || "").toLowerCase());
}

function friendlyTaskError(error) {
  const raw = String(error || "").trim();
  if (!raw) return "";
  const lower = raw.toLowerCase();
  if (
    /cookie|login|登录|登陆|sign.?in|auth|通行证|未登录|需要登录/.test(
      lower,
    )
  ) {
    return "需要登录 / Cookie，请刷新页面后重试";
  }
  return raw;
}

async function loadSentTasks() {
  try {
    const data = await chrome.storage.session.get(SENT_TASKS_KEY);
    const list = data?.[SENT_TASKS_KEY];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function saveSentTasks(list) {
  try {
    await chrome.storage.session.set({
      [SENT_TASKS_KEY]: list.slice(0, SENT_TASKS_MAX),
    });
  } catch {
    // ignore
  }
}

/**
 * @param {{taskIds: string[], items: Array<{url: string, title?: string, pageUrl?: string}>, tabId?: number}} params
 */
async function recordSentTasks({ taskIds, items, tabId = -1 }) {
  if (!Array.isArray(taskIds) || taskIds.length === 0) return;
  const now = Date.now();
  const prev = await loadSentTasks();
  const byId = new Map(prev.map((t) => [t.taskId, t]));
  for (let i = 0; i < taskIds.length; i++) {
    const taskId = String(taskIds[i] || "").trim();
    if (!taskId) continue;
    const item = items[i] || items[0] || {};
    byId.set(taskId, {
      taskId,
      url: item.url || "",
      title: item.title || "",
      pageUrl: item.pageUrl || "",
      tabId: typeof tabId === "number" ? tabId : -1,
      sentAt: now,
      status: "pending",
      progress: 0,
      error: "",
      retryUrl: item.url || "",
      retryTitle: item.title || "",
      retryPageUrl: item.pageUrl || "",
    });
  }
  const next = [...byId.values()]
    .sort((a, b) => (b.sentAt || 0) - (a.sentAt || 0))
    .slice(0, SENT_TASKS_MAX);
  await saveSentTasks(next);
  void updateDownloadBadge(next);
  ensurePollRunning();
}

function pushTaskStatusToTab(entry) {
  if (!entry || typeof entry.tabId !== "number" || entry.tabId < 0) return;
  void chrome.tabs
    .sendMessage(entry.tabId, {
      type: "taskStatus",
      taskId: entry.taskId,
      status: entry.status,
      progress: entry.progress,
      title: entry.title,
      error: friendlyTaskError(entry.error),
      url: entry.url,
      pageUrl: entry.pageUrl || entry.retryPageUrl || "",
    })
    .catch(() => {});
}

async function fetchTasksFromBridge(ids) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    const qs = encodeURIComponent(ids.join(","));
    const res = await fetch(`${BRIDGE_BASE}/tasks?ids=${qs}`, {
      method: "GET",
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data || !data.ok || !Array.isArray(data.tasks)) {
      return { ok: false, error: (data && data.error) || `HTTP ${res.status}` };
    }
    return { ok: true, tasks: data.tasks };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

async function pollSentTasksOnce() {
  const list = await loadSentTasks();
  const now = Date.now();
  const active = list.filter(
    (t) =>
      t &&
      t.taskId &&
      !isTerminalStatus(t.status) &&
      now - (t.sentAt || 0) < POLL_MAX_AGE_MS,
  );
  if (active.length === 0) {
    // 过期非终态任务标记 unknown，避免永久占位
    let aged = false;
    for (const t of list) {
      if (
        t &&
        !isTerminalStatus(t.status) &&
        now - (t.sentAt || 0) >= POLL_MAX_AGE_MS
      ) {
        t.status = "unknown";
        t.error = t.error || "状态已超时";
        aged = true;
      }
    }
    if (aged) await saveSentTasks(list);
    void updateDownloadBadge(list);
    return false;
  }

  const result = await fetchTasksFromBridge(active.map((t) => t.taskId));
  if (!result.ok) {
    pollFails += 1;
    if (pollFails >= POLL_MAX_FAILS) {
      for (const t of active) {
        t.status = "unknown";
        t.error = "无法获取进度（桥未连接）";
        pushTaskStatusToTab(t);
      }
      await saveSentTasks(list);
      pollFails = 0;
      return false;
    }
    return true;
  }

  pollFails = 0;
  const byId = new Map(result.tasks.map((t) => [t.id, t]));
  let changed = false;
  for (const entry of list) {
    const remote = byId.get(entry.taskId);
    if (!remote) continue;
    const nextStatus = String(remote.status || entry.status || "pending");
    const nextProgress =
      typeof remote.progress === "number" ? remote.progress : entry.progress;
    const nextTitle = remote.title || entry.title || "";
    const nextError = remote.error || entry.error || "";
    const didChange =
      nextStatus !== entry.status ||
      nextProgress !== entry.progress ||
      nextTitle !== entry.title ||
      nextError !== entry.error;
    if (didChange) {
      entry.status = nextStatus;
      entry.progress = nextProgress;
      entry.title = nextTitle;
      entry.error = nextError;
      changed = true;
    }
    // 非终态必须心跳推送：解析阶段可长时间停在 0%，若只在 changed 时推，
    // 页内按钮短超时会丢掉跟踪，完成后也收不到。
    if (didChange || !isTerminalStatus(entry.status)) {
      pushTaskStatusToTab(entry);
    }
  }
  if (changed) await saveSentTasks(list);
  void updateDownloadBadge(list);

  return list.some(
    (t) =>
      t &&
      t.taskId &&
      !isTerminalStatus(t.status) &&
      now - (t.sentAt || 0) < POLL_MAX_AGE_MS,
  );
}

function schedulePoll(delayMs) {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(() => {
    pollTimer = null;
    void (async () => {
      const keepGoing = await pollSentTasksOnce();
      if (keepGoing) {
        const delay = pollFails > 0 ? POLL_BACKOFF_MS : POLL_INTERVAL_MS;
        schedulePoll(delay);
      } else {
        pollRunning = false;
      }
    })();
  }, delayMs);
}

function ensurePollRunning() {
  if (pollRunning) return;
  pollRunning = true;
  pollFails = 0;
  schedulePoll(0);
}

/**
 * @param {{url: string, title?: string, headers?: Record<string,string>, pageUrl?: string, thumbnail_url?: string}[]} items
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
      const taskIds = Array.isArray(data.taskIds)
        ? data.taskIds.filter((id) => typeof id === "string" && id.trim())
        : [];
      return { ok: true, count: data.count, taskIds };
    }
    return {
      ok: false,
      error: (data && data.error) || `桥接失败 HTTP ${res.status}`,
      retryable: looksLikeBridgeRetryable(
        (data && data.error) || "",
        res.status,
      ),
    };
  } catch (err) {
    return {
      ok: false,
      error: String(err?.message || err),
      bridgeDown: true,
      retryable: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

function looksLikeBridgeRetryable(error, status) {
  const text = String(error || "").toLowerCase();
  if (status === 502 || status === 503) return true;
  return /未就绪|未启动|not ready|sidecar|下载服务|连接|econnrefused|failed to fetch|networkerror|aborted/i.test(
    text,
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @returns {Promise<{ok: boolean, sidecarReady?: boolean}>} */
async function probeBridgeHealth() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  try {
    const res = await fetch(`${BRIDGE_BASE}/health`, {
      method: "GET",
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data || !data.ok) {
      return { ok: false };
    }
    return {
      ok: true,
      sidecarReady: data.sidecarReady !== false,
    };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

const APP_MISSING_ERROR =
  "未检测到百纳桌面端。已打开安装说明；请安装并运行后再回来点下载（开发可用：npm run desktop）。";

/**
 * 打开扩展内安装引导页（内含官网下载链接占位）。
 * 冷却期内不重复弹页，避免连点刷标签。
 */
async function openInstallGuide({ force = false } = {}) {
  try {
    if (!force) {
      const data = await chrome.storage.session.get(INSTALL_GUIDE_OPEN_KEY);
      const last = Number(data?.[INSTALL_GUIDE_OPEN_KEY] || 0);
      if (last && Date.now() - last < INSTALL_GUIDE_COOLDOWN_MS) {
        return { ok: true, throttled: true };
      }
    }
    await chrome.storage.session.set({
      [INSTALL_GUIDE_OPEN_KEY]: Date.now(),
    });
    await chrome.tabs.create({
      url: chrome.runtime.getURL("install.html"),
      active: true,
    });
    return { ok: true };
  } catch (err) {
    // 退而求其次：直接打开官网占位地址
    try {
      await chrome.tabs.create({ url: DOWNLOAD_SITE_URL, active: true });
      return { ok: true, via: "site" };
    } catch (err2) {
      return { ok: false, error: String(err2?.message || err2 || err) };
    }
  }
}

/** 通过 downany://open 拉起 / 聚焦本机客户端（不入队）。必须前台标签，否则 Chrome 常不触发协议。 */
async function wakeAppViaProtocol() {
  const redirect =
    chrome.runtime.getURL("redirect.html") + "?action=open";
  const tab = await chrome.tabs.create({ url: redirect, active: true });
  // 给系统一点时间弹出「打开百纳？」并完成唤起
  await sleep(2500);
  if (tab?.id != null) {
    void chrome.tabs.remove(tab.id).catch(() => {});
  }
}

/**
 * 等待本机桥 + Sidecar 可入队。
 * @returns {Promise<boolean>}
 */
async function waitForBridgeReady({
  timeoutMs = 20000,
  intervalMs = 700,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await probeBridgeHealth();
    if (health.ok && health.sidecarReady) return true;
    await sleep(intervalMs);
  }
  return false;
}

/**
 * 桥失败时：唤醒客户端 → 等就绪 → 重试一次带 Cookie 的入队。
 * @param {{url: string, title?: string, headers?: Record<string,string>}[]} items
 * @param {{ onStatus?: (msg: string) => void }} [opts]
 */
async function enqueueViaBridgeOrWake(items, { onStatus } = {}) {
  let bridge = await enqueueViaBridge(items);
  if (bridge.ok) return bridge;
  if (!bridge.retryable && !bridge.bridgeDown) return bridge;

  onStatus?.("正在打开百纳…");
  try {
    await wakeAppViaProtocol();
  } catch (err) {
    return {
      ok: false,
      error:
        "无法唤起百纳：" +
        String(err?.message || err) +
        "。" +
        APP_MISSING_ERROR,
      bridgeDown: true,
      needApp: true,
    };
  }

  onStatus?.("等待下载器就绪…");
  const ready = await waitForBridgeReady();
  if (!ready) {
    return {
      ok: false,
      error: APP_MISSING_ERROR,
      bridgeDown: true,
      needApp: true,
    };
  }

  onStatus?.("正在重新发送…");
  bridge = await enqueueViaBridge(items);
  if (bridge.ok) return { ...bridge, woke: true };
  return {
    ok: false,
    error: bridge.error || "入队失败",
    bridgeDown: !!bridge.bridgeDown,
    needApp: !!bridge.bridgeDown,
  };
}

/** 协议回退：仅支持单 URL（无 headers）；仅在已知桌面端已注册协议时偶用。 */
async function enqueueViaProtocol(pageUrl) {
  const redirect =
    chrome.runtime.getURL("redirect.html") +
    `?url=${encodeURIComponent(pageUrl)}`;
  const tab = await chrome.tabs.create({ url: redirect, active: true });
  await sleep(1800);
  if (tab?.id != null) {
    void chrome.tabs.remove(tab.id).catch(() => {});
  }
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
      finalUrl = normalizeYtdlpPageUrl(preferredPage || pageUrl || url);
    } else if (isYtdlpPreferredPage(url) || skipVerify) {
      // 「仅发送页面链接」等：入队前把 modal_id 改写成 /video/{id}
      finalUrl = normalizeYtdlpPageUrl(url);
    }
    const headers = await buildHeadersForUrl(
      finalUrl,
      normalizeYtdlpPageUrl(pageUrl || finalUrl),
    );
    prepared.push({
      url: finalUrl,
      title: raw.title || "",
      pageUrl,
      thumbnail_url: raw.thumbnail_url || raw.thumbnailUrl || "",
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

  const pushWakeStatus = (msg) => {
    if (typeof tabId === "number" && tabId >= 0) {
      void chrome.tabs
        .sendMessage(tabId, { type: "wakeStatus", message: msg })
        .catch(() => {});
    }
  };

  const bridge = await enqueueViaBridgeOrWake(valid, {
    onStatus: (msg) => {
      pushWakeStatus(msg);
      if (!silent) {
        void flashBadge("…", "#2563eb", tabId);
        // 不刷屏通知，仅角标提示；最终结果再 notify
      }
    },
  });
  if (bridge.ok) {
    const taskIds = Array.isArray(bridge.taskIds) ? bridge.taskIds : [];
    if (taskIds.length > 0) {
      await recordSentTasks({
        taskIds,
        items: valid,
        tabId,
      });
    }
    if (!silent) {
      await flashBadge("✓", "#16a34a", tabId);
      notify(
        "已加入下载器",
        expired > 0
          ? `已发送 ${valid.length} 个任务，${expired} 条链接已过期被跳过`
          : bridge.woke
            ? `已打开百纳并发送 ${valid.length} 个任务`
            : `已发送 ${valid.length} 个任务`,
      );
    }
    return {
      ok: true,
      via: bridge.woke ? "bridge-wake" : "bridge",
      count: valid.length,
      expired,
      taskIds,
      woke: !!bridge.woke,
    };
  }

  // 唤醒后仍连不上：说明本机没有可用桌面端（或协议未注册）。
  // 绝不把协议投递当成成功 — 否则页内按钮会闪「已入队」却什么都没发生。
  const error = String(bridge.error || APP_MISSING_ERROR);
  await flashBadge("!", "#dc2626", tabId);
  if (bridge.needApp) {
    void openInstallGuide();
  }
  // 页内 silent 也要提示：否则用户以为点了没反应
  notify("需要安装百纳", error);
  return {
    ok: false,
    error,
    needApp: true,
    installUrl: chrome.runtime.getURL("install.html"),
    downloadUrl: DOWNLOAD_SITE_URL,
    expired,
  };
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
      title: "用百纳下载此页面",
      contexts: ["page"],
    });
    chrome.contextMenus.create({
      id: MENU_LINK,
      title: "用百纳下载此链接",
      contexts: ["link"],
    });
    chrome.contextMenus.create({
      id: MENU_SELECTION,
      title: "用百纳下载选中链接",
      contexts: ["selection"],
    });
    chrome.contextMenus.create({
      id: MENU_MEDIA,
      title: "用百纳下载此媒体",
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

  if (message.type === "pageNavigated") {
    const tabId =
      typeof message.tabId === "number" ? message.tabId : sender.tab?.id;
    if (typeof tabId === "number" && message.pageUrl) {
      rememberVideoKey(tabId, message.pageUrl);
      if (
        isYtdlpPreferredPage(message.pageUrl) ||
        videoIdentityKey(message.pageUrl).startsWith("douyin:")
      ) {
        setActiveVideoPage(
          tabId,
          message.pageUrl,
          message.pageTitle || "",
        );
      }
    }
    return false;
  }

  if (message.type === "activeVideoPage") {
    const tabId =
      typeof message.tabId === "number" ? message.tabId : sender.tab?.id;
    if (typeof tabId === "number" && message.pageUrl) {
      setActiveVideoPage(tabId, message.pageUrl, message.title || "");
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

  if (message.type === "quickDownload") {
    const tabId =
      typeof message.tabId === "number" ? message.tabId : sender.tab?.id;
    void (async () => {
      if (typeof tabId !== "number" || tabId < 0) {
        sendResponse({ ok: false, error: "无法定位当前标签页" });
        return;
      }
      const pageUrl = normalizeYtdlpPageUrl(
        String(message.pageUrl || "").trim(),
      );
      const title = String(message.title || "");

      if (pageUrl && isYtdlpPreferredPage(pageUrl)) {
        sendResponse(
          await sendItemsToDownloader(
            [{ url: pageUrl, pageUrl, title }],
            { silent: true, skipVerify: true, tabId },
          ),
        );
        return;
      }

      const media = await listTabMedia(tabId);
      if (media.length > 0) {
        const best = media[0];
        sendResponse(
          await sendItemsToDownloader(
            [
              {
                url: best.url,
                type: best.type || "",
                title: title || best.title || best.pageTitle || "",
                pageUrl: pageUrl || best.pageUrl || "",
                detectedAt: best.detectedAt || 0,
              },
            ],
            { silent: true, tabId },
          ),
        );
        return;
      }

      sendResponse({
        ok: false,
        error: "未识别到可下载媒体，试试播放视频后再点",
      });
    })();
    return true;
  }

  if (message.type === "openInstallGuide") {
    void openInstallGuide({ force: !!message.force }).then((result) => {
      sendResponse(result);
    });
    return true;
  }

  if (message.type === "getSentTasks") {
    void (async () => {
      ensurePollRunning();
      const tasks = await loadSentTasks();
      sendResponse({
        ok: true,
        tasks: tasks.map((t) => ({
          ...t,
          error: friendlyTaskError(t.error),
        })),
      });
    })();
    return true;
  }

  if (message.type === "retrySend") {
    void (async () => {
      const taskId = String(message.taskId || "").trim();
      const tasks = await loadSentTasks();
      const entry = tasks.find((t) => t.taskId === taskId);
      const url = String(
        message.url || entry?.retryUrl || entry?.url || "",
      ).trim();
      if (!url) {
        sendResponse({ ok: false, error: "找不到可重试的链接" });
        return;
      }
      const pageUrl = String(
        message.pageUrl || entry?.retryPageUrl || entry?.pageUrl || "",
      );
      const title = String(
        message.title || entry?.retryTitle || entry?.title || "",
      );
      const tabId =
        typeof message.tabId === "number"
          ? message.tabId
          : typeof entry?.tabId === "number"
            ? entry.tabId
            : -1;
      const result = await sendItemsToDownloader(
        [{ url, pageUrl, title }],
        {
          silent: true,
          skipVerify: isYtdlpPreferredPage(url) || isYtdlpPreferredPage(pageUrl),
          tabId,
        },
      );
      sendResponse(result);
    })();
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

// SW 被回收后重启时，若还有未终态任务则继续轮询
void loadSentTasks().then((tasks) => {
  if (
    tasks.some(
      (t) => t && t.taskId && !isTerminalStatus(t.status),
    )
  ) {
    ensurePollRunning();
  }
});
