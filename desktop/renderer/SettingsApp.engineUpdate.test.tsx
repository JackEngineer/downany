import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DesktopApi } from "../electron/preload";
import { setLocale } from "./i18n";
import { SettingsApp } from "./SettingsApp";
import { useAppStore } from "./store/appStore";
import { deferred } from "./test/deferred";
import { settingsFixture } from "./test/settingsFixture";

const currentVersion = "2026.08.19";
const version = "2026.09.27";
const privateError = "Cookie: fake-secret https://example.com/private C:\\private\\data";
const request = vi.fn();
let engineState: unknown;
let result: unknown;

beforeEach(() => {
  localStorage.clear();
  setLocale("zh-CN");
  engineState = { current: { version: currentVersion, source: "bundled", selection: "bundled" }, pending: null };
  result = { ok: true, state: "activated", version };
  request.mockReset().mockImplementation(async (method) => {
    if (method === "settings.get") return settingsFixture();
    if (method === "app.runMigration") return { status: "skipped" };
    if (method === "updater.getEngineState") return engineState;
    if (method === "updater.checkYtDlp") return { currentVersion, latestVersion: version, updateAvailable: true, downloadUrl: privateError };
    if (method === "updater.updateYtDlp") return result;
    return {};
  });
  window.api = {
    platform: "win32", request,
    getConnectionState: vi.fn().mockResolvedValue("connected"),
    onEvent: () => () => undefined, onState: () => () => undefined, onMigration: () => () => undefined,
    onSettingsFocus: () => () => undefined,
    setThemeSource: vi.fn().mockResolvedValue(undefined),
  } as unknown as DesktopApi;
  useAppStore.setState({ settings: settingsFixture(), connection: "connected", toasts: [] });
});

afterEach(() => { cleanup(); setLocale("zh-CN"); });

async function mount() {
  render(<SettingsApp />);
  await act(async () => { await Promise.resolve(); });
}

async function checkAndUpdate() {
  fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
  await waitFor(() => expect(screen.getByRole("button", { name: /下载并启用|更新下载工具/ })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: /下载并启用|更新下载工具/ }));
  await act(async () => { await Promise.resolve(); });
}

