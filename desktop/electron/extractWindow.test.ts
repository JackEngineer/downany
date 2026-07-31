import { describe, expect, it, vi } from "vitest";

import { buildExtractEnqueueItems } from "./extractWindow";
import type { Session } from "electron";

function mockSession(cookies: Array<{ name: string; value: string }>): Session {
  return {
    cookies: {
      get: vi.fn(async () => cookies),
    },
  } as unknown as Session;
}

describe("buildExtractEnqueueItems", () => {
  it("attaches Cookie header when session has cookies", async () => {
    const ses = mockSession([{ name: "sid", value: "abc123" }]);
    const items = await buildExtractEnqueueItems(ses, [
      { url: "https://example.com/video.m3u8", title: "Demo" },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].url).toBe("https://example.com/video.m3u8");
    expect(items[0].title).toBe("Demo");
    expect(items[0].headers?.Cookie).toBe("sid=abc123");
  });

  it("skips empty urls", async () => {
    const ses = mockSession([]);
    const items = await buildExtractEnqueueItems(ses, [
      { url: "  " },
      { url: "https://cdn.example.com/a.mp4" },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].headers).toBeUndefined();
  });
});
