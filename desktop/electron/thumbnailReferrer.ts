/**
 * Pornhub CDN（*.phncdn.com）封面图要求 Referer 来自 pornhub.com，
 * 否则返回 403。Electron 页面源是 localhost/file，默认 Referer 无效；
 * 且 UI 对 B 站封面使用 no-referrer，会一并去掉 Referer。
 * 在 webRequest 里对 phncdn 强制注入 Referer。
 */

const PORNHUB_REFERRER = "https://www.pornhub.com/";

export function needsPornhubThumbnailReferrer(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "phncdn.com" || host.endsWith(".phncdn.com");
  } catch {
    return false;
  }
}

export function patchThumbnailRequestHeaders(
  url: string,
  requestHeaders: Record<string, string>,
): Record<string, string> {
  if (!needsPornhubThumbnailReferrer(url)) {
    return requestHeaders;
  }
  const headers: Record<string, string> = { ...requestHeaders };
  // Electron 可能用不同大小写；统一清掉再写标准 Referer
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === "referer") {
      delete headers[key];
    }
  }
  headers.Referer = PORNHUB_REFERRER;
  return headers;
}
