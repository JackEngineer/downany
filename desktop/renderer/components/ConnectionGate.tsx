import { t, useLocale } from "../i18n";
import { useAppStore } from "../store/appStore";
import { openPath } from "../lib/api";

export function ConnectionGate() {
  const locale = useLocale();
  const logDir = useAppStore((s) => s.logDir);
  const displayDir = logDir || t("connection.logPending", locale);

  return (
    <div className="gate" role="alert">
      <h1>{t("connection.title", locale)}</h1>
      <p>{t("connection.copy", locale)}</p>
      <p className="mono">{displayDir}</p>
      <button
        type="button"
        onClick={() => void openPath(logDir).catch(() => {
          useAppStore.getState().pushToast({ kind: "error", title: t("error.openFolder") });
        })}
        disabled={!logDir}
      >
        {t("connection.openLogs", locale)}
      </button>
    </div>
  );
}
