import { describe, expect, it } from "vitest";

import { extractUrlsFromText } from "./clipboardWatcher";

describe("extractUrlsFromText", () => {
  it("extracts and dedupes urls from mixed text", () => {
    const text = "看这个 https://vimeo.com/12345 和 https://vimeo.com/12345，还有 https://youtu.be/abc。";
    expect(extractUrlsFromText(text)).toEqual([
      "https://vimeo.com/12345",
      "https://youtu.be/abc",
    ]);
  });

  it("returns empty for text without urls", () => {
    expect(extractUrlsFromText("没有链接")).toEqual([]);
  });
});
