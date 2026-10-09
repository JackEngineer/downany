import { describe, expect, it, vi } from "vitest";
import { createEmbeddedDouyinRetry, douyinVideoUrl, resolveDouyinUsingNativeSession, safeDouyinMediaUrl } from "./embeddedDouyinRetry";
const original = "https://www.douyin.com/video/123";
const media = "https://v26-web.douyinvod.com/video.mp4?token=runtime-only";
const body = { aweme_detail: { aweme_id: "123", desc: "作品名称", video: { play_addr: { url_list: [media] } } } };
const response = (value: unknown) => new Response(JSON.stringify(value));
describe("explicit built-in Douyin retry", () => {
  it.each(["http://www.douyin.com/video/123", "https://evil.com/video/123", "https://www.douyin.com.evil.com/video/123", "https://user@www.douyin.com/video/123", "https://www.douyin.com/video/123?next=evil", "https://www.douyin.com:444/video/123", "https://www.douyin.com/video/123#x"])("rejects unsafe origin %s before any request", async (url) => {
    const fetch = vi.fn(); await expect(resolveDouyinUsingNativeSession(url, fetch)).rejects.toMatchObject({ code: "invalid" }); expect(fetch).not.toHaveBeenCalled();
  });
  it("uses native credentials only on the exact detail endpoint and never returns credentials", async () => {
    const fetch = vi.fn(async () => response({ ...body, cookie: "must-not-return" }));
    expect(await resolveDouyinUsingNativeSession(original, fetch)).toEqual({ originalUrl: original, title: "作品名称", mediaUrl: media });
    const [url, opts] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=123"); expect(opts.credentials).toBe("include"); expect(opts.redirect).toBe("error"); expect(opts.headers).toEqual({ Referer: original });
  });
  it.each(["https://evil.com/a.mp4", "https://video-web-cn.douyin.com.evil.com/a", "https://sid:secret@video-web-cn.douyin.com/a", "http://v26-web.douyinvod.com/a", "https://v26-web.douyinvod.com/a.m3u8"])("rejects credentialed or untrusted media %s", (url) => expect(() => safeDouyinMediaUrl(url)).toThrow());
  it("does not follow a malicious redirect or expose the rejected location", async () => {
    const fetch = vi.fn(async () => { throw new Error("redirect https://evil.com/?Cookie=secret"); });
    const apply = vi.fn(); const retry = createEmbeddedDouyinRetry({ readTask: async () => ({ url: original, status: "failed" }), nativeFetch: fetch, apply });
    expect(await retry("task-1")).toEqual({ ok: false, code: "network" }); expect(fetch).toHaveBeenCalledTimes(1); expect(apply).not.toHaveBeenCalled();
  });
  it.each([{}, { status_code: 8 }, { aweme_detail: { ...body.aweme_detail, aweme_id: "456" } }])("reports absent/rejected session details without claiming login expired", async (value) => {
    await expect(resolveDouyinUsingNativeSession(original, async () => response(value))).rejects.toMatchObject({ code: "unavailable" });
  });
  it("rejects redirected responses even when the transport ignores redirect:error", async () => {
    const res = response(body); Object.defineProperty(res, "url", { value: "https://evil.com/" });
    await expect(resolveDouyinUsingNativeSession(original, async () => res)).rejects.toMatchObject({ code: "rejected" });
  });
  it("limits response size", async () => {
    await expect(resolveDouyinUsingNativeSession(original, async () => new Response("x".repeat(2 * 1024 * 1024 + 1)))).rejects.toMatchObject({ code: "unavailable" });
  });
  it("coalesces double-clicks and applies exactly once", async () => {
    let release!: (r: Response) => void; const fetch = vi.fn(() => new Promise<Response>((r) => { release = r; })); const apply = vi.fn(async () => {});
    const retry = createEmbeddedDouyinRetry({ readTask: async () => ({ url: original, status: "failed" }), nativeFetch: fetch, apply });
    const a = retry("task-1"), b = retry("task-1"); expect(a).toBe(b); await Promise.resolve(); release(response(body));
    expect(await a).toEqual({ ok: true }); expect(fetch).toHaveBeenCalledTimes(1); expect(apply).toHaveBeenCalledTimes(1);
  });
  it("does not request session data for a running task", async () => {
    const fetch = vi.fn(); const retry = createEmbeddedDouyinRetry({ readTask: async () => ({ url: original, status: "downloading" }), nativeFetch: fetch, apply: vi.fn() });
    expect(await retry("task-1")).toEqual({ ok: false, code: "busy" }); expect(fetch).not.toHaveBeenCalled();
  });
  it("redacts downstream errors", async () => {
    const retry = createEmbeddedDouyinRetry({ readTask: async () => ({ url: original, status: "failed" }), nativeFetch: async () => response(body), apply: async () => { throw new Error(media + " Cookie=secret"); } });
    expect(await retry("task-1")).toEqual({ ok: false, code: "unavailable" }); expect(douyinVideoUrl(original)).toBe(original);
  });
});
