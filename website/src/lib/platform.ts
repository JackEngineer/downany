export type Platform = "macos" | "windows" | "other";
export type DownloadPlatform = Exclude<Platform, "other">;

export interface PlatformSignals {
  userAgentDataPlatform?: string | null;
  userAgent?: string | null;
}

export function detectPlatform(signals: PlatformSignals): Platform {
  const source = (signals.userAgentDataPlatform?.trim() || signals.userAgent || "").toLowerCase();

  if (source.includes("win")) {
    return "windows";
  }

  if (source.includes("mac") || source.includes("iphone") || source.includes("ipad")) {
    return "macos";
  }

  return "other";
}

export function orderPlatforms(platform: Platform): DownloadPlatform[] {
  return platform === "windows" ? ["windows", "macos"] : ["macos", "windows"];
}
