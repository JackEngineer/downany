export function formatBytes(n: number): string {
  if (!n) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function isActiveStatus(status: string): boolean {
  return status === "downloading" || status === "pending" || status === "paused";
}

export function statusLabel(status: string, locale: Locale = getLocale()): string {
  switch (status) {
    case "pending":
      return t("status.pending", locale);
    case "downloading":
      return t("status.downloading", locale);
    case "paused":
      return t("status.paused", locale);
    case "completed":
      return t("status.completed", locale);
    case "failed":
      return t("status.failed", locale);
    case "cancelled":
      return t("status.cancelled", locale);
    default:
      return t("status.unknown", locale);
  }
}

export function platformLabel(platform: string | undefined | null, locale: Locale = getLocale()): string {
  const key = String(platform || "").trim().toLowerCase();
  switch (key) {
    case "youtube":
      return "YouTube";
    case "bilibili":
      return "Bilibili";
    case "douyin":
      return t("platform.douyin", locale);
    case "tiktok":
      return "TikTok";
    case "twitter":
      return "X";
    case "instagram":
      return "Instagram";
    case "pornhub":
      return t("platform.video", locale);
    case "xiaohongshu":
      return t("platform.xiaohongshu", locale);
    case "unknown":
    case "":
      return t("platform.unknown", locale);
    default:
      return key;
  }
}
import { getLocale, t, type Locale } from "../i18n";
