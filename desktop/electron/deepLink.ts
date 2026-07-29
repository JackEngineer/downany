/** videodl:// 深度链接解析（纯函数，便于单测）。 */

export const PROTOCOL_SCHEME = "videodl";

const HTTP_URL_RE = /^https?:\/\/\S+$/i;

/**
 * 从单条候选字符串解析出可下载的 http(s) URL。
 * 支持：
 * - `videodl://add?url=<encoded>`
 * - `videodl:add?url=<encoded>`（少见写法）
 * - 裸 `https://...` / `http://...`
 */
export function parseDeepLinkCandidate(raw: string): string | null {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return null;

  if (HTTP_URL_RE.test(trimmed)) {
    return sanitizeHttpUrl(trimmed);
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
  return sanitizeHttpUrl(urlParam.trim());
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
