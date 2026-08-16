export interface ArtworkDimensions {
  width: number;
  height: number;
}

export type ArtworkQuality = "standard" | "weak" | "missing";
export type ArtworkShape = "landscape" | "portrait" | "unknown";
export type ArtworkTone = "dark" | "medium" | "light";

function validDimensions(value: ArtworkDimensions | null): value is ArtworkDimensions {
  return Boolean(value && value.width > 0 && value.height > 0);
}

export function classifyArtwork(
  naturalSize: ArtworkDimensions | null,
  renderedSize: ArtworkDimensions | null,
  unavailable: boolean,
): ArtworkQuality {
  if (unavailable) return "missing";
  if (naturalSize && !validDimensions(naturalSize)) return "missing";
  if (!validDimensions(naturalSize) || !validDimensions(renderedSize)) return "weak";
  const wideEnough = naturalSize.width / naturalSize.height >= 1.2;
  return wideEnough &&
    naturalSize.width >= renderedSize.width &&
    naturalSize.height >= renderedSize.height
    ? "standard"
    : "weak";
}

export function classifyArtworkShape(
  naturalSize: ArtworkDimensions | null,
): ArtworkShape {
  if (!validDimensions(naturalSize)) return "unknown";
  return naturalSize.width / naturalSize.height >= 1.2 ? "landscape" : "portrait";
}

