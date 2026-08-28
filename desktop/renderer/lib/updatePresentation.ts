import type { DesktopApi } from "../../electron/preload";
import { getLocale, t, type Locale } from "../i18n";
import type { ToastItem } from "./types";

export function safeVersion(value: unknown): string {
  if (typeof value !== "string" || value.length > 64) return "";
  return /^\d+(?:\.\d+){1,3}(?:[-+][\da-z.-]+)?$/i.test(value) ? value : "";
}

export function appUpdateToast(
  info: Awaited<ReturnType<DesktopApi["checkAppUpdate"]>>, locale: Locale = getLocale(),
): Pick<ToastItem, "kind" | "title"> {
  switch (info.status) {
    case "available": {
      const version = safeVersion(info.latestVersion);
      return { kind: "success", title: version ? t("update.available", locale, { version }) : t("update.availableUnknown", locale) };
    }
    case "not-available": return { kind: "info", title: t("update.none", locale) };
    case "disabled": return { kind: "info", title: t("update.disabled", locale) };
    case "checking": return { kind: "info", title: t("update.checking", locale) };
    default: return { kind: "error", title: t("update.failed", locale) };
  }
}
