import { useSyncExternalStore } from "react";

import { en } from "./locales/en";
import { zhCN } from "./locales/zh-CN";

export type Locale = "zh-CN" | "en";
const STORAGE_KEY = "downany.locale";
const CATALOG: Record<Locale, Record<string, string>> = { "zh-CN": zhCN, en };
const listeners = new Set<() => void>();
let volatileLocale: Locale | null = null;

export function getLocale(): Locale {
  if (volatileLocale) return volatileLocale;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "en" || raw === "zh-CN") return raw;
  } catch {
    // A blocked storage backend must not prevent opening the app.
  }
  return "zh-CN";
}

function notifyLocale(): void {
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent): void {
  if (event.key !== STORAGE_KEY && event.key !== null) return;
  volatileLocale = null;
  notifyLocale();
}

function subscribeLocale(listener: () => void): () => void {
  if (listeners.size === 0) {
    window.addEventListener("downany:locale", notifyLocale);
    window.addEventListener("storage", onStorage);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.removeEventListener("downany:locale", notifyLocale);
      window.removeEventListener("storage", onStorage);
    }
  };
}

export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale, () => "zh-CN");
}

export function setLocale(locale: Locale): void {
  try {
    localStorage.setItem(STORAGE_KEY, locale);
    volatileLocale = null;
  } catch {
    volatileLocale = locale;
  }
  window.dispatchEvent(new CustomEvent("downany:locale"));
}

export function t(
  key: string, locale: Locale = getLocale(), values: Record<string, string | number> = {},
): string {
  const message = CATALOG[locale][key] ?? CATALOG["zh-CN"][key] ?? key;
  return message.replace(/\{(\w+)\}/g, (placeholder, name: string) => (
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : placeholder
  ));
}
