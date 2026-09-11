export const DEFAULT_RELEASES_URL = "https://github.com/JackEngineer/downany/releases";

export interface GithubReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface GithubRelease {
  tag_name: string;
  html_url: string;
  assets: GithubReleaseAsset[];
}

/** Last verified public release, used when the browser cannot query GitHub's API. */
export const PUBLIC_RELEASE_FALLBACK: GithubRelease = {
  tag_name: "v0.3.0",
  html_url: "https://github.com/JackEngineer/downany/releases/tag/v0.3.0",
  assets: [
    {
      name: "Downany-0.3.0-mac.dmg",
      browser_download_url:
        "https://github.com/JackEngineer/downany/releases/download/v0.3.0/Downany-0.3.0-mac.dmg",
    },
    {
      name: "Downany-0.3.0-win-x64.exe",
      browser_download_url:
        "https://github.com/JackEngineer/downany/releases/download/v0.3.0/Downany-0.3.0-win-x64.exe",
    },
    {
      name: "Downany-chrome-extension-0.8.2.zip",
      browser_download_url:
        "https://github.com/JackEngineer/downany/releases/download/v0.3.0/Downany-chrome-extension-0.8.2.zip",
    },
  ],
};

export interface DownloadTarget {
  status: "ready" | "missing";
  url: string;
}

export interface DownloadLinks {
  tagName: string | null;
  releasePage: string;
  macos: DownloadTarget;
  windows: DownloadTarget;
  extension: DownloadTarget;
}

export function resolveReleaseAssets(
  release: GithubRelease | null,
  fallbackUrl = DEFAULT_RELEASES_URL,
): DownloadLinks {
  const releasePage = release?.html_url || fallbackUrl;

  const resolveTarget = (pattern: RegExp): DownloadTarget => {
    const asset = release?.assets.find((candidate) => pattern.test(candidate.name));
    return asset
      ? { status: "ready", url: asset.browser_download_url }
      : { status: "missing", url: releasePage };
  };

  return {
    tagName: release?.tag_name ?? null,
    releasePage,
    macos: resolveTarget(/^Downany-.*-mac\.dmg$/i),
    windows: resolveTarget(/^Downany-.*-win-x64\.exe$/i),
    extension: resolveTarget(/^Downany-chrome-extension-.*\.zip$/i),
  };
}
