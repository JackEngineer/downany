import { siteContent, siteLinks } from "../content/siteContent";

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-footer__inner section-shell">
        <a className="brand brand--footer" href="#top">
          <img alt="" height="28" src="/assets/logo-mark.svg" width="28" />
          <span>{siteContent.brand}</span>
        </a>
        <nav aria-label="页脚导航">
          <a href={siteLinks.repository} rel="noreferrer" target="_blank">
            GitHub
          </a>
          <a href={siteLinks.releases} rel="noreferrer" target="_blank">
            下载
          </a>
          <a href={siteLinks.releaseGuide} rel="noreferrer" target="_blank">
            安装说明
          </a>
        </nav>
      </div>
    </footer>
  );
}
