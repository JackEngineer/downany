/** 从任意文本中提取 http(s) URL，去重保序。 */
const URL_RE = /https?:\/\/[^\s<>"'，。；、）)\]]+/gi;

export function extractUrls(text: string): string[] {
  const matches = text.match(URL_RE) || [];
  const cleaned = matches.map((u) => u.replace(/[.,;:!?]+$/g, ""));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of cleaned) {
    if (!seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}

/** 粗判播放列表/合集链接：即使「自动开始」也应走选集确认。 */
export function looksLikePlaylistUrl(url: string): boolean {
  const text = (url || "").trim();
  if (!text) return false;
  try {
    const u = new URL(text);
    if (u.searchParams.has("list")) return true;
    const path = u.pathname.toLowerCase();
    if (path.includes("/playlist")) return true;
    if (path.includes("/lists/") || path.includes("/collection/") || path.includes("/series/")) {
      return true;
    }
    const host = u.hostname.toLowerCase();
    if (host.includes("bilibili.com")) {
      if (u.searchParams.has("p")) return true;
      if (path.includes("season") || path.includes("favlist") || path.includes("/lists/")) {
        return true;
      }
    }
    return false;
  } catch {
    return /[?&]list=|\/playlist\b|\/lists\/|\/collection\//i.test(text);
  }
}
