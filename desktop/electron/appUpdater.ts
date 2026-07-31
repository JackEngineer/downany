/**
 * Application auto-update stub (M0.5).
 * Full electron-updater wiring requires a signed build + publish feed.
 * Until then, check/update report a clear "not configured" status.
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
};

const FEED_URL = (process.env.VIDEODL_UPDATE_FEED || "").trim();

export function isAppUpdateConfigured(): boolean {
  return Boolean(FEED_URL);
}

export async function checkForAppUpdates(
  currentVersion: string,
): Promise<AppUpdateInfo> {
  if (!FEED_URL) {
    return {
      status: "disabled",
      currentVersion,
      message:
        "应用自更新尚未配置。设置 VIDEODL_UPDATE_FEED 并完成签名公证后启用（见 docs/RELEASE.md）。",
    };
  }

  // Placeholder for electron-updater once feed + signing are ready.
  return {
    status: "not-available",
    currentVersion,
    latestVersion: currentVersion,
    message: "更新源已配置，但 electron-updater 集成待证书到位后完成。",
  };
}
