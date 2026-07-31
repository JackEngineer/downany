import { describe, expect, it } from "vitest";

import {
  classifyByContentType,
  isSegmentUrl,
  looksLikeMediaUrl,
  parseM3U8,
} from "./mediaSniff";

describe("parseM3U8", () => {
  it("parses master playlist", () => {
    const text = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=854x480
480p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2560000,RESOLUTION=1280x720
720p/index.m3u8
`;
    const result = parseM3U8(text);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("master");
    expect(result!.variants).toBe(2);
    expect(result!.bestResolution).toBe("1280x720");
    expect(result!.maxBandwidth).toBe(2560000);
  });

  it("parses media playlist", () => {
    const text = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXTINF:5.0,
seg0.ts
#EXTINF:5.0,
seg1.ts
#EXT-X-ENDLIST
`;
    const result = parseM3U8(text);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("media");
    expect(result!.variants).toBe(0);
    expect(result!.duration).toBe(10);
  });

  it("returns null for invalid input", () => {
    expect(parseM3U8("not a playlist")).toBeNull();
    expect(parseM3U8("#EXTM3U\n")).toBeNull();
  });
});

describe("isSegmentUrl", () => {
  it("detects segment extensions", () => {
    expect(isSegmentUrl("https://cdn.example.com/seg001.ts")).toBe(true);
    expect(isSegmentUrl("https://cdn.example.com/init.m4s?token=abc")).toBe(true);
    expect(isSegmentUrl("https://cdn.example.com/master.m3u8")).toBe(false);
    expect(isSegmentUrl("https://cdn.example.com/video.mp4")).toBe(false);
  });
});

describe("looksLikeMediaUrl", () => {
  it("accepts media URLs and rejects segments", () => {
    expect(looksLikeMediaUrl("https://cdn.example.com/video.mp4")).toBe(true);
    expect(looksLikeMediaUrl("https://cdn.example.com/master.m3u8")).toBe(true);
    expect(looksLikeMediaUrl("https://cdn.example.com/seg.ts")).toBe(false);
    expect(looksLikeMediaUrl("https://cdn.example.com/page.html")).toBe(false);
  });
});

describe("classifyByContentType", () => {
  it("maps common content types", () => {
    expect(classifyByContentType("application/vnd.apple.mpegurl")).toBe("hls");
    expect(classifyByContentType("application/dash+xml")).toBe("dash");
    expect(classifyByContentType("video/mp4")).toBe("file");
    expect(classifyByContentType("text/html")).toBeNull();
  });
});
