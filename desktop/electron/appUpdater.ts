/**
 * 轻量应用更新检查（无需签名）。
 * 查询 GitHub Releases latest，semver 比较后引导用户前往下载页。
 * 签名 + electron-updater 自动替换见 docs/RELEASE.md。
 */

export type AppUpdateStatus =
  | "disabled"
  | "checking"
  | "available"
  | "not-available"
  | "error";

export type AppUpdateInfo = {
  status: AppUpdateStatus;
  currentVersion: string;
  latestVersion?: string;
  message: string;
  downloadUrl?: string;
};

const DEFAULT_GITHUB_REPO = "JackEngineer/downany";

type FetchLike = (
  input: string,
  init?: { headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

function resolveGithubRepo(): string {
  const fromEnv = (
    process.env.DOWNANY_GITHUB_REPO ||
    process.env.VIDEODL_GITHUB_REPO ||
    ""
  ).trim();
  if (fromEnv) return fromEnv.replace(/^https?:\/\/github\.com\//i, "").replace(/\/+$/, "");
  return DEFAULT_GITHUB_REPO;
}

/** 未显式禁用时始终视为已配置（默认走 GitHub Releases）。 */
export function isAppUpdateConfigured(): boolean {
  const disabled = (
    process.env.DOWNANY_UPDATE_DISABLED ||
    process.env.VIDEODL_UPDATE_DISABLED ||
    ""
  )
    .trim()
    .toLowerCase();
  return disabled !== "1" && disabled !== "true" && disabled !== "yes";
}

export function parseSemver(version: string): number[] {
  const cleaned = String(version || "")
    .trim()
    .replace(/^v/i, "")
    .split(/[+(-]/)[0];
  return cleaned.split(".").map((part) => {
    const n = parseInt(part.replace(/[^\d].*$/, ""), 10);
    return Number.isFinite(n) ? n : 0;
  });
}

/** @returns 正数 = a > b；0 = 相等；负数 = a < b */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

function releaseDownloadUrl(repo: string, tag: string, htmlUrl?: string): string {
  if (htmlUrl && /^https?:\/\//i.test(htmlUrl)) return htmlUrl;
  return `https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}`;
}

export async function checkForAppUpdates(
  currentVersion: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis) as FetchLike,
): Promise<AppUpdateInfo> {
  if (!isAppUpdateConfigured()) {
    return {
      status: "disabled",
      currentVersion,
      message:
        "应用自更新检查已禁用（DOWNANY_UPDATE_DISABLED）。签名公证后可启用自动替换，见 docs/RELEASE.md。",
    };
  }

  const repo = resolveGithubRepo();
  const apiUrl = `https://api.github.com/repos/${repo}/releases/latest`;

  try {
    const response = await fetchImpl(apiUrl, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "Downany-UpdateCheck",
      },
    });

    if (response.status === 404) {
      return {
        status: "not-available",
        currentVersion,
        latestVersion: currentVersion,
        message: "尚未发布任何版本，当前即为最新。",
        downloadUrl: `https://github.com/${repo}/releases`,
      };
    }

    if (!response.ok) {
      return {
        status: "error",
        currentVersion,
        message: `检查更新失败（HTTP ${response.status}）。请稍后重试或前往 GitHub Releases。`,
        downloadUrl: `https://github.com/${repo}/releases`,
      };
    }

    const payload = (await response.json()) as {
      tag_name?: string;
      html_url?: string;
      draft?: boolean;
      prerelease?: boolean;
    };

    const tag = String(payload.tag_name || "").trim();
    if (!tag || payload.draft) {
      return {
        status: "not-available",
        currentVersion,
        latestVersion: currentVersion,
        message: "尚未找到可用的正式版本。",
        downloadUrl: `https://github.com/${repo}/releases`,
      };
    }

    const latestVersion = tag.replace(/^v/i, "");
    const downloadUrl = releaseDownloadUrl(repo, tag, payload.html_url);
    const cmp = compareSemver(latestVersion, currentVersion);

    if (cmp > 0) {
      return {
        status: "available",
        currentVersion,
        latestVersion,
        downloadUrl,
        message: `发现新版本 ${latestVersion}，请前往下载页获取更新。`,
      };
    }

    return {
      status: "not-available",
      currentVersion,
      latestVersion,
      downloadUrl,
      message: "当前已是最新版本。",
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      status: "error",
      currentVersion,
      message: `检查更新失败：${detail}`,
      downloadUrl: `https://github.com/${repo}/releases`,
    };
  }
}
