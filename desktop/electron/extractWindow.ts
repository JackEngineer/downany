import { BrowserWindow, session, type Session, type WebContents } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";

import type { BridgeEnqueueItem } from "./bridgeServer";
import {
  classifyByContentType,
  isSegmentUrl,
  looksLikeMediaUrl,
  type MediaTypeHint,
} from "./mediaSniff";

import { installExtractGuestPolicy, installExtractSessionPolicy, isExtractWebUrl, isExtractNavigationUrl } from "./extractNavigation";

export const EXTRACT_PARTITION = "persist:extract";

export type { ExtractMediaItem } from "./extractMedia";
import { ExtractMediaStore, collectLoadedMedia, locateLoadedMedia, responseMediaBytes } from "./extractMedia";

let extractWindow: BrowserWindow | null = null;
let sniffInstalled = false;
let mediaStore = new ExtractMediaStore();
let extractGuest: WebContents | null = null;
let observationTimer: ReturnType<typeof setInterval> | null = null;
let observing = false;
const requests = new Map<number, number>();

function extractHtmlPath(): string {
  const built = path.join(__dirname, "extract.html");
  if (fs.existsSync(built)) return built;
  return path.join(__dirname, "..", "electron", "extract.html");
}

function extractPreloadPath(): string {
  return path.join(__dirname, "extractPreload.js");
}

function notifyList(window: BrowserWindow | null): void {
  if (!window || window.isDestroyed()) return;
  window.webContents.send("extract:list", mediaStore.snapshot());
}

async function observeGuest(): Promise<void> {
  const guest = extractGuest;
  if (!guest || guest.isDestroyed() || observing) return;
  const pageId = mediaStore.pageId;
  observing = true;
  try {
    const observations = await guest.executeJavaScriptInIsolatedWorld(1001, [{ code: `(${collectLoadedMedia.toString()})()` }]);
    if (guest === extractGuest && Array.isArray(observations)) {
      const before = JSON.stringify(mediaStore.snapshot());
      mediaStore.observe(observations, pageId);
      if (before !== JSON.stringify(mediaStore.snapshot())) notifyList(extractWindow);
    }
  } catch { /* Navigating or unsupported DOM: keep honest unknown metadata. */ }
  finally { observing = false; }
}

function installSniffHandlers(ses: Session): void {
  if (sniffInstalled) return;
  sniffInstalled = true;
  installExtractSessionPolicy(ses);
  ses.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    if (details.webContentsId === extractGuest?.id) {
      requests.set(details.id, mediaStore.pageId);
      if (!isSegmentUrl(details.url) && looksLikeMediaUrl(details.url)) {
        mediaStore.upsert(details.url, "unknown");
        notifyList(extractWindow);
      }
    }
    callback({});
  });
  ses.webRequest.onHeadersReceived({ urls: ["<all_urls>"] }, (details, callback) => {
    const pageId = requests.get(details.id);
    if (details.webContentsId === extractGuest?.id && pageId !== undefined) {
      const headers = details.responseHeaders || {};
      const ct = Object.entries(headers).find(([key]) => key.toLowerCase() === "content-type")?.[1]?.[0];
      const hint = classifyByContentType(ct);
      if (hint && !isSegmentUrl(details.url)) {
        mediaStore.upsert(details.url, hint, { contentType: ct, ...(hint === "file" || hint === "audio" ? { bytes: responseMediaBytes(headers) } : {}) }, pageId);
        notifyList(extractWindow);
        void observeGuest();
      }
    }
    callback({ responseHeaders: details.responseHeaders });
  });
  const forget = (details: { id: number }) => { requests.delete(details.id); };
  ses.webRequest.onCompleted(forget);
  ses.webRequest.onErrorOccurred(forget);
}

export async function locateExtractMedia(id: string): Promise<boolean> {
  const item = mediaStore.get(id);
  const guest = extractGuest;
  if (!item?.matched || !guest || guest.isDestroyed()) return false;
  try {
    return await guest.executeJavaScriptInIsolatedWorld(1001, [{ code: `(${locateLoadedMedia.toString()})(${JSON.stringify(item.url)})` }]);
  } catch { return false; }
}

