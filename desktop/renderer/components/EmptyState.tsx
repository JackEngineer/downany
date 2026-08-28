import { t, useLocale } from "../i18n";
import { useAppStore } from "../store/appStore";
import { Button } from "./ui/Button";
import { Icon } from "./ui/Icon";

export function EmptyState() {
  const requestAddFocus = useAppStore((state) => state.requestAddFocus);
  const locale = useLocale();

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
