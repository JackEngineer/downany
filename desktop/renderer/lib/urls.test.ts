import { describe, expect, it } from "vitest";

import { extractUrls, looksLikePlaylistUrl } from "./urls";

describe("extractUrls", () => {
  it("extracts multiple urls and dedupes", () => {
    const text = `
      https://youtu.be/aaa
      看看这个 https://youtu.be/bbb ，还有 https://youtu.be/aaa
    `;
    expect(extractUrls(text)).toEqual([
      "https://youtu.be/aaa",
      "https://youtu.be/bbb",
    ]);
  });

  it("returns empty for plain text", () => {
    expect(extractUrls("没有链接")).toEqual([]);
  });
});

describe("looksLikePlaylistUrl", () => {
  it.each([
    ["https://www.youtube.com/playlist?list=PL123", true],
    ["https://www.youtube.com/watch?v=abc&list=PL123", true],
    ["https://www.youtube.com/watch?v=abc", false],
    ["https://www.bilibili.com/video/BV1abc", true],
    ["https://www.bilibili.com/video/BV1abc?p=2", true],
    ["https://www.bilibili.com/bangumi/play/ep123", true],
    ["https://example.com/playlist/weekly", true],
    ["https://example.com/collection/weekly", true],
    ["https://cdn.example.com/media/video.mp4", false],
  ] as const)("classifies %s as %s", (url, expected) => {
    expect(looksLikePlaylistUrl(url)).toBe(expected);
  });
});
