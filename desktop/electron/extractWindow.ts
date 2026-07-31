import { BrowserWindow, session, type Session } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";

import type { BridgeEnqueueItem } from "./bridgeServer";
import {
  classifyByContentType,
  isSegmentUrl,
  looksLikeMediaUrl,
  type MediaTypeHint,
} from "./mediaSniff";

export const EXTRACT_PARTITION = "persist:extract";

export type ExtractMediaItem = {
  id: string;
  url: string;
  type: MediaTypeHint | "unknown";
  contentType?: string;
};

let extractWindow: BrowserWindow | null = null;
let sniffInstalled = false;
const candidates = new Map<string, ExtractMediaItem>();
let itemCounter = 0;

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
  const list = Array.from(candidates.values());
  window.webContents.send("extract:list", list);
}

function addCandidate(
  url: string,
  type: MediaTypeHint | "unknown",
  contentType?: string,
): void {
  if (isSegmentUrl(url) || candidates.has(url)) return;
  if (type === "unknown" && !looksLikeMediaUrl(url)) return;

  itemCounter += 1;
  candidates.set(url, {
    id: `m-${itemCounter}`,
    url,
    type,
    ...(contentType ? { contentType } : {}),
  });
  notifyList(extractWindow);
}

function installSniffHandlers(ses: Session): void {
  if (sniffInstalled) return;
  sniffInstalled = true;

  ses.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    if (!isSegmentUrl(details.url) && looksLikeMediaUrl(details.url)) {
      addCandidate(details.url, "unknown");
    }
    callback({});
  });

  ses.webRequest.onHeadersReceived({ urls: ["<all_urls>"] }, (details, callback) => {
    const headers = details.responseHeaders || {};
    const ct =
      headers["content-type"]?.[0] ||
      headers["Content-Type"]?.[0] ||
      null;
    const hint = classifyByContentType(ct);
    if (hint && !isSegmentUrl(details.url)) {
      addCandidate(details.url, hint, ct || undefined);
    }
    callback({ responseHeaders: details.responseHeaders });
  });
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
  items: Array<{ url: string; title?: string }>,
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
  if (!trimmed) {
    throw new Error("URL 不能为空");
  }

  const ses = session.fromPartition(EXTRACT_PARTITION);
  installSniffHandlers(ses);

  if (extractWindow && !extractWindow.isDestroyed()) {
    extractWindow.focus();
    extractWindow.webContents.send("extract:navigate", trimmed);
    notifyList(extractWindow);
    return extractWindow;
  }

  candidates.clear();
  itemCounter = 0;

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
  candidates.clear();
  itemCounter = 0;
}
