/** 解析 macOS .webloc 文件内容（XML plist），提取 URL。 */
export function parseWeblocUrl(content: string): string | null {
  const match = content.match(/<key>URL<\/key>\s*<string>([^<]+)<\/string>/i);
  if (!match) return null;
  const url = match[1]
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
  return url.startsWith("http://") || url.startsWith("https://") ? url : null;
}
