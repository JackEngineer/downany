import { useEffect, useState } from "react";

import { getLocale, t, type Locale } from "../i18n";
import { useAppStore } from "../store/appStore";
import { Button } from "./ui/Button";
import { Icon } from "./ui/Icon";

export function EmptyState() {
  const requestAddFocus = useAppStore((state) => state.requestAddFocus);
  const [locale, setLocaleState] = useState<Locale>(() => getLocale());

  useEffect(() => {
    const updateLocale = () => setLocaleState(getLocale());
    window.addEventListener("downany:locale", updateLocale);
    return () => window.removeEventListener("downany:locale", updateLocale);
  }, []);

  return (
    <div className="empty-state">
      <Icon name="download" size={32} className="empty-state-icon" />
      <h2 className="empty-state-title">{t("empty.title", locale)}</h2>
      <p className="empty-state-copy">{t("empty.copy", locale)}</p>
      <Button variant="primary" leadingIcon="link" onClick={requestAddFocus}>
        {t("empty.action", locale)}
      </Button>
    </div>
  );
}
