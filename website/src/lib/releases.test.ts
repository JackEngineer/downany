import { describe, expect, it } from "vitest";
import {
  DEFAULT_RELEASES_URL,
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

  it("marks Windows missing instead of borrowing an unrelated asset URL", () => {
    const links = resolveReleaseAssets({
      ...release,
      assets: release.assets.filter((asset) => !asset.name.toLowerCase().includes("win-x64")),
    });

    expect(links.windows).toEqual({
      status: "missing",
      url: release.html_url,
    });
    expect(links.macos.status).toBe("ready");
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
