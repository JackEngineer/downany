import { describe, expect, it } from "vitest";
import {
  DEFAULT_RELEASES_URL,
  isGithubRelease,
  PUBLIC_RELEASE_FALLBACK,
  resolveReleaseAssets,
  type GithubRelease,
} from "./releases";

const release: GithubRelease = {
  tag_name: "v0.2.0",
  html_url: "https://github.com/JackEngineer/downany/releases/tag/v0.2.0",
  assets: [
    {
      name: "Downany-0.2.0-mac.dmg",
      browser_download_url: "https://downloads.example/Downany-0.2.0-mac.dmg",
    },
    {
      name: "DOWNANY-0.2.0-WIN-X64.EXE",
      browser_download_url: "https://downloads.example/Downany-0.2.0-win-x64.exe",
    },
    {
      name: "Downany-chrome-extension-0.2.0.zip",
      browser_download_url: "https://downloads.example/Downany-chrome-extension-0.2.0.zip",
    },
    {
      name: "checksums.txt",
      browser_download_url: "https://downloads.example/checksums.txt",
    },
  ],
};

describe("resolveReleaseAssets", () => {
  it("provides the verified desktop and extension downloads from the same release", () => {
    expect(resolveReleaseAssets(PUBLIC_RELEASE_FALLBACK)).toEqual({
      tagName: "v0.3.2",
      releasePage: "https://github.com/JackEngineer/downany/releases/tag/v0.3.2",
      macos: {
        status: "ready",
        url: "https://github.com/JackEngineer/downany/releases/download/v0.3.2/Downany-0.3.2-mac.dmg",
      },
      windows: {
        status: "ready",
        url: "https://github.com/JackEngineer/downany/releases/download/v0.3.2/Downany-0.3.2-win-x64.exe",
      },
      extension: {
        status: "ready",
        url: "https://github.com/JackEngineer/downany/releases/download/v0.3.2/Downany-chrome-extension-0.9.2.zip",
      },
    });
  });

  it("returns the exact public URL for each recognized asset", () => {
    const links = resolveReleaseAssets(release);

    expect(links).toEqual({
      tagName: "v0.2.0",
      releasePage: "https://github.com/JackEngineer/downany/releases/tag/v0.2.0",
      macos: {
        status: "ready",
        url: "https://downloads.example/Downany-0.2.0-mac.dmg",
      },
      windows: {
        status: "ready",
        url: "https://downloads.example/Downany-0.2.0-win-x64.exe",
      },
      extension: {
        status: "ready",
        url: "https://downloads.example/Downany-chrome-extension-0.2.0.zip",
      },
    });
  });

  it.each([
    ["windows", "win-x64"],
    ["macos", "mac.dmg"],
    ["extension", "chrome-extension"],
  ] as const)("sends a missing %s asset to its own release page without borrowing fallback assets", (target, namePart) => {
    const links = resolveReleaseAssets({
      ...release,
      assets: release.assets.filter((asset) => !asset.name.toLowerCase().includes(namePart)),
    });

    expect(links[target]).toEqual({
      status: "missing",
      url: release.html_url,
    });
  });

  it("falls back to the releases index when no release payload is available", () => {
    expect(resolveReleaseAssets(null)).toEqual({
      tagName: null,
      releasePage: DEFAULT_RELEASES_URL,
      macos: { status: "missing", url: DEFAULT_RELEASES_URL },
      windows: { status: "missing", url: DEFAULT_RELEASES_URL },
      extension: { status: "missing", url: DEFAULT_RELEASES_URL },
    });
  });

  it("uses a caller-provided fallback when the API payload is absent", () => {
    const fallbackUrl = "https://example.test/releases";

    expect(resolveReleaseAssets(null, fallbackUrl).releasePage).toBe(fallbackUrl);
    expect(resolveReleaseAssets(null, fallbackUrl).macos.url).toBe(fallbackUrl);
  });
});

describe("isGithubRelease", () => {
  it("accepts valid release data, including a release with no assets", () => {
    expect(isGithubRelease(release)).toBe(true);
    expect(isGithubRelease({ ...release, assets: [] })).toBe(true);
  });

  it.each([
    null,
    [],
    {},
    { ...release, tag_name: 32 },
    { ...release, tag_name: " " },
    { ...release, html_url: null },
    { ...release, html_url: "not a URL" },
    { ...release, html_url: "javascript:alert(1)" },
    { ...release, assets: null },
    { ...release, assets: {} },
    { ...release, assets: [null] },
    { ...release, assets: [{ name: "file.zip" }] },
    { ...release, assets: [{ name: " ", browser_download_url: "https://example.test/file.zip" }] },
    { ...release, assets: [{ name: "file.zip", browser_download_url: "javascript:alert(1)" }] },
  ])("rejects invalid release data %j", (payload) => {
    expect(isGithubRelease(payload)).toBe(false);
  });
});
