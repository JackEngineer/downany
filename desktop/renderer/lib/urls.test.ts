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
  it("detects youtube playlist urls", () => {
    expect(
      looksLikePlaylistUrl(
        "https://www.youtube.com/playlist?list=PLvAJTuxHphYqM-4WPDlnQduRE_Be3ZElw",
      ),
    ).toBe(true);
    expect(
      looksLikePlaylistUrl(
        "https://www.youtube.com/watch?v=abc&list=PLxxxx",
      ),
    ).toBe(true);
  });

  it("ignores plain single video urls", () => {
    expect(looksLikePlaylistUrl("https://www.youtube.com/watch?v=abc")).toBe(
      false,
    );
    expect(looksLikePlaylistUrl("https://youtu.be/abc")).toBe(false);
  });
});
