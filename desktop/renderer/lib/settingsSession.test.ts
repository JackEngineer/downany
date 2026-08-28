import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAppStore } from "../store/appStore";
import { deferred } from "../test/deferred";
import { settingsFixture } from "../test/settingsFixture";
import { startSettingsSession, type SettingsSessionApi } from "./settingsSession";
import type { AppSettings, ConnectionState, ProtocolEvent } from "./types";

const settings = settingsFixture();
let stop: (() => void) | undefined;
function session() {
  let event: (value: ProtocolEvent) => void = () => undefined;
  let state: (value: ConnectionState) => void = () => undefined;
  const reply = deferred<AppSettings>();
  const connection = deferred<ConnectionState>();
  const offEvent = vi.fn();
  const offState = vi.fn();
  const api: SettingsSessionApi = {
    request: vi.fn(() => reply.promise),
    getConnectionState: () => connection.promise,
    onEvent: (handler) => { event = handler; return offEvent; },
    onState: (handler) => { state = handler; return offState; },
  };
  stop = startSettingsSession(api);
  return { api, reply, connection, offEvent, offState, event: (value: ProtocolEvent) => event(value), state: (value: ConnectionState) => state(value) };
}
async function flush() { for (let i = 0; i < 5; i += 1) await Promise.resolve(); }
beforeEach(() => useAppStore.setState({ settings, connection: "connecting" }));
afterEach(() => { stop?.(); stop = undefined; });

describe("settings-window session", () => {
  it("keeps a settings event newer than a pending read", async () => {
    const pending = session();
    const latest = settingsFixture({ download_dir: "C:\\new" });
    pending.event({ event: "settings.changed", payload: { settings: latest } });
    pending.reply.resolve(settings);
    await flush();
    expect(useAppStore.getState().settings).toEqual(latest);
  });

  it("does not overwrite settings already acknowledged by a save response", async () => {
    const pending = session();
    const latest = settingsFixture({ concurrent_downloads: 5 });
    useAppStore.setState({ settings: latest });
    pending.reply.resolve(settings);
    await flush();
    expect(useAppStore.getState().settings).toEqual(latest);
  });

  it("invalidates disconnected reads and ignores a late initial connection lookup", async () => {
    const pending = session();
    pending.state("failed");
    pending.reply.resolve(settingsFixture({ download_dir: "C:\\old" }));
    pending.connection.resolve("connected");
    await flush();
    expect(useAppStore.getState()).toMatchObject({ connection: "failed", settings });
    vi.mocked(pending.api.request).mockResolvedValue(settingsFixture({ concurrent_downloads: 5 }));
    pending.state("connected");
    await flush();
    expect(useAppStore.getState().settings?.concurrent_downloads).toBe(5);
  });

  it("releases subscriptions and ignores late events and replies after unmount", async () => {
    const pending = session();
    stop?.();
    pending.event({ event: "settings.changed", payload: { settings: settingsFixture({ concurrent_downloads: 9 }) } });
    pending.state("failed");
    pending.connection.resolve("connected");
    pending.reply.resolve(settingsFixture({ concurrent_downloads: 8 }));
    await flush();
    expect(useAppStore.getState()).toMatchObject({ settings, connection: "connecting" });
    expect(pending.offState).toHaveBeenCalledTimes(1);
    expect(pending.offEvent).toHaveBeenCalledTimes(1);
  });

  it("contains background rejections and accepts a later connected read", async () => {
    const pending = session();
    pending.connection.reject(new Error("offline"));
    pending.reply.reject(new Error("offline"));
    await flush();
    vi.mocked(pending.api.request).mockResolvedValue(settingsFixture({ concurrent_downloads: 6 }));
    pending.state("connected");
    await flush();
    expect(useAppStore.getState().settings?.concurrent_downloads).toBe(6);
  });
});
