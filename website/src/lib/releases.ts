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
  tag_name: "v0.3.2",
  html_url: "https://github.com/JackEngineer/downany/releases/tag/v0.3.2",
  assets: [
    {
      name: "Downany-0.3.2-mac.dmg",
      browser_download_url:
        "https://github.com/JackEngineer/downany/releases/download/v0.3.2/Downany-0.3.2-mac.dmg",
    },
    {
      name: "Downany-0.3.2-win-x64.exe",
      browser_download_url:
        "https://github.com/JackEngineer/downany/releases/download/v0.3.2/Downany-0.3.2-win-x64.exe",
    },
    {
      name: "Downany-chrome-extension-0.9.2.zip",
      browser_download_url:
        "https://github.com/JackEngineer/downany/releases/download/v0.3.2/Downany-chrome-extension-0.9.2.zip",
    },
  ],
};

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) {
    return false;
  }

  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** Validate the API boundary before release data reaches the download controls. */
export function isGithubRelease(value: unknown): value is GithubRelease {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const release = value as Record<string, unknown>;
  return (
    typeof release.tag_name === "string" &&
    release.tag_name.trim().length > 0 &&
    isHttpsUrl(release.html_url) &&
    Array.isArray(release.assets) &&
    release.assets.every((asset: unknown) => {
      if (typeof asset !== "object" || asset === null) {
        return false;
      }

      const candidate = asset as Record<string, unknown>;
      return (
        typeof candidate.name === "string" &&
        candidate.name.trim().length > 0 &&
        isHttpsUrl(candidate.browser_download_url)
      );
    })
  );
}

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
