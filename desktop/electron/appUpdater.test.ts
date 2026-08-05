import { afterEach, describe, expect, it, vi } from "vitest";

import {
  checkForAppUpdates,
  compareSemver,
  isAppUpdateConfigured,
  parseSemver,
} from "./appUpdater";

describe("appUpdater semver", () => {
  it("parses and compares versions", () => {
    expect(parseSemver("v1.2.3")).toEqual([1, 2, 3]);
    expect(compareSemver("0.2.0", "0.1.0")).toBeGreaterThan(0);
    expect(compareSemver("0.1.0", "0.1.0")).toBe(0);
    expect(compareSemver("0.1.0", "0.2.0")).toBeLessThan(0);
  });
});

describe("checkForAppUpdates", () => {
  afterEach(() => {
    delete process.env.DOWNANY_UPDATE_DISABLED;
    vi.unstubAllGlobals();
  });

  it("reports disabled when explicitly turned off", async () => {
    process.env.DOWNANY_UPDATE_DISABLED = "1";
    expect(isAppUpdateConfigured()).toBe(false);
    const info = await checkForAppUpdates("0.1.0");
    expect(info.status).toBe("disabled");
    expect(info.currentVersion).toBe("0.1.0");
  });

  it("reports available when GitHub latest is newer", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        tag_name: "v0.2.0",
        html_url: "https://github.com/JackEngineer/downany/releases/tag/v0.2.0",
      }),
    }));

    const info = await checkForAppUpdates("0.1.0", fetchMock);
    expect(info.status).toBe("available");
    expect(info.latestVersion).toBe("0.2.0");
    expect(info.downloadUrl).toContain("releases/tag/v0.2.0");
    expect(info.message).toContain("0.2.0");
  });

  it("reports not-available when already up to date", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        tag_name: "v0.1.0",
        html_url: "https://github.com/JackEngineer/downany/releases/tag/v0.1.0",
      }),
    }));

    const info = await checkForAppUpdates("0.1.0", fetchMock);
    expect(info.status).toBe("not-available");
    expect(info.latestVersion).toBe("0.1.0");
  });

  it("treats 404 as no releases yet", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
    }));

    const info = await checkForAppUpdates("0.1.0", fetchMock);
    expect(info.status).toBe("not-available");
    expect(info.downloadUrl).toContain("releases");
  });
});
