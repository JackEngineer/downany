/** 剪贴板监控：发现新复制的 URL 时回调（自动入队由调用方决定）。 */
import { clipboard } from "electron";

const URL_RE = /https?:\/\/[^\s<>"'，。；、）)\]]+/gi;

export function extractUrlsFromText(text: string): string[] {
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

export class ClipboardWatcher {
  private timer: NodeJS.Timeout | null = null;
  private lastText = "";
  private seenUrls = new Set<string>();

  constructor(
    private readonly onUrls: (urls: string[]) => void,
    private readonly intervalMs = 1500,
  ) {}

  start(): void {
    if (this.timer) return;
    this.lastText = clipboard.readText();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  private tick(): void {
    const text = clipboard.readText().trim();
    if (!text || text === this.lastText) return;
    this.lastText = text;
    const urls = extractUrlsFromText(text).filter((u) => !this.seenUrls.has(u));
    if (urls.length === 0) return;
    for (const url of urls) this.seenUrls.add(url);
    this.onUrls(urls);
  }
}