export async function enqueueExtractMedia(
  ids: string[],
  enqueue: (items: BridgeEnqueueItem[]) => Promise<{ ok: boolean; count?: number }>,
): Promise<{ ok: boolean; error?: string; count?: number }> {
  const items = mediaStore.claim(ids);
  if (!items.length) return { ok: false, error: "请选择当前页面尚未加入的媒体", count: 0 };
  notifyList(extractWindow);
  let success = false;
  try {
    const bridgeItems = await buildExtractEnqueueItems(getExtractSession(), items);
    const result = await enqueue(bridgeItems);
    success = result.ok;
    return success ? result : { ok: false, error: "加入下载失败，请重试", count: 0 };
  } catch { return { ok: false, error: "加入下载失败，请重试", count: 0 }; }
  finally { mediaStore.finish(items, success); notifyList(extractWindow); }
}

async function cookieHeaderForUrl(ses: Session, targetUrl: string): Promise<string | undefined> {
  try {
    const cookies = await ses.cookies.get({ url: targetUrl });
    if (cookies.length === 0) return undefined;
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  } catch {
    return undefined;
  }
}

export async function buildExtractEnqueueItems(
  ses: Session,
  items: Array<{ url: string; title?: string; matched?: boolean }>,
): Promise<BridgeEnqueueItem[]> {
  const out: BridgeEnqueueItem[] = [];
  for (const item of items) {
    const url = item.url.trim();
    if (!url) continue;
    const headers: Record<string, string> = {};
    const cookie = await cookieHeaderForUrl(ses, url);
    if (cookie) headers.Cookie = cookie;
    out.push({
      url,
      ...(item.title ? { title: item.title } : {}),
      ...(item.title && item.matched ? { media_title_verified: true } : {}),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    });
  }
  return out;
}

export function getExtractWindow(): BrowserWindow | null {
  return extractWindow;
}

export function openExtractWindow(url: string): BrowserWindow {
  const trimmed = url.trim();
  if (!isExtractWebUrl(trimmed)) {
    throw new Error("请输入有效的 HTTP 或 HTTPS 网页地址");
  }

  const ses = session.fromPartition(EXTRACT_PARTITION);
  installSniffHandlers(ses);

  if (extractWindow && !extractWindow.isDestroyed()) {
    extractWindow.focus();
    extractWindow.webContents.send("extract:navigate", trimmed);
    notifyList(extractWindow);
    return extractWindow;
  }

  mediaStore = new ExtractMediaStore();
  requests.clear();

  extractWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 800,
    minHeight: 520,
    title: "浏览器抓取",
    show: false,
    webPreferences: {
      preload: extractPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
      partition: EXTRACT_PARTITION,
    },
  });

  extractWindow.webContents.on("will-attach-webview", (event, preferences, params) => {
    if (params.partition !== EXTRACT_PARTITION || !isExtractNavigationUrl(params.src)) {
      event.preventDefault();
      return;
    }
    delete preferences.preload;
    preferences.nodeIntegration = false;
    preferences.contextIsolation = true;
  });
  extractWindow.webContents.on("did-attach-webview", (_event, guest) => {
    installExtractGuestPolicy(guest);
    extractGuest = guest;
    guest.on("did-start-navigation", (_event, _url, _inPlace, isMainFrame) => {
      if (isMainFrame) { mediaStore.beginPage(); notifyList(extractWindow); }
    });
    guest.on("dom-ready", () => { void observeGuest(); });
    if (observationTimer) clearInterval(observationTimer);
    observationTimer = setInterval(() => { void observeGuest(); }, 1500);

  });

  extractWindow.once("ready-to-show", () => {
    extractWindow?.show();
  });

  const htmlPath = extractHtmlPath();
  void extractWindow.loadFile(htmlPath, {
    query: { url: trimmed },
  });

  extractWindow.webContents.on("did-finish-load", () => {
    notifyList(extractWindow);
  });

  extractWindow.on("closed", () => {
    extractWindow = null;
    extractGuest = null;
    if (observationTimer) clearInterval(observationTimer);
    observationTimer = null;
    requests.clear();
  });

  return extractWindow;
}

export function getExtractSession(): Session {
  return session.fromPartition(EXTRACT_PARTITION);
}

/** 测试用：重置模块状态 */
export function resetExtractWindowStateForTests(): void {
  extractWindow = null;
  sniffInstalled = false;
  mediaStore = new ExtractMediaStore();
  requests.clear();
}
