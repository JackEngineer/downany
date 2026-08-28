import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DesktopApi } from "../electron/preload";
import type { AppSettings, ProtocolEvent } from "./lib/types";
import { SettingsApp } from "./SettingsApp";
import { useAppStore } from "./store/appStore";
import { deferred } from "./test/deferred";
import { settingsFixture } from "./test/settingsFixture";

const settings = settingsFixture();
const saves: ReturnType<typeof deferred<AppSettings>>[] = [];
let event: (value: ProtocolEvent) => void = () => undefined;
const request = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  saves.length = 0;
  localStorage.clear();
  request.mockReset().mockImplementation((method: string) => {
    if (method === "settings.get") return Promise.resolve(settings);
    if (method === "settings.update") {
      const pending = deferred<AppSettings>();
      saves.push(pending);
      return pending.promise;
    }
    return Promise.resolve({ status: "skipped" });
  });
  window.api = {
    platform: "win32", request,
    getConnectionState: vi.fn().mockResolvedValue("connected"),
    onEvent: (handler: (value: ProtocolEvent) => void) => { event = handler; return () => undefined; },
    onState: () => () => undefined,
    onMigration: () => () => undefined,
    setThemeSource: vi.fn().mockResolvedValue(undefined),
  } as unknown as DesktopApi;
  useAppStore.setState({ settings, connection: "connected", toasts: [] });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

async function mount() {
  const view = render(<SettingsApp />);
  await act(async () => { await Promise.resolve(); });
  return view;
}
async function debounce() { await act(async () => { await vi.advanceTimersByTimeAsync(300); }); }
function changeDirectory(from: string, to: string) {
  fireEvent.change(screen.getByDisplayValue(from), { target: { value: to } });
}

describe("settings autosave ordering", () => {
  it("preserves newer input while an earlier save and event finish", async () => {
    await mount();
    changeDirectory(settings.download_dir, "C:\\first");
    await debounce();
    changeDirectory("C:\\first", "C:\\newer");
    const first = settingsFixture({ download_dir: "C:\\first" });
    await act(async () => {
      event({ event: "settings.changed", payload: { settings: first } });
      saves[0].resolve(first);
    });
    expect(screen.getByDisplayValue("C:\\newer")).toBeInTheDocument();
    expect(screen.queryByText("已保存")).not.toBeInTheDocument();
    await debounce();
    const latest = settingsFixture({ download_dir: "C:\\newer" });
    await act(async () => { saves[1].resolve(latest); });
    expect(screen.getByDisplayValue("C:\\newer")).toBeInTheDocument();
    expect(screen.getByText("已保存")).toBeInTheDocument();
    expect(useAppStore.getState().settings).toEqual(latest);
  });

  it("keeps the latest acknowledged save when responses arrive in reverse order", async () => {
    await mount();
    changeDirectory(settings.download_dir, "C:\\first");
    await debounce();
    changeDirectory("C:\\first", "C:\\latest");
    await debounce();
    const latest = settingsFixture({ download_dir: "C:\\latest" });
    await act(async () => { saves[1].resolve(latest); });
    await act(async () => { saves[0].resolve(settingsFixture({ download_dir: "C:\\first" })); });
    expect(screen.getByDisplayValue("C:\\latest")).toBeInTheDocument();
    expect(useAppStore.getState().settings).toEqual(latest);
  });

  it("shows a safe error and retains unsaved input when saving fails", async () => {
    await mount();
    changeDirectory(settings.download_dir, "C:\\unsaved");
    await debounce();
    await act(async () => { saves[0].reject(new Error("Cookie: fake-secret https://example.com/private C:\\private\\data")); });
    expect(screen.getByDisplayValue("C:\\unsaved")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("fake-secret");
    act(() => event({ event: "settings.changed", payload: { settings: settingsFixture({ concurrent_downloads: 5 }) } }));
    expect(screen.getByDisplayValue("C:\\unsaved")).toBeInTheDocument();
  });

  it("cancels an unsent debounce timer when the settings view unmounts", async () => {
    const view = await mount();
    changeDirectory(settings.download_dir, "C:\\unsent");
    view.unmount();
    await debounce();
    expect(request.mock.calls.filter(([method]) => method === "settings.update")).toEqual([]);
  });

  it("does not apply a save response after the settings view unmounts", async () => {
    const view = await mount();
    changeDirectory(settings.download_dir, "C:\\late");
    await debounce();
    view.unmount();
    await act(async () => { saves[0].resolve(settingsFixture({ download_dir: "C:\\late" })); });
    expect(useAppStore.getState().settings).toEqual(settings);
  });
});
