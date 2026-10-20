import { siteContent, siteLinks } from "../content/siteContent";

export function DevelopmentProgress() {
  const content = siteContent.development;
  return <section className="development section-shell" id="development" aria-labelledby="development-title">
    <div className="development__heading"><p className="development__version">{content.version}</p><h2 id="development-title">{content.title}</h2><p>{content.description}</p></div>
    <ul className="development__list">{content.items.map(item => <li key={item.title}><h3>{item.title}</h3><p>{item.description}</p></li>)}</ul>
    <a className="text-link" href={siteLinks.repository}>查看最新源码与说明 →</a>
  </section>;
}
