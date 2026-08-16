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
  sample(url: string): Promise<ArtworkTone>;
}

interface ArtworkToneSamplerOptions {
  maxEntries?: number;
  createImage?: () => HTMLImageElement;
  sampleLuminance?: (image: HTMLImageElement) => number | null;
}

export function createArtworkToneSampler({
  maxEntries = 64,
  createImage = () => new Image(),
  sampleLuminance = sampleArtworkLuminance,
}: ArtworkToneSamplerOptions = {}): ArtworkToneSampler {
  const cache = new Map<string, Promise<ArtworkTone>>();
  const limit = Math.max(1, Math.floor(maxEntries));

  return {
    sample(url: string): Promise<ArtworkTone> {
      const cached = cache.get(url);
      if (cached) {
        cache.delete(url);
        cache.set(url, cached);
        return cached;
      }

      const sampled = new Promise<ArtworkTone>((resolve) => {
        try {
          const image = createImage();
          const finish = (tone: ArtworkTone) => {
            image.onload = null;
            image.onerror = null;
            resolve(tone);
          };
          image.crossOrigin = "anonymous";
          image.referrerPolicy = "no-referrer";
          image.onload = () => {
            try {
              finish(classifyArtworkTone(sampleLuminance(image)));
            } catch {
              finish("light");
            }
          };
          image.onerror = () => finish("light");
          image.src = url;
        } catch {
          resolve("light");
        }
      });

      cache.set(url, sampled);
      while (cache.size > limit) {
        const oldest = cache.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
      return sampled;
    },
  };
}

export const artworkToneSampler = createArtworkToneSampler();
