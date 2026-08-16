import { describe, expect, it } from "vitest";

import {
  averageRelativeLuminance,
  classifyArtwork,
  classifyArtworkShape,
  classifyArtworkTone,
  createArtworkToneSampler,
  sampleArtworkLuminance,
} from "./artworkPresentation";

interface ControlledImage {
  crossOrigin: string | null;
  referrerPolicy: string;
  src: string;
  onload: ((event: Event) => void) | null;
  onerror: ((event: Event | string) => void) | null;
}

function controlledImage(): ControlledImage {
  return {
    crossOrigin: null,
    referrerPolicy: "",
    src: "",
    onload: null,
    onerror: null,
  };
}

describe("artwork presentation", () => {
  it("keeps a sufficiently large landscape image standard", () => {
    expect(
      classifyArtwork(
        { width: 1920, height: 1080 },
        { width: 1200, height: 108 },
        false,
      ),
    ).toBe("standard");
  });

  it.each([
    [{ width: 720, height: 960 }, { width: 1200, height: 108 }],
    [{ width: 640, height: 360 }, { width: 1200, height: 108 }],
    [null, { width: 1200, height: 108 }],
  ])("uses the weak composition before or below the standard threshold", (natural, rendered) => {
    expect(classifyArtwork(natural, rendered, false)).toBe("weak");
  });

  it("marks unavailable or invalid artwork missing", () => {
    expect(classifyArtwork(null, null, true)).toBe("missing");
    expect(
      classifyArtwork({ width: 0, height: 1080 }, { width: 1200, height: 108 }, false),
    ).toBe("missing");
  });

  it("distinguishes portrait artwork at the 1.2 boundary", () => {
    expect(classifyArtworkShape({ width: 720, height: 960 })).toBe("portrait");
    expect(classifyArtworkShape({ width: 1200, height: 1000 })).toBe("landscape");
    expect(classifyArtworkShape(null)).toBe("unknown");
  });

  it.each([
    [0.239, "dark"],
    [0.24, "medium"],
    [0.58, "medium"],
    [0.581, "light"],
    [null, "light"],
    [Number.NaN, "light"],
  ] as const)("classifies luminance %s as %s", (luminance, tone) => {
    expect(classifyArtworkTone(luminance)).toBe(tone);
  });

  it("computes transparent-aware relative luminance from literal pixels", () => {
    const pixels = new Uint8ClampedArray([
      255, 255, 255, 255,
      0, 0, 0, 255,
      255, 0, 0, 0,
    ]);
    expect(averageRelativeLuminance(pixels)).toBeCloseTo(0.5, 5);
  });

  it("returns null when Canvas pixel access is rejected", () => {
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => {
        throw new DOMException("tainted", "SecurityError");
      },
    } as unknown as HTMLCanvasElement;
    expect(
      sampleArtworkLuminance({} as HTMLImageElement, () => canvas),
    ).toBeNull();
  });

  it.each([
    ["https://cdn.example/video.jpg", 0.1, "dark"],
    ["http://localhost/local.jpg", 0.4, "medium"],
  ] as const)("samples %s through an anonymous image", async (url, luminance, tone) => {
    const image = controlledImage();
    const sampler = createArtworkToneSampler({
      createImage: () => image as unknown as HTMLImageElement,
      sampleLuminance: () => luminance,
    });

    const sampled = sampler.sample(url);
    expect(image.crossOrigin).toBe("anonymous");
    expect(image.referrerPolicy).toBe("no-referrer");
    expect(image.src).toBe(url);
    image.onload?.(new Event("load"));

    await expect(sampled).resolves.toBe(tone);
  });

  it("falls back to light when the anonymous CORS request is denied", async () => {
    const image = controlledImage();
    const sampler = createArtworkToneSampler({
      createImage: () => image as unknown as HTMLImageElement,
      sampleLuminance: () => {
        throw new Error("must not sample a failed image");
      },
    });

    const sampled = sampler.sample("https://no-cors.example/video.jpg");
    image.onerror?.(new Event("error"));

    await expect(sampled).resolves.toBe("light");
  });

  it("deduplicates in-flight samples and evicts the least-recent URL at its bound", async () => {
    const images: ControlledImage[] = [];
    const sampler = createArtworkToneSampler({
      maxEntries: 2,
      createImage: () => {
        const image = controlledImage();
        images.push(image);
        return image as unknown as HTMLImageElement;
      },
      sampleLuminance: () => 0.1,
    });

    const first = sampler.sample("https://example.com/a.jpg");
    expect(sampler.sample("https://example.com/a.jpg")).toBe(first);
    images[0].onload?.(new Event("load"));
    await first;

    const second = sampler.sample("https://example.com/b.jpg");
    images[1].onload?.(new Event("load"));
    await second;
    const third = sampler.sample("https://example.com/c.jpg");
    images[2].onload?.(new Event("load"));
    await third;

    const firstAgain = sampler.sample("https://example.com/a.jpg");
    expect(images).toHaveLength(4);
    images[3].onload?.(new Event("load"));
    await expect(firstAgain).resolves.toBe("dark");
  });
});
