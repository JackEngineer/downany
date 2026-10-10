import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storageKey = "downany.download-sort-order";
const loadStore = async () => (await import("./appStore")).useAppStore;

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

describe("download order after renderer restart", () => {
  it("restores the selected order across fresh store creation and snapshot hydration", async () => {
    const original = await loadStore();
    expect(original.getState().sortOrder).toBe("newest");
    original.getState().setSortOrder("oldest");
    vi.resetModules();
    const restarted = await loadStore();
    expect(restarted.getState().sortOrder).toBe("oldest");
    restarted.getState().hydrateSnapshot({ tasks: [], settings: { download_dir: "", concurrent_downloads: 1, speed_limit: 0, proxy_enabled: false, proxy_url: "", default_quality: "best", download_subtitles: false, theme_mode: "system" } });
    expect(restarted.getState().sortOrder).toBe("oldest");
    restarted.getState().setSortOrder("newest");
    vi.resetModules();
    expect((await loadStore()).getState().sortOrder).toBe("newest");
  });

  it.each(["unexpected-order", "", "{broken-json}"])("opens with the default for invalid saved preference %s", async (saved) => {
    localStorage.setItem(storageKey, saved);
    expect((await loadStore()).getState().sortOrder).toBe("newest");
  });

  it("keeps opening and changing order when storage access fails", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("Unavailable", "SecurityError"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Full", "QuotaExceededError"); });
    const store = await loadStore();
    expect(store.getState().sortOrder).toBe("newest");
    expect(() => store.getState().setSortOrder("oldest")).not.toThrow();
    expect(store.getState().sortOrder).toBe("oldest");
  });
});
