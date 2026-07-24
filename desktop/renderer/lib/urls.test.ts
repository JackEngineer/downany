import { describe, expect, it } from "vitest";

import { extractUrls } from "./urls";

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
