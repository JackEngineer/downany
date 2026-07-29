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