function linearChannel(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

export function averageRelativeLuminance(pixels: Uint8ClampedArray): number | null {
  let weightedTotal = 0;
  let alphaTotal = 0;
  for (let index = 0; index + 3 < pixels.length; index += 4) {
    const alpha = pixels[index + 3] / 255;
    if (alpha === 0) continue;
    const luminance =
      0.2126 * linearChannel(pixels[index]) +
      0.7152 * linearChannel(pixels[index + 1]) +
      0.0722 * linearChannel(pixels[index + 2]);
    weightedTotal += luminance * alpha;
    alphaTotal += alpha;
  }
  return alphaTotal > 0 ? weightedTotal / alphaTotal : null;
}

export function sampleArtworkLuminance(
  image: HTMLImageElement,
  createCanvas: () => HTMLCanvasElement = () => document.createElement("canvas"),
): number | null {
  try {
    const canvas = createCanvas();
    canvas.width = 16;
    canvas.height = 16;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(image, 0, 0, 16, 16);
    return averageRelativeLuminance(context.getImageData(0, 0, 16, 16).data);
  } catch {
    return null;
  }
}

export function classifyArtworkTone(relativeLuminance: number | null): ArtworkTone {
  if (
    relativeLuminance === null ||
    !Number.isFinite(relativeLuminance) ||
    relativeLuminance > 0.58
  ) return "light";
  if (relativeLuminance < 0.24) return "dark";
  return "medium";
}

export interface ArtworkToneSampler {
  sample(url: string, signal?: AbortSignal): Promise<ArtworkTone>;
}

interface ArtworkToneSamplerOptions {
  maxEntries?: number;
  timeoutMs?: number;
  createImage?: () => HTMLImageElement;
  sampleLuminance?: (image: HTMLImageElement) => number | null;
  setTimeout?: (callback: () => void, timeoutMs: number) => number;
  clearTimeout?: (handle: number) => void;
}

interface ArtworkToneSubscriber {
  resolve: (tone: ArtworkTone) => void;
  reject: (error: DOMException) => void;
  signal?: AbortSignal;
  abortHandler?: () => void;
}

interface ArtworkToneInFlight {
  url: string;
  image: HTMLImageElement;
  subscribers: Set<ArtworkToneSubscriber>;
  timer: number;
  active: boolean;
}

function abortError(): DOMException {
  return new DOMException("Artwork tone sampling aborted", "AbortError");
}

export function createArtworkToneSampler({
  maxEntries = 64,
  timeoutMs = 8_000,
  createImage = () => new Image(),
  sampleLuminance = sampleArtworkLuminance,
  setTimeout: scheduleTimeout = (callback, delay) =>
    window.setTimeout(callback, delay),
  clearTimeout: cancelTimeout = (handle) => window.clearTimeout(handle),
}: ArtworkToneSamplerOptions = {}): ArtworkToneSampler {
  const settled = new Map<string, ArtworkTone>();
  const inFlight = new Map<string, ArtworkToneInFlight>();
  const order = new Map<string, "settled" | "in-flight">();
  const limit = Math.max(1, Math.floor(maxEntries));
  const samplingTimeout = Math.max(0, timeoutMs);

  const touch = (url: string, kind: "settled" | "in-flight") => {
    order.delete(url);
    order.set(url, kind);
  };

  const detachSubscriber = (subscriber: ArtworkToneSubscriber) => {
    if (subscriber.signal && subscriber.abortHandler) {
      subscriber.signal.removeEventListener("abort", subscriber.abortHandler);
    }
  };

  const releaseImage = (entry: ArtworkToneInFlight, abortRequest: boolean) => {
    entry.image.onload = null;
    entry.image.onerror = null;
    cancelTimeout(entry.timer);
    if (abortRequest) {
      try {
        entry.image.src = "";
      } catch {
        // Some test doubles or browser implementations can reject an empty src.
      }
    }
  };

  const finish = (
    entry: ArtworkToneInFlight,
    tone: ArtworkTone,
    cacheResult: boolean,
    abortRequest: boolean,
  ) => {
    if (!entry.active) return;
    entry.active = false;
    releaseImage(entry, abortRequest);
    if (inFlight.get(entry.url) === entry) {
      inFlight.delete(entry.url);
      order.delete(entry.url);
    }
    if (cacheResult) {
      settled.set(entry.url, tone);
      touch(entry.url, "settled");
    }
    for (const subscriber of entry.subscribers) {
      detachSubscriber(subscriber);
      subscriber.resolve(tone);
    }
    entry.subscribers.clear();
  };

  const cancelIfUnused = (entry: ArtworkToneInFlight) => {
    if (!entry.active || entry.subscribers.size > 0) return;
    entry.active = false;
    releaseImage(entry, true);
    if (inFlight.get(entry.url) === entry) {
      inFlight.delete(entry.url);
      order.delete(entry.url);
    }
  };

  const trim = () => {
    while (order.size > limit) {
      const oldest = order.entries().next().value as
        | [string, "settled" | "in-flight"]
        | undefined;
      if (!oldest) return;
      const [url, kind] = oldest;
      if (kind === "settled") {
        settled.delete(url);
        order.delete(url);
        continue;
      }
      const entry = inFlight.get(url);
      if (!entry) {
        order.delete(url);
        continue;
      }
      finish(entry, "light", false, true);
    }
  };

  const subscribe = (
    entry: ArtworkToneInFlight,
    signal?: AbortSignal,
  ): Promise<ArtworkTone> => {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise<ArtworkTone>((resolve, reject) => {
      const subscriber: ArtworkToneSubscriber = { resolve, reject, signal };
      if (signal) {
        subscriber.abortHandler = () => {
          if (!entry.subscribers.delete(subscriber)) return;
          detachSubscriber(subscriber);
          reject(abortError());
          cancelIfUnused(entry);
        };
        signal.addEventListener("abort", subscriber.abortHandler, { once: true });
      }
      entry.subscribers.add(subscriber);
    });
  };

  return {
    sample(url: string, signal?: AbortSignal): Promise<ArtworkTone> {
      if (signal?.aborted) return Promise.reject(abortError());

      const cached = settled.get(url);
      if (cached !== undefined) {
        touch(url, "settled");
        return Promise.resolve(cached);
      }

      const pending = inFlight.get(url);
      if (pending) {
        touch(url, "in-flight");
        return subscribe(pending, signal);
      }

      let image: HTMLImageElement;
      try {
        image = createImage();
      } catch {
        return Promise.resolve("light");
      }

      const entry = {
        url,
        image,
        subscribers: new Set<ArtworkToneSubscriber>(),
        timer: 0,
        active: true,
      } satisfies ArtworkToneInFlight;
      const sampled = subscribe(entry, signal);
      if (!entry.active) return sampled;

      image.crossOrigin = "anonymous";
      image.referrerPolicy = "no-referrer";
      image.onload = () => {
        try {
          finish(
            entry,
            classifyArtworkTone(sampleLuminance(image)),
            true,
            false,
          );
        } catch {
          finish(entry, "light", true, false);
        }
      };
      image.onerror = () => finish(entry, "light", true, false);
      entry.timer = scheduleTimeout(
        () => finish(entry, "light", true, true),
        samplingTimeout,
      );

      inFlight.set(url, entry);
      touch(url, "in-flight");
      trim();
      if (entry.active) {
        try {
          image.src = url;
        } catch {
          finish(entry, "light", true, false);
        }
      }
      return sampled;
    },
  };
}

export const artworkToneSampler = createArtworkToneSampler();
