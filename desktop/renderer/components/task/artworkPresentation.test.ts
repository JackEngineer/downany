import { describe, expect, it, vi } from "vitest";

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
  srcAssignments: string[];
  onload: ((event: Event) => void) | null;
  onerror: ((event: Event | string) => void) | null;
}

function controlledImage(): ControlledImage {
  let src = "";
  const srcAssignments: string[] = [];
  return {
    crossOrigin: null,
    referrerPolicy: "",
    get src() {
      return src;
    },
    set src(value: string) {
      src = value;
      srcAssignments.push(value);
    },
    srcAssignments,
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
    const sharedFirst = sampler.sample("https://example.com/a.jpg");
    expect(images).toHaveLength(1);
    images[0].onload?.(new Event("load"));
    await expect(Promise.all([first, sharedFirst])).resolves.toEqual([
      "dark",
      "dark",
    ]);

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

  it("times out a sampler that never loads and releases the image request", async () => {
    const image = controlledImage();
    let timeoutCallback: (() => void) | null = null;
    const clearTimeout = vi.fn();
    const sampler = createArtworkToneSampler({
      timeoutMs: 25,
      createImage: () => image as unknown as HTMLImageElement,
      setTimeout: (callback) => {
        timeoutCallback = callback;
        return 7;
      },
      clearTimeout,
    });

    const sampled = sampler.sample("https://example.com/hangs.jpg");
    expect(timeoutCallback).not.toBeNull();
    timeoutCallback?.();

    await expect(sampled).resolves.toBe("light");
    expect(clearTimeout).toHaveBeenCalledWith(7);
    expect(image.onload).toBeNull();
    expect(image.onerror).toBeNull();
    expect(image.srcAssignments).toEqual([
      "https://example.com/hangs.jpg",
      "",
    ]);
  });

  it("cancels and settles an in-flight entry when the shared bound evicts it", async () => {
    const images: ControlledImage[] = [];
    const sampler = createArtworkToneSampler({
      maxEntries: 1,
      createImage: () => {
        const image = controlledImage();
        images.push(image);
        return image as unknown as HTMLImageElement;
      },
      sampleLuminance: () => null,
    });

    const first = sampler.sample("https://example.com/a.jpg");
    const second = sampler.sample("https://example.com/b.jpg");

    await expect(first).resolves.toBe("light");
    expect(images[0].srcAssignments.at(-1)).toBe("");
    expect(images[0].onload).toBeNull();
    expect(images[0].onerror).toBeNull();
    images[1].onerror?.(new Event("error"));
    await expect(second).resolves.toBe("light");
  });

  it("bounds an A B A sequence without leaving the evicted requests alive", async () => {
    const images: ControlledImage[] = [];
    const sampler = createArtworkToneSampler({
      maxEntries: 1,
      createImage: () => {
        const image = controlledImage();
        images.push(image);
        return image as unknown as HTMLImageElement;
      },
      sampleLuminance: () => null,
    });

    const firstA = sampler.sample("https://example.com/a.jpg");
    const b = sampler.sample("https://example.com/b.jpg");
    const secondA = sampler.sample("https://example.com/a.jpg");

    expect(images).toHaveLength(3);
    await expect(firstA).resolves.toBe("light");
    await expect(b).resolves.toBe("light");
    expect(images[0].srcAssignments.at(-1)).toBe("");
    expect(images[1].srcAssignments.at(-1)).toBe("");
    images[2].onload?.(new Event("load"));
    await expect(secondA).resolves.toBe("light");
  });

  it("keeps a shared request alive when only one subscriber aborts", async () => {
    const image = controlledImage();
    const firstController = new AbortController();
    const secondController = new AbortController();
    const sampler = createArtworkToneSampler({
      createImage: () => image as unknown as HTMLImageElement,
      sampleLuminance: () => 0.1,
    });

    const first = sampler.sample(
      "https://example.com/shared.jpg",
      firstController.signal,
    );
    const second = sampler.sample(
      "https://example.com/shared.jpg",
      secondController.signal,
    );
    firstController.abort();

    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(image.src).toBe("https://example.com/shared.jpg");
    expect(image.onload).not.toBeNull();
    image.onload?.(new Event("load"));
    await expect(second).resolves.toBe("dark");
  });

  it("aborts the underlying request after its final subscriber cancels", async () => {
    const images: ControlledImage[] = [];
    const controller = new AbortController();
    const sampler = createArtworkToneSampler({
      createImage: () => {
        const image = controlledImage();
        images.push(image);
        return image as unknown as HTMLImageElement;
      },
    });

    const sampled = sampler.sample(
      "https://example.com/cancel.jpg",
      controller.signal,
    );
    controller.abort();

    await expect(sampled).rejects.toMatchObject({ name: "AbortError" });
    expect(images[0].onload).toBeNull();
    expect(images[0].onerror).toBeNull();
    expect(images[0].srcAssignments.at(-1)).toBe("");

    const retry = sampler.sample("https://example.com/cancel.jpg");
    expect(images).toHaveLength(2);
    images[1].onerror?.(new Event("error"));
    await expect(retry).resolves.toBe("light");
  });
});