describe("download engine activation results", () => {
  it("loads a prepared update without a network check or claiming the current release is latest", async () => {
    engineState = { current: { version: currentVersion }, pending: { version, sha256: "a".repeat(64) } };
    await mount();
    expect(request).toHaveBeenCalledWith("updater.getEngineState", {});
    expect(request).not.toHaveBeenCalledWith("updater.checkYtDlp", {});
    expect(screen.getByText(`当前版本：${currentVersion}`, { exact: false })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "启用更新" })).toBeEnabled();
    expect(document.body.textContent).toContain(`更新 ${version} 已准备好`);
    expect(document.body.textContent).not.toContain("未发现新版本");
  });

  it("does not equate a local current version with a completed online check", async () => {
    await mount();
    expect(screen.getByText(`当前版本：${currentVersion}`, { exact: false })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下载并启用" })).toBeDisabled();
    expect(document.body.textContent).not.toContain("未发现新版本");
  });

  it("does not offer an already active archive when its pending record remains", async () => {
    engineState = { current: { version, source: "updated", selection: "a".repeat(64) }, pending: { version, sha256: "a".repeat(64) } };
    await mount();
    expect(document.body.textContent).toContain(`当前版本：${version}`);
    expect(screen.queryByRole("button", { name: "启用更新" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下载并启用" })).toBeDisabled();
  });

  it("rejects the legacy ok result and never sends a renderer download URL", async () => {
    result = { ok: true, version };
    await mount();
    await checkAndUpdate();
    expect(request).toHaveBeenCalledWith("updater.updateYtDlp", {});
    expect(useAppStore.getState().toasts.some((toast) => toast.kind === "success")).toBe(false);
    expect(document.body.textContent).toContain(`当前版本：${currentVersion}`);
    expect(document.body.textContent).not.toContain(privateError);
  });

  it("keeps the running version when prepared and permits a later activation retry", async () => {
    result = { ok: false, state: "prepared", version, currentVersion };
    await mount();
    await checkAndUpdate();
    expect(document.body.textContent).toContain(`当前版本：${currentVersion}`);
    expect(document.body.textContent).toContain("请在当前任务结束后启用");
    expect(screen.getByRole("button", { name: "启用更新" })).toBeEnabled();
    expect(useAppStore.getState().toasts.some((toast) => toast.kind === "success")).toBe(false);
    result = { ok: true, state: "activated", version };
    fireEvent.click(screen.getByRole("button", { name: "启用更新" }));
    await waitFor(() => expect(useAppStore.getState().toasts.some((toast) => toast.kind === "success")).toBe(true));
    expect(document.body.textContent).toContain(`当前版本：${version}`);
    expect(screen.queryByRole("button", { name: "启用更新" })).not.toBeInTheDocument();
  });

  it.each(["zh-CN", "en"] as const)("clears stale pending on a current result without announcing activation (%s)", async (locale) => {
    setLocale(locale);
    engineState = { current: { version: currentVersion }, pending: { version, sha256: "a".repeat(64) } };
    result = { ok: true, state: "current", version };
    await mount();
    fireEvent.click(screen.getByRole("button", { name: locale === "en" ? "Activate update" : "启用更新" }));
    await act(async () => { await Promise.resolve(); });
    expect(document.body.textContent).toContain(locale === "en" ? `Current version: ${version}` : `当前版本：${version}`);
    expect(screen.queryByRole("button", { name: locale === "en" ? "Activate update" : "启用更新" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: locale === "en" ? "Download and activate" : "下载并启用" })).toBeDisabled();
    expect(useAppStore.getState().toasts).toEqual([expect.objectContaining({
      kind: "info",
      title: locale === "en" ? `No newer version found (${version})` : `未发现新版本（${version}）`,
    })]);
  });

  it("keeps the activation result through reconnection and ignores late old state reads", async () => {
    await mount();
    const activation = deferred<unknown>();
    const lateState = deferred<unknown>();
    result = activation.promise;
    const original = request.getMockImplementation()!;
    request.mockImplementation((method, payload) => method === "updater.getEngineState" ? lateState.promise : original(method, payload));
    await checkAndUpdate();
    act(() => useAppStore.getState().setConnection("reconnecting"));
    act(() => useAppStore.getState().setConnection("connected"));
    await act(async () => { activation.resolve({ ok: true, state: "activated", version }); });
    await act(async () => { lateState.resolve(engineState); });
    expect(document.body.textContent).toContain(`当前版本：${version}`);
    expect(useAppStore.getState().toasts.filter((toast) => toast.kind === "success")).toHaveLength(1);
  });

  it("reports rollback with the restored version and keeps the prepared retry", async () => {
    result = { ok: false, state: "rolled_back", version, currentVersion };
    await mount();
    await checkAndUpdate();
    expect(document.body.textContent).toContain(`当前版本：${currentVersion}`);
    expect(document.body.textContent).toContain(`已恢复至 ${currentVersion}`);
    expect(screen.getByRole("button", { name: "启用更新" })).toBeEnabled();
    expect(useAppStore.getState().toasts.some((toast) => toast.kind === "success")).toBe(false);
  });

  it("shows a restart requirement after failed recovery even if the connection gate fails", async () => {
    await mount();
    const activation = deferred<unknown>();
    result = activation.promise;
    await checkAndUpdate();
    act(() => useAppStore.getState().setConnection("failed"));
    await act(async () => { activation.resolve({ ok: false, state: "failed", version }); });
    expect(document.body.textContent).toContain("下载服务尚未恢复，请重启应用");
    expect(document.body.textContent).not.toContain(`当前版本：${currentVersion}`);
    expect(useAppStore.getState().toasts.some((toast) => toast.kind === "success")).toBe(false);
  });

  it.each(["zh-CN", "en"] as const)("recovers the restart notice after reopening with no sidecar settings (%s)", async (locale) => {
    setLocale(locale);
    await mount();
    result = { ok: false, state: "failed", version };
    if (locale === "en") {
      fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Download and activate" })).toBeEnabled());
      fireEvent.click(screen.getByRole("button", { name: "Download and activate" }));
      await act(async () => { await Promise.resolve(); });
    } else {
      await checkAndUpdate();
    }
    cleanup();
    engineState = { recoveryRequired: true };
    request.mockImplementation(async (method) => {
      if (method === "updater.getEngineState") return engineState;
      throw new Error(privateError);
    });
    vi.mocked(window.api.getConnectionState).mockResolvedValue("failed");
    useAppStore.setState({ settings: null, connection: "failed", toasts: [] });
    await mount();
    expect(document.body.textContent).toContain(locale === "en" ? "The download service has not recovered. Restart the app." : "下载服务尚未恢复，请重启应用。");
    expect(document.body.textContent).not.toContain("fake-secret");
    expect(document.body.textContent).not.toContain(currentVersion);
    expect(screen.queryByRole("button", { name: /启用更新|Activate update/ })).not.toBeInTheDocument();
  });

  it("reads the retained recovery state when failure arrives after the new window has mounted", async () => {
    await mount();
    engineState = { recoveryRequired: true };
    await act(async () => { useAppStore.getState().setConnection("failed"); });
    expect(document.body.textContent).toContain("下载服务尚未恢复，请重启应用。");
    expect(document.body.textContent).not.toContain(`当前版本：${currentVersion}`);
  });

  it.each(["activated", "prepared", "rolled_back", "failed"] as const)("localizes %s without raw errors", async (state) => {
    setLocale("en");
    engineState = { current: { version: currentVersion }, pending: { version, sha256: "a".repeat(64) } };
    result = { ok: state === "activated", state, version, currentVersion, error: privateError };
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Activate update" }));
    await act(async () => { await Promise.resolve(); });
    const expected = state === "activated" ? `Download tool ${version} is now active` : state === "prepared" ? "Activate it after current tasks finish" : state === "rolled_back" ? `Restored version ${currentVersion}` : "Restart the app";
    expect(document.body.textContent).toContain(expected);
    expect(document.body.textContent).not.toContain("fake-secret");
  });

  it("never displays unsafe versions from local state or update responses", async () => {
    engineState = { current: { version: privateError }, pending: { version: privateError } };
    result = { ok: true, state: "activated", version: privateError };
    await mount();
    await checkAndUpdate();
    expect(document.body.textContent).not.toContain("fake-secret");
    expect(useAppStore.getState().toasts.some((toast) => toast.kind === "success")).toBe(false);
  });

  it("rejects unsafe check versions without displaying them or enabling an update", async () => {
    const original = request.getMockImplementation()!;
    request.mockImplementation((method, payload) => method === "updater.checkYtDlp"
      ? Promise.resolve({ currentVersion: privateError, latestVersion: privateError, updateAvailable: true })
      : original(method, payload));
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "检查更新" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "下载并启用" })).toBeDisabled();
    expect(document.body.textContent).not.toContain("fake-secret");
  });
});
