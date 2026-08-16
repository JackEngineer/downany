import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppSettings } from "./types";
import { useDocumentTheme } from "./documentTheme";

const setThemeSource = vi.fn();
const listeners = new Set<(theme: "light" | "dark") => void>();

function Harness({ mode }: { mode: AppSettings["theme_mode"] | undefined }) {
  useDocumentTheme(mode);
  return null;
}

beforeEach(() => {
  vi.clearAllMocks();
  listeners.clear();
  document.documentElement.removeAttribute("data-theme");
});

afterEach(cleanup);

describe("useDocumentTheme", () => {
  it("keeps the CSS dark bootstrap untouched until settings hydrate", () => {
    window.api = {
      setThemeSource,
      getNativeTheme: vi.fn().mockResolvedValue("light"),
      onNativeTheme: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as typeof window.api;

    render(<Harness mode={undefined} />);

    expect(document.documentElement).not.toHaveAttribute("data-theme");
    expect(setThemeSource).not.toHaveBeenCalled();
  });

  it("does not let a delayed system lookup overwrite a hydrated explicit theme", async () => {
    let resolveNative!: (theme: "light" | "dark") => void;
    const nativeTheme = new Promise<"light" | "dark">((resolve) => {
      resolveNative = resolve;
    });
    window.api = {
      setThemeSource,
      getNativeTheme: vi.fn(() => nativeTheme),
      onNativeTheme: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as typeof window.api;

    const { rerender } = render(<Harness mode="system" />);
    rerender(<Harness mode="dark" />);
    resolveNative("light");
    await nativeTheme;
    await Promise.resolve();

    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(setThemeSource).toHaveBeenLastCalledWith("dark");
  });

  it("tracks native changes only while system theme is active", async () => {
    window.api = {
      setThemeSource,
      getNativeTheme: vi.fn().mockResolvedValue("light"),
      onNativeTheme: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as typeof window.api;

    const { rerender } = render(<Harness mode="system" />);
    await Promise.resolve();
    expect(document.documentElement).toHaveAttribute("data-theme", "light");

    listeners.forEach((listener) => listener("dark"));
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");

    rerender(<Harness mode="light" />);
    listeners.forEach((listener) => listener("dark"));
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
  });
});
