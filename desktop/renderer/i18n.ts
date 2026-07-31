/** 轻量 i18n：zh-CN / en，语言存 localStorage。 */

export type Locale = "zh-CN" | "en";

const STORAGE_KEY = "videodl.locale";

type Dict = Record<string, string>;

const zhCN: Dict = {
  "nav.all": "全部",
  "nav.active": "进行中",
  "nav.completed": "已完成",
  "nav.history": "历史",
  "search.filter": "列表",
  "search.network": "网络",
  "search.placeholder": "搜索任务…",
  "add.placeholder": "粘贴视频链接，回车添加",
  "settings.open": "设置",
  "onboarding.title": "欢迎使用视频下载器",
  "onboarding.paste": "在上方粘贴链接或拖放到窗口",
  "onboarding.extension": "安装浏览器扩展，一键发送当前页",
  "onboarding.settings": "打开设置配置下载目录与画质",
  "onboarding.dismiss": "知道了",
  "empty.noMatch": "没有匹配的任务",
  "sites.title": "支持的站点",
  "sites.footer": "以及 yt-dlp 支持的 1700+ 站点",
  "settings.language": "界面语言",
  "settings.telemetry": "匿名失败统计（仅本地）",
  "menu.extract": "在浏览器中抓取",
};

const en: Dict = {
  "nav.all": "All",
  "nav.active": "Active",
  "nav.completed": "Completed",
  "nav.history": "History",
  "search.filter": "List",
  "search.network": "Web",
  "search.placeholder": "Search tasks…",
  "add.placeholder": "Paste a video URL and press Enter",
  "settings.open": "Settings",
  "onboarding.title": "Welcome to Video Downloader",
  "onboarding.paste": "Paste a link above or drag & drop here",
  "onboarding.extension": "Install the browser extension to send the current page",
  "onboarding.settings": "Open Settings to configure folder and quality",
  "onboarding.dismiss": "Got it",
  "empty.noMatch": "No matching tasks",
  "sites.title": "Supported sites",
  "sites.footer": "Plus 1700+ sites supported by yt-dlp",
  "settings.language": "Language",
  "settings.telemetry": "Anonymous failure stats (local only)",
  "menu.extract": "Capture in browser",
};

const CATALOG: Record<Locale, Dict> = {
  "zh-CN": zhCN,
  en,
};

export function getLocale(): Locale {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "en" || raw === "zh-CN") return raw;
  } catch {
    // ignore
  }
  return "zh-CN";
}

export function setLocale(locale: Locale): void {
  localStorage.setItem(STORAGE_KEY, locale);
  window.dispatchEvent(new CustomEvent("videodl:locale"));
}

export function t(key: string, locale: Locale = getLocale()): string {
  return CATALOG[locale][key] ?? CATALOG["zh-CN"][key] ?? key;
}
