/** Web entries open the original site; they never produce in-app search results. */
export const SEARCH_PLATFORMS = [
  { key: "youtube", label: "YouTube", kind: "in-app" },
  { key: "bilibili", label: "Bilibili", kind: "in-app" },
  { key: "x", label: "X", kind: "web" },
  { key: "douyin", label: "抖音", kind: "web" },
  { key: "kuaishou", label: "快手", kind: "web" },
] as const;

export function webSearchUrl(platform: string, query: string): string | null {
  const text = query.trim();
  if (!text || text.length > 300) return null;
  const encoded = encodeURIComponent(text);
  switch (platform) {
    case "x": return `https://x.com/search?q=${encoded}&src=typed_query&f=video`;
    case "douyin": return `https://www.douyin.com/search/${encoded}?type=video`;
    case "kuaishou": return `https://www.kuaishou.com/search/video?searchKey=${encoded}`;
    default: return null;
  }
}
