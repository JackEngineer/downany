import { describe, expect, it } from "vitest";

import {
  averageRelativeLuminance,
  classifyArtwork,
  classifyArtworkShape,
  classifyArtworkTone,
  sampleArtworkLuminance,
} from "./artworkPresentation";

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
});
