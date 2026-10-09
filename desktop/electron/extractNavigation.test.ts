import { describe, expect, it, vi } from "vitest";
import type { Session, WebContents } from "electron";
import { installExtractGuestPolicy, installExtractSessionPolicy, isExtractNavigationUrl, isExtractWebUrl } from "./extractNavigation";

function guestMock() {
  const handlers = new Map<string, (...args: any[]) => void>();
  let open: (details: { url: string }) => { action: string };
  const guest = {
    on: vi.fn((name: string, handler: (...args: any[]) => void) => handlers.set(name, handler)),
    setWindowOpenHandler: vi.fn((handler) => { open = handler; }),
  } as unknown as WebContents;
  installExtractGuestPolicy(guest);
  return { guest, handlers, popup: (url: string) => open({ url }) };
}

describe("extract protocol policy", () => {
  const blocked = ["bytedance://dispatch_message/", "douyin://video/123", "file:///tmp/a", "javascript:alert(1)", "data:text/html,test", "mailto:a@example.com", "not a url"];
  it.each(blocked)("rejects active input %s", (url) => expect(isExtractWebUrl(url)).toBe(false));
  it("allows web URLs and only the necessary blank internal navigation", () => {
    for (const url of ["https://www.douyin.com/", "http://localhost:123/login", "https://example.com/oauth/callback?code=test"]) {
      expect(isExtractWebUrl(url)).toBe(true);
      expect(isExtractNavigationUrl(url)).toBe(true);
    }
    expect(isExtractNavigationUrl("about:blank")).toBe(true);
    expect(isExtractWebUrl("about:blank")).toBe(false);
    expect(isExtractNavigationUrl("about:config")).toBe(false);
  });
  it.each(blocked)("cancels all guest navigation entries and popups for %s", (url) => {
    const mock = guestMock();
    for (const name of ["will-navigate", "will-redirect", "will-frame-navigate"]) {
      const event = { url, preventDefault: vi.fn() };
      mock.handlers.get(name)!(event, url);
      expect(event.preventDefault).toHaveBeenCalledOnce();
    }
    expect(mock.popup(url).action).toBe("deny");
  });
  it("preserves HTTPS login redirects and applies guards to web popup children", () => {
    const mock = guestMock();
    const url = "https://example.com/oauth/callback";
    const event = { url, preventDefault: vi.fn() };
    for (const name of ["will-navigate", "will-redirect", "will-frame-navigate"]) mock.handlers.get(name)!(event, url);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(mock.popup(url).action).toBe("allow");
    const child = { on: vi.fn(), setWindowOpenHandler: vi.fn() };
    mock.handlers.get("did-create-window")!({ webContents: child });
    expect(child.setWindowOpenHandler).toHaveBeenCalledOnce();
  });
  it("denies automatic system opens while preserving unrelated permissions", () => {
    const ses = { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() };
    installExtractSessionPolicy(ses as unknown as Session);
    const request = ses.setPermissionRequestHandler.mock.calls[0][0];
    const check = ses.setPermissionCheckHandler.mock.calls[0][0];
    const systemOpen = vi.fn();
    request(null, "openExternal", (allowed: boolean) => { if (allowed) systemOpen(); });
    expect(check(null, "openExternal")).toBe(false);
    expect(systemOpen).not.toHaveBeenCalled();
    request(null, "media", (allowed: boolean) => expect(allowed).toBe(true));
    expect(check(null, "media")).toBe(true);
  });
});
