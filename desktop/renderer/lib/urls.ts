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
