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
