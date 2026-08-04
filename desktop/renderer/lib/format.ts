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

export function statusLabel(status: string): string {
  switch (status) {
    case "pending":
      return "等待中";
    case "downloading":
      return "下载中";
    case "paused":
      return "已暂停";
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
    default:
      return status;
  }
}

/** 把 yt-dlp 长英文错误收成卡片可用的短中文。 */
export function friendlyErrorMessage(message: string | undefined | null): string {
  const raw = String(message || "").trim();
  if (!raw) return "";
  const lower = raw.toLowerCase();
  if (lower.includes("video unavailable") || lower.includes("removed by the uploader")) {
    return "视频已下架或不可用";
  }
  if (lower.includes("private video") || lower.includes("private")) {
    return "视频为私密，需要登录";
  }
  if (lower.includes("sign in") || lower.includes("login")) {
    return "需要登录后才能下载";
  }
  // 去掉常见前缀，再截断
  const cleaned = raw.replace(/^ERROR:\s*\[[^\]]+\]\s*/i, "").trim();
  return cleaned.length > 80 ? `${cleaned.slice(0, 80)}…` : cleaned;
}

export function platformLabel(platform: string | undefined | null): string {
  const key = String(platform || "").trim().toLowerCase();
  switch (key) {
    case "youtube":
      return "YouTube";
    case "bilibili":
      return "Bilibili";
    case "douyin":
      return "抖音";
    case "tiktok":
      return "TikTok";
    case "twitter":
      return "X";
    case "instagram":
      return "Instagram";
    case "pornhub":
      return "Pornhub";
    case "xiaohongshu":
      return "小红书";
    case "unknown":
    case "":
      return "未知平台";
    default:
      return key;
  }
}
