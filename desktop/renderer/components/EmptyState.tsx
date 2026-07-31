import { useEffect, useState } from "react";

import { getLocale, t } from "../i18n";

const DISMISS_KEY = "videodl.onboarding.dismissed";

export function isOnboardingDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

function dismissOnboarding(): void {
  localStorage.setItem(DISMISS_KEY, "1");
  window.dispatchEvent(new CustomEvent("videodl:onboarding"));
}

export function EmptyState() {
  const [, bump] = useState(0);
  const locale = getLocale();

  useEffect(() => {
    const onLocale = () => bump((n) => n + 1);
    window.addEventListener("videodl:locale", onLocale);
    return () => window.removeEventListener("videodl:locale", onLocale);
  }, []);

  return (
    <div className="empty-state">
      <div className="empty-state-icon" aria-hidden>
        ⇩
      </div>
      <h2 className="empty-state-title">{t("onboarding.title", locale)}</h2>
      <ul className="empty-state-steps">
        <li>{t("onboarding.paste", locale)}</li>
        <li>{t("onboarding.extension", locale)}</li>
        <li>{t("onboarding.settings", locale)}</li>
      </ul>
      <div className="empty-state-actions">
        <button type="button" className="primary" onClick={() => void window.api.openSettings()}>
          {t("settings.open", locale)}
        </button>
        <button type="button" onClick={dismissOnboarding}>
          {t("onboarding.dismiss", locale)}
        </button>
      </div>
    </div>
  );
}
