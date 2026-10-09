/** Credentials stay in Electron's native Session; this module never reads them. */
export type EmbeddedRetryCode = "invalid" | "session_required" | "rejected" | "unavailable" | "network" | "busy";
export class EmbeddedRetryError extends Error {
  constructor(readonly code: EmbeddedRetryCode) { super(code); }
}
export interface ResolvedDouyinVideo { originalUrl: string; mediaUrl: string; title: string; }
export function douyinVideoUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.origin !== "https://www.douyin.com" || url.username || url.password || url.search || url.hash || !/^\/video\/\d+$/.test(url.pathname)) throw new Error();
    return url.href;
  } catch { throw new EmbeddedRetryError("invalid"); }
}
export function safeDouyinMediaUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 8192) throw new EmbeddedRetryError("unavailable");
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port ||
      !(url.hostname === "video-web-cn.douyin.com" || /^v\d+-(?:web|dy)\.douyinvod\.com$/.test(url.hostname)) || /\.(?:m3u8|mpd)(?:$|\/)/i.test(url.pathname)) throw new Error();
    return url.href;
  } catch { throw new EmbeddedRetryError("unavailable"); }
}
async function readLimitedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new EmbeddedRetryError("unavailable");
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) { const next = await reader.read(); if (next.done) break; bytes += next.value.length;
      if (bytes > 2 * 1024 * 1024) throw new EmbeddedRetryError("unavailable"); chunks.push(next.value); }
    const joined = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder().decode(joined));
  } catch { throw new EmbeddedRetryError("unavailable"); }
  finally { await reader.cancel().catch(() => {}); }
}
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" ? value as Record<string, unknown> : {}; }
export async function resolveDouyinUsingNativeSession(original: string, nativeFetch: (input: string, init: RequestInit) => Promise<Response>): Promise<ResolvedDouyinVideo> {
  const originalUrl = douyinVideoUrl(original), id = new URL(originalUrl).pathname.split("/").pop()!;
  const endpoint = `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${id}`;
  const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 20_000);
  try {
    // redirect:error prevents cookies from following ANY redirect, including same-origin.
    const response = await nativeFetch(endpoint, { credentials: "include", redirect: "error", cache: "no-store", signal: abort.signal, headers: { Referer: originalUrl } });
    if (response.redirected || (response.url && response.url !== endpoint)) throw new EmbeddedRetryError("rejected");
    if ([401, 403].includes(response.status)) throw new EmbeddedRetryError("rejected");
    if (!response.ok) throw new EmbeddedRetryError("unavailable");
    const body = record(await readLimitedJson(response)), detail = record(body.aweme_detail);
    if (String(detail.aweme_id || "") !== id) throw new EmbeddedRetryError("unavailable");
    const title = typeof detail.desc === "string" ? detail.desc.trim().slice(0, 500) : "";
    if (!title || /[\u0000-\u001f]/.test(title)) throw new EmbeddedRetryError("unavailable");
    const addresses = record(record(detail.video).play_addr).url_list;
    if (!Array.isArray(addresses)) throw new EmbeddedRetryError("unavailable");
    for (const value of addresses) { try { return { originalUrl, title, mediaUrl: safeDouyinMediaUrl(value) }; } catch {} }
    throw new EmbeddedRetryError("unavailable");
  } catch (error) { throw error instanceof EmbeddedRetryError ? error : new EmbeddedRetryError("network"); }
  finally { clearTimeout(timeout); }
}
export function createEmbeddedDouyinRetry(deps: {
  readTask: (id: string) => Promise<{ url: string; status: string } | undefined>;
  nativeFetch: (input: string, init: RequestInit) => Promise<Response>;
  apply: (id: string, video: ResolvedDouyinVideo) => Promise<void>;
}) {
  const pending = new Map<string, Promise<{ ok: boolean; code?: EmbeddedRetryCode }>>();
  return (id: string) => {
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(id)) return Promise.resolve({ ok: false, code: "invalid" as const });
    const existing = pending.get(id); if (existing) return existing;
    const run = (async () => {
      try {
        const task = await deps.readTask(id);
        if (!task || task.status !== "failed") throw new EmbeddedRetryError("busy");
        const video = await resolveDouyinUsingNativeSession(task.url, deps.nativeFetch);
        await deps.apply(id, video); return { ok: true };
      } catch (error) { return { ok: false, code: error instanceof EmbeddedRetryError ? error.code : "unavailable" as const }; }
    })();
    pending.set(id, run); void run.finally(() => pending.delete(id)); return run;
  };
}
