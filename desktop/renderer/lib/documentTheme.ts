import { useEffect } from "react";

import type { AppSettings } from "./types";

type ResolvedTheme = "light" | "dark";

function applyResolvedTheme(theme: ResolvedTheme): void {
  document.documentElement.setAttribute("data-theme", theme);
}

export function useDocumentTheme(
  mode: AppSettings["theme_mode"] | undefined,
): void {
  useEffect(() => {
    if (!mode) return;

    let active = true;
    void window.api.setThemeSource(mode);

    if (mode !== "system") {
      applyResolvedTheme(mode);
      return () => {
        active = false;
      };
    }

    void window.api.getNativeTheme().then((resolved) => {
      if (active) applyResolvedTheme(resolved);
    });
    const offNativeTheme = window.api.onNativeTheme((resolved) => {
      if (active) applyResolvedTheme(resolved);
    });

    return () => {
      active = false;
      offNativeTheme();
    };
  }, [mode]);
}
