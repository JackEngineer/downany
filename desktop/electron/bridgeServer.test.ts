import { describe, expect, it } from "vitest";

import { parseEnqueueBody } from "./bridgeServer";

describe("parseEnqueueBody", () => {
  it("parses single url", () => {
    expect(parseEnqueueBody(JSON.stringify({ url: "https://youtu.be/a" }))).toEqual([
      { url: "https://youtu.be/a" },
    ]);
  });

  it("parses urls array and merges with url", () => {
    expect(
      parseEnqueueBody(
        JSON.stringify({
          url: "https://youtu.be/a",
          urls: ["https://youtu.be/b", ""],
        }),
      ),
    ).toEqual([{ url: "https://youtu.be/a" }, { url: "https://youtu.be/b" }]);
  });

  it("parses items with title and headers", () => {
    expect(
      parseEnqueueBody(
        JSON.stringify({
          items: [
            {
              url: "https://cdn.example/a.m3u8",
              title: "示例",
              headers: { Referer: "https://example.com/", Cookie: "a=1" },
            },
            { url: "https://cdn.example/b.mp4" },
            { url: "" },
            "https://cdn.example/c.mp4",
          ],
        }),
      ),
    ).toEqual([
      {
        url: "https://cdn.example/a.m3u8",
        title: "示例",
        headers: { Referer: "https://example.com/", Cookie: "a=1" },
      },
      { url: "https://cdn.example/b.mp4" },
      { url: "https://cdn.example/c.mp4" },
    ]);
  });

  it("parses pageUrl and thumbnail_url", () => {
    expect(
      parseEnqueueBody(
        JSON.stringify({
          items: [
            {
              url: "https://sns-video-bd.xhscdn.com/a.mp4",
              title: "笔记 - 小红书",
              pageUrl: "https://www.xiaohongshu.com/explore/abc",
              thumbnail_url: "https://sns-webpic-qc.xhscdn.com/cover.jpg",
              headers: {
                Referer: "https://www.xiaohongshu.com/explore/abc",
              },
            },
          ],
        }),
      ),
    ).toEqual([
      {
        url: "https://sns-video-bd.xhscdn.com/a.mp4",
        title: "笔记 - 小红书",
        pageUrl: "https://www.xiaohongshu.com/explore/abc",
        thumbnail_url: "https://sns-webpic-qc.xhscdn.com/cover.jpg",
        headers: {
          Referer: "https://www.xiaohongshu.com/explore/abc",
        },
      },
    ]);
  });

  it("dedupes url across items and legacy fields", () => {
    expect(
      parseEnqueueBody(
        JSON.stringify({
          items: [{ url: "https://youtu.be/a", title: "A" }],
          url: "https://youtu.be/a",
          urls: ["https://youtu.be/a", "https://youtu.be/b"],
        }),
      ),
    ).toEqual([
      { url: "https://youtu.be/a", title: "A" },
      { url: "https://youtu.be/b" },
    ]);
  });

  it("returns empty for invalid json", () => {
    expect(parseEnqueueBody("{")).toEqual([]);
    expect(parseEnqueueBody("{}")).toEqual([]);
  });
});
