import type { TaskAction, TaskActionReport, ToastItem } from "./types";

function actionKey(action: TaskAction): string {
  switch (action) {
    case "pause": return "pause";
    case "resume": return "resume";
    case "cancel": return "cancel";
    case "retry": return "retry";
    default: {
      const exhaustive: never = action;
      throw new Error(`Unknown task action: ${exhaustive}`);
    }
  }
}

export function taskActionToast(report: TaskActionReport, locale: Locale = getLocale()): Pick<ToastItem, "kind" | "title"> {
  const action = actionKey(report.action);
  const applied = report.applied.length;
  const deferred = report.deferred.length;
  const skipped = report.skipped.length;
  if (applied === 0 && deferred === 0) {
    return { kind: "info", title: t(`actionReport.${action}.none`, locale) };
  }
  const parts: string[] = [];
  if (applied > 0) parts.push(t(`actionReport.${action}.applied`, locale, { count: applied }));
  if (deferred > 0) parts.push(t("actionReport.deferred", locale, { count: deferred }));
  if (skipped > 0) parts.push(t("actionReport.skipped", locale, { count: skipped }));
  return {
    kind: deferred === 0 && skipped === 0 ? "success" : "info",
    title: parts.join(t("actionReport.separator", locale)),
  };
}
import { getLocale, t, type Locale } from "../i18n";
