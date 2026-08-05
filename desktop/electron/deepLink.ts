/** downany:// 深度链接解析（纯函数，便于单测）。 */

export const PROTOCOL_SCHEME = "downany";

const HTTP_URL_RE = /^https?:\/\/\S+$/i;

export type DeepLinkAddPayload = {
  url: string;
  quality?: string;
  audioOnly?: boolean;
  downloadSubtitles?: boolean;
};

function truthyParam(value: string | null): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * 从单条候选字符串解析出可下载的 http(s) URL。
 * 支持：
 * - `downany://add?url=<encoded>`
 * - `downany:add?url=<encoded>`（少见写法）
 * - 裸 `https://...` / `http://...`
 */
export function parseDeepLinkCandidate(raw: string): string | null {
  const payload = parseDeepLinkAdd(raw);
  return payload?.url ?? null;
}

/** 解析 downany://add 完整参数（url / quality / audio / subs）。 */
export function parseDeepLinkAdd(raw: string): DeepLinkAddPayload | null {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return null;

  if (HTTP_URL_RE.test(trimmed)) {
    const url = sanitizeHttpUrl(trimmed);
    return url ? { url } : null;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== `${PROTOCOL_SCHEME}:`) {
    return null;
  }

  const hostOrPath = (parsed.hostname || parsed.pathname.replace(/^\//, "")).toLowerCase();
  if (hostOrPath !== "add") {
    return null;
  }

  const urlParam = parsed.searchParams.get("url");
  if (!urlParam) return null;
  const url = sanitizeHttpUrl(urlParam.trim());
  if (!url) return null;

  const quality = parsed.searchParams.get("quality")?.trim() || undefined;
  const audioOnly = truthyParam(parsed.searchParams.get("audio"));
  const downloadSubtitles = truthyParam(parsed.searchParams.get("subs"));

  return {
    url,
    quality,
    audioOnly: audioOnly || undefined,
    downloadSubtitles: downloadSubtitles || undefined,
  };
}

/** 从 argv / commandLine 中提取全部可识别的下载 URL（去重保序）。 */
export function extractUrlsFromArgv(argv: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const arg of argv) {
    const url = parseDeepLinkCandidate(arg);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

/** 从 argv 提取带选项的 deep link 入队载荷（去重保序）。 */
export function extractAddsFromArgv(argv: readonly string[]): DeepLinkAddPayload[] {
  const seen = new Set<string>();
  const out: DeepLinkAddPayload[] = [];
  for (const arg of argv) {
    const payload = parseDeepLinkAdd(arg);
    if (!payload || seen.has(payload.url)) continue;
    seen.add(payload.url);
    out.push(payload);
  }
  return out;
}

function sanitizeHttpUrl(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  return parsed.toString();
}

/** 构造扩展侧打开的协议 URL。 */
export function buildAddDeepLink(pageUrl: string): string {
  return `${PROTOCOL_SCHEME}://add?url=${encodeURIComponent(pageUrl)}`;
}

/**
 * 仅唤醒 / 聚焦应用的深链（不入队）。
 * 供扩展在本机桥不可达时拉起客户端，再走 HTTP 桥带 Cookie 入队。
 */
export function buildOpenDeepLink(): string {
  return `${PROTOCOL_SCHEME}://open`;
}

/** 是否为唤醒深链：`downany://open` / `downany://wake`。 */
export function isOpenDeepLink(raw: string): boolean {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return false;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  if (parsed.protocol !== `${PROTOCOL_SCHEME}:`) {
    return false;
  }
  const hostOrPath = (
    parsed.hostname || parsed.pathname.replace(/^\//, "")
  ).toLowerCase();
  return hostOrPath === "open" || hostOrPath === "wake";
}
