import { List, X } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { siteContent, siteLinks } from "../content/siteContent";

export function SiteHeader() {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  const closeMenu = () => {
    setMenuOpen(false);
    menuButtonRef.current?.focus();
  };

  useEffect(() => {
    if (!menuOpen) {
      return undefined;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeMenu();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  const navigationLinks = siteContent.navigation.map((item) => (
    <a href={item.href} key={item.href} onClick={menuOpen ? closeMenu : undefined}>
      {item.label}
    </a>
  ));

  return (
    <header className="site-header">
      <div className="site-header__inner section-shell">
        <a className="brand" href="#top">
          <img alt="" height="28" src="/assets/logo-mark.svg" width="28" />
          <span>{siteContent.brand}</span>
        </a>
        <nav aria-label="主导航" className="site-header__desktop-nav">
          {navigationLinks}
          <a href={siteLinks.repository} rel="noreferrer" target="_blank">
            GitHub
          </a>
        </nav>
        <button
          aria-controls="mobile-navigation"
          aria-expanded={menuOpen}
          aria-label={menuOpen ? "关闭导航" : "打开导航"}
          className="site-header__menu-button"
          onClick={() => setMenuOpen((current) => !current)}
          ref={menuButtonRef}
          type="button"
        >
          {menuOpen ? <X aria-hidden="true" size={21} /> : <List aria-hidden="true" size={21} />}
        </button>
      </div>
      {menuOpen ? (
        <nav aria-label="移动端导航" className="site-header__mobile-nav" id="mobile-navigation">
          {navigationLinks}
          <a href={siteLinks.repository} onClick={closeMenu} rel="noreferrer" target="_blank">
            GitHub
          </a>
        </nav>
      ) : null}
    </header>
  );
}
