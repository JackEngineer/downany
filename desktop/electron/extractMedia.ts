import type { MediaTypeHint } from "./mediaSniff";

export type MediaObservation = {
  url: string;
  elementKey: string;
  title?: string;
  poster?: string;
  duration?: number;
  width?: number;
  height?: number;
  kind: "video" | "audio";
};
export type ExtractMediaItem = {
  id: string;
  url: string;
  type: MediaTypeHint | "unknown";
  contentType?: string;
  pageId: number;
  sourceHost: string;
  title?: string;
  poster?: string;
  duration?: number;
  width?: number;
  height?: number;
  bytes?: number;
  kind?: "video" | "audio";
  elementKey?: string;
  matched?: boolean;
  added?: boolean;
  pending?: boolean;
};
export type ExtractSnapshot = { pageId: number; items: ExtractMediaItem[]; history: ExtractMediaItem[] };

export class ExtractMediaStore {
  pageId = 0;
  private sequence = 0;
  private items = new Map<string, ExtractMediaItem>();
  private history: ExtractMediaItem[] = [];
  beginPage(): void {
    this.history = [...this.items.values(), ...this.history].slice(0, 100);
    this.items.clear();
    this.pageId++;
  }
  snapshot(): ExtractSnapshot {
    return { pageId: this.pageId, items: [...this.items.values()], history: this.history };
  }
  upsert(url: string, type: ExtractMediaItem["type"], patch: Partial<Pick<ExtractMediaItem, "contentType" | "bytes">> = {}, pageId = this.pageId): void {
    if (pageId !== this.pageId) return;
    let parsed: URL;
    try { parsed = new URL(url); } catch { return; }
    if (!["http:", "https:"].includes(parsed.protocol)) return;
    const previous = this.items.get(url);
    this.items.set(url, {
      ...(previous || { id: `m-${++this.sequence}`, url, pageId, sourceHost: parsed.hostname, type }),
      ...patch,
      type: type === "unknown" && previous ? previous.type : type,
    });
  }
  observe(observations: MediaObservation[], pageId: number): void {
    if (pageId !== this.pageId) return;
    const byUrl = new Map<string, MediaObservation[]>();
    for (const observation of observations) {
      const matches = byUrl.get(observation.url) || [];
      matches.push(observation); byUrl.set(observation.url, matches);
    }
    for (const item of this.items.values()) {
      const matches = byUrl.get(item.url);
      // Exact URL with one actual DOM media element; never associate by page title alone.
      if (matches?.length !== 1) { item.matched = false; continue; }
      const observation = matches[0];
      item.matched = true;
      item.elementKey = observation.elementKey;
      item.kind = observation.kind;
      const title = typeof observation.title === "string" ? observation.title.trim().slice(0, 180) : "";
      if (title) item.title = title;
      if (typeof observation.poster === "string" && /^(https?:|data:image\/(png|jpeg|webp);base64,)/i.test(observation.poster)) item.poster = observation.poster;
      for (const field of ["duration", "width", "height"] as const) {
        const value = observation[field];
        if (typeof value === "number" && Number.isFinite(value) && value > 0) item[field] = value;
      }
    }
  }
  get(id: string): ExtractMediaItem | undefined { return [...this.items.values()].find(item => item.id === id); }
  claim(ids: string[]): ExtractMediaItem[] {
    const items = [...new Set(ids)].map(id => this.get(id));
    if (!items.length || items.some(item => !item || item.added || item.pending)) return [];
    for (const item of items) item!.pending = true;
    return items as ExtractMediaItem[];
  }
  finish(items: ExtractMediaItem[], success: boolean): void {
    for (const item of items) { item.pending = false; if (success) item.added = true; }
  }
}

export function responseMediaBytes(headers: Record<string, string[]>): number | undefined {
  const get = (name: string) => Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1]?.[0];
  const range = get("content-range");
  const value = range ? /^bytes \d+-\d+\/(\d+)$/.exec(range)?.[1] : get("content-length");
  const bytes = Number(value);
  return value && Number.isSafeInteger(bytes) && bytes > 0 ? bytes : undefined;
}

/** Runs in the guest's isolated world, reads loaded DOM only; no fetch, cookies or page bridge. */
export function collectLoadedMedia(): MediaObservation[] {
  const media = [...document.querySelectorAll<HTMLMediaElement>("video,audio")].slice(0, 40);
  const visibleVideos = media.filter(el => el.tagName === "VIDEO" && el.getBoundingClientRect().width > 80 && el.getBoundingClientRect().height > 60);
  return media.map((el, index) => {
    const video = el as HTMLVideoElement;
    const region = el.closest("figure,article,[data-video-id]");
    let title = el.getAttribute("aria-label") || el.getAttribute("title") || "";
    if (!title && region && region.querySelectorAll("video,audio").length === 1) title = region.querySelector("figcaption,h1,h2,h3")?.textContent || "";
    // A dedicated single-video detail page is a stronger relation than a generic page title.
    if (!title && visibleVideos.length === 1 && visibleVideos[0] === el && /^\/video\/\d+\/?$/.test(location.pathname) && document.querySelectorAll("h1").length === 1) title = document.querySelector("h1")?.textContent || "";
    return {
      url: el.currentSrc || el.src,
      elementKey: `media-${index}`,
      title: title.trim().slice(0, 180),
      poster: el.tagName === "VIDEO" ? video.poster : undefined,
      duration: Number.isFinite(el.duration) ? el.duration : undefined,
      width: video.videoWidth || undefined,
      height: video.videoHeight || undefined,
      kind: el.tagName === "VIDEO" ? "video" as const : "audio" as const,
    };
  }).filter(item => /^https?:\/\//i.test(item.url));
}

export function locateLoadedMedia(url: string): boolean {
  const media = [...document.querySelectorAll<HTMLMediaElement>("video,audio")];
  const matches = media.filter(el => (el.currentSrc || el.src) === url);
  if (matches.length !== 1) return false;
  const element = matches[0];
  element.scrollIntoView({ block: "center", behavior: "smooth" });
  const previous = element.style.outline;
  element.style.outline = "3px solid #0a84ff";
  setTimeout(() => { element.style.outline = previous; }, 1800);
  return true;
}
