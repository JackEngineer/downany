/** 轻量 i18n：zh-CN / en，语言存 localStorage。 */

export type Locale = "zh-CN" | "en";

const STORAGE_KEY = "downany.locale";

type Dict = Record<string, string>;

const zhCN: Dict = {
  "nav.all": "全部",
  "nav.active": "进行中",
  "nav.completed": "已完成",
  "nav.history": "下载记录",
  "action.add": "添加",
  "action.recognize": "网页识别",
  "action.search": "搜索",
  "action.batch": "批量操作",
  "search.filter": "列表",
  "search.network": "网络",
  "search.dialog": "搜索任务",
  "search.modes.label": "搜索模式",
  "search.platform.label": "搜索平台",
  "search.input.label": "搜索任务",
  "search.close": "关闭搜索",
  "search.placeholder": "搜索任务…",
  "search.network.placeholder": "搜索网络视频",
  "add.placeholder": "粘贴视频链接，回车添加",
  "settings.open": "设置",
  "empty.title": "添加第一个下载任务",
  "empty.copy": "粘贴视频链接，或从浏览器扩展发送当前页面。",
  "empty.action": "粘贴视频链接",
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
  "action.add": "Add",
  "action.recognize": "Recognize page",
  "action.search": "Search",
  "action.batch": "Batch actions",
  "search.filter": "List",
  "search.network": "Web",
  "search.dialog": "Search tasks",
  "search.modes.label": "Search modes",
  "search.platform.label": "Search platform",
  "search.input.label": "Search tasks",
  "search.close": "Close search",
  "search.placeholder": "Search tasks…",
  "search.network.placeholder": "Search online videos",
  "add.placeholder": "Paste a video URL and press Enter",
  "settings.open": "Settings",
  "empty.title": "Add your first download",
  "empty.copy": "Paste a video URL, or send the current page from the browser extension.",
  "empty.action": "Paste video URL",
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
  window.dispatchEvent(new CustomEvent("downany:locale"));
}

export function t(key: string, locale: Locale = getLocale()): string {
  return CATALOG[locale][key] ?? CATALOG["zh-CN"][key] ?? key;
}
