import { describe, expect, it } from "vitest";

import {
  needsPornhubThumbnailReferrer,
  patchThumbnailRequestHeaders,
} from "./thumbnailReferrer";

describe("thumbnailReferrer", () => {
  it("detects phncdn hosts", () => {
    expect(
      needsPornhubThumbnailReferrer(
        "https://pix-cdn77.phncdn.com/videos/a.jpg?x=1",
      ),
    ).toBe(true);
    expect(
      needsPornhubThumbnailReferrer("https://ev.phncdn.com/a.jpg"),
    ).toBe(true);
    expect(
      needsPornhubThumbnailReferrer("https://i0.hdslb.com/bfs/archive/a.jpg"),
    ).toBe(false);
  });

  it("injects Pornhub Referer for phncdn", () => {
    const out = patchThumbnailRequestHeaders(
      "https://pix-cdn77.phncdn.com/c.jpg",
      { "User-Agent": "test", referer: "http://localhost:5173/" },
    );
    expect(out.Referer).toBe("https://www.pornhub.com/");
    expect(out.referer).toBeUndefined();
    expect(out["User-Agent"]).toBe("test");
  });

  it("injects Xiaohongshu Referer for xhscdn", () => {
    const out = patchThumbnailRequestHeaders(
      "https://sns-webpic-qc.xhscdn.com/cover.jpg",
      { referer: "http://localhost:5173/" },
    );
    expect(out.Referer).toBe("https://www.xiaohongshu.com/");
  });

  it("leaves other hosts unchanged", () => {
    const input = { Referer: "https://www.bilibili.com/" };
    expect(
      patchThumbnailRequestHeaders("https://i0.hdslb.com/bfs/a.jpg", input),
    ).toEqual(input);
  });
});
