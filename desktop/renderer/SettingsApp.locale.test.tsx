import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DesktopApi } from "../electron/preload";
import { setLocale } from "./i18n";
import { SettingsApp } from "./SettingsApp";
import { useAppStore } from "./store/appStore";
import { settingsFixture } from "./test/settingsFixture";

const request = vi.fn();
const privateError = "Cookie: fake-secret https://example.com/private C:\\private\\data";
beforeEach(() => {
  localStorage.clear();
  setLocale("zh-CN");
  request.mockReset().mockImplementation(async (method) => {
    if (method === "settings.get") return settingsFixture();
    if (method === "app.runMigration") return { status: "skipped" };
    return {};
  });
  window.api = {
    platform: "win32", request,
    getConnectionState: vi.fn().mockResolvedValue("connected"),
    onEvent: () => () => undefined, onState: () => () => undefined, onMigration: () => () => undefined,
    setThemeSource: vi.fn().mockResolvedValue(undefined),
    checkAppUpdate: vi.fn().mockResolvedValue({ status: "not-available", currentVersion: "0.3.0", message: "raw" }),
    showItemInFolder: vi.fn().mockResolvedValue(undefined),
    openExternal: vi.fn().mockResolvedValue(undefined),
    selectDirectory: vi.fn().mockResolvedValue(null),
  } as unknown as DesktopApi;
  useAppStore.setState({ settings: settingsFixture(), connection: "connected", toasts: [] });
});
afterEach(() => { cleanup(); setLocale("zh-CN"); });
async function mount() { render(<SettingsApp />); await act(async () => { await Promise.resolve(); }); }

describe("settings language and safe results", () => {
  it("updates the mounted settings window from another window's language selection", async () => {
    await mount();
    act(() => {
      localStorage.setItem("downany.locale", "en");
      window.dispatchEvent(new StorageEvent("storage", { key: "downany.locale" }));
    });
    expect(screen.getByRole("button", { name: "Export diagnostics" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Check app updates" })).toBeEnabled();
    expect(screen.getByRole("combobox", { name: "Language" })).toHaveValue("en");
    expect(document.body.textContent).not.toMatch(/electron-updater|docs\/RELEASE/);
  });

  it("does not claim diagnostics were exported when the result says no", async () => {
    request.mockImplementation(async (method) => method === "app.exportDiagnostics" ? { ok: false, path: "" } : settingsFixture());
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "导出诊断包" }));
    await waitFor(() => expect(useAppStore.getState().toasts).toHaveLength(1));
    expect(useAppStore.getState().toasts[0].kind).toBe("error");
    expect(window.api.showItemInFolder).not.toHaveBeenCalled();
  });

  it("retains an exported diagnostic path when only opening its folder fails", async () => {
    const path = "C:\\isolated\\diagnostics.zip";
    request.mockImplementation(async (method) => method === "app.exportDiagnostics" ? { ok: true, path } : settingsFixture());
    vi.mocked(window.api.showItemInFolder).mockRejectedValue(new Error(privateError));
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "导出诊断包" }));
    await waitFor(() => expect(useAppStore.getState().toasts).toHaveLength(2));
    expect(useAppStore.getState().toasts.map(({ kind }) => kind)).toEqual(["success", "info"]);
    expect(screen.getByText(path)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("fake-secret");
  });

  it.each([false, true])("handles rejected and structured update errors without exposing internals (%s)", async (structured) => {
    if (structured) vi.mocked(window.api.checkAppUpdate).mockResolvedValue({ status: "error", currentVersion: "0.3.0", message: privateError });
    else vi.mocked(window.api.checkAppUpdate).mockRejectedValue(new Error(privateError));
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "检查应用更新" }));
    await waitFor(() => expect(useAppStore.getState().toasts).toHaveLength(1));
    expect(useAppStore.getState().toasts[0].kind).toBe("error");
    expect(screen.getByRole("button", { name: "检查应用更新" })).toBeEnabled();
    expect(document.body.textContent).not.toContain("fake-secret");
  });

  it("localizes an available release using its structured version, not raw server copy", async () => {
    setLocale("en");
    vi.mocked(window.api.checkAppUpdate).mockResolvedValue({ status: "available", currentVersion: "0.3.0", latestVersion: "0.3.1", message: privateError, downloadUrl: "https://github.com/JackEngineer/downany/releases" });
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Check app updates" }));
    await waitFor(() => expect(useAppStore.getState().toasts).toHaveLength(1));
    expect(useAppStore.getState().toasts[0].title).toContain("0.3.1");
    expect(screen.getByRole("button", { name: "Go to download" })).toBeEnabled();
    expect(document.body.textContent).not.toContain("fake-secret");
  });

  it("does not show raw download-tool lookup errors", async () => {
    request.mockImplementation(async (method) => {
      if (method === "updater.checkYtDlp") throw new Error(privateError);
      return settingsFixture();
    });
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "检查更新" })).toBeEnabled());
    expect(document.body.textContent).not.toContain("fake-secret");
  });
});
