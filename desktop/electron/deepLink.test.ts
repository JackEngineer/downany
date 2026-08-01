import { describe, expect, it } from "vitest";

import {
  buildAddDeepLink,
  extractUrlsFromArgv,
  parseDeepLinkAdd,
  parseDeepLinkCandidate,
} from "./deepLink";

describe("parseDeepLinkCandidate", () => {
  it("parses downany://add?url=", () => {
    const page = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    const link = buildAddDeepLink(page);
    expect(parseDeepLinkCandidate(link)).toBe(page);
  });

  it("parses encoded query with extra params", () => {
    const page = "https://youtu.be/abc123";
    const raw = `downany://add?url=${encodeURIComponent(page)}&source=ext`;
    expect(parseDeepLinkCandidate(raw)).toBe(page);
  });

  it("accepts bare http(s) urls", () => {
    expect(parseDeepLinkCandidate("https://bilibili.com/video/BV1")).toBe(
      "https://bilibili.com/video/BV1",
    );
    expect(parseDeepLinkCandidate("http://example.com/a")).toBe("http://example.com/a");
  });

  it("rejects non-http schemes and unknown hosts", () => {
    expect(parseDeepLinkCandidate("downany://remove?url=https://x.com")).toBeNull();
    expect(parseDeepLinkCandidate("downany://add")).toBeNull();
    expect(parseDeepLinkCandidate("ftp://example.com/a")).toBeNull();
    expect(parseDeepLinkCandidate("")).toBeNull();
    expect(parseDeepLinkCandidate("not a url")).toBeNull();
  });

  it("rejects javascript and file urls smuggled in url param", () => {
    const evil = `downany://add?url=${encodeURIComponent("javascript:alert(1)")}`;
    expect(parseDeepLinkCandidate(evil)).toBeNull();
    const file = `downany://add?url=${encodeURIComponent("file:///etc/passwd")}`;
    expect(parseDeepLinkCandidate(file)).toBeNull();
  });
});

describe("extractUrlsFromArgv", () => {
  it("extracts and dedupes from mixed argv", () => {
    const a = "https://youtu.be/a";
    const b = "https://youtu.be/b";
    const argv = [
      "/path/to/Electron",
      ".",
      buildAddDeepLink(a),
      buildAddDeepLink(a),
      b,
      "--some-flag",
    ];
    expect(extractUrlsFromArgv(argv)).toEqual([a, b]);
  });
});

describe("parseDeepLinkAdd", () => {
  it("parses quality audio and subs params", () => {
    const page = "https://youtu.be/abc123";
    const raw = `downany://add?url=${encodeURIComponent(page)}&quality=1080p&audio=1&subs=1`;
    expect(parseDeepLinkAdd(raw)).toEqual({
      url: page,
      quality: "1080p",
      audioOnly: true,
      downloadSubtitles: true,
    });
  });
});
