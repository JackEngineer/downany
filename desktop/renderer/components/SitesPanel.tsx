import { getLocale, t } from "../i18n";

const SUPPORTED_SITES = [
  { name: "YouTube", url: "https://www.youtube.com" },
  { name: "Bilibili", url: "https://www.bilibili.com" },
  { name: "Douyin", url: "https://www.douyin.com" },
  { name: "TikTok", url: "https://www.tiktok.com" },
  { name: "Twitter / X", url: "https://x.com" },
  { name: "Instagram", url: "https://www.instagram.com" },
  { name: "小红书", url: "https://www.xiaohongshu.com" },
  { name: "Pornhub", url: "https://www.pornhub.com" },
] as const;

export function SitesPanel() {
  const locale = getLocale();
  return (
    <div className="settings-grid sites-panel">
      <h3>{t("sites.title", locale)}</h3>
      <ul className="sites-list">
        {SUPPORTED_SITES.map((site) => (
          <li key={site.name}>
            <a href={site.url} target="_blank" rel="noreferrer">
              {site.name}
            </a>
          </li>
        ))}
      </ul>
      <p className="muted">
        {t("sites.footer", locale)} —{" "}
        <a
          href="https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md"
          target="_blank"
          rel="noreferrer"
        >
          yt-dlp supported sites
        </a>
      </p>
    </div>
  );
}
