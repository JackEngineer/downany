import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAppStore } from "../store/appStore";
import { deferred } from "../test/deferred";
import { settingsFixture } from "../test/settingsFixture";
import { taskFixture } from "../test/taskFixture";
import { startAppSession, type AppSessionApi } from "./appSession";
import type { AppSnapshot, ConnectionState, ProtocolEvent } from "./types";

const settings = settingsFixture();
let stop: (() => void) | undefined;

function session() {
  let event: (value: ProtocolEvent) => void = () => undefined;
  let state: (value: ConnectionState) => void = () => undefined;
  const snapshot = deferred<AppSnapshot>();
  const connection = deferred<ConnectionState>();
  const logDir = deferred<string>();
  const offEvent = vi.fn();
  const offState = vi.fn();
  const api: AppSessionApi = {
    request: vi.fn(() => snapshot.promise),
    getConnectionState: () => connection.promise,
    getLogDir: () => logDir.promise,
    onEvent: (handler) => { event = handler; return offEvent; },
    onState: (handler) => { state = handler; return offState; },
  };
  stop = startAppSession(api);
  return { api, snapshot, connection, logDir, offEvent, offState, event: (value: ProtocolEvent) => event(value), state: (value: ConnectionState) => state(value) };
}

async function flush() {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

beforeEach(() => {
  useAppStore.setState({ tasks: [], settings, connection: "connecting", logDir: "" });
});
afterEach(() => { stop?.(); stop = undefined; });

describe("main-window connection session", () => {
  it("loads a snapshot and log directory without waiting for another connection event", async () => {
    const pending = session();
    const tasks = [taskFixture()];
    pending.snapshot.resolve({ tasks, settings });
    pending.connection.resolve("connected");
    pending.logDir.resolve("C:\\test-logs");
    await flush();
    expect(useAppStore.getState()).toMatchObject({ tasks, settings, connection: "connected", logDir: "C:\\test-logs" });
  });

  it("keeps completion and removal events that overtake the initial snapshot", async () => {
    const pending = session();
    const original = [taskFixture({ id: "done", status: "downloading" }), taskFixture({ id: "removed" })];
    const done = { ...original[0], status: "completed", progress: 100 };
    pending.event({ event: "task.completed", payload: { task: done } });
    pending.event({ event: "task.removed", payload: { taskId: "removed" } });
    pending.snapshot.resolve({ tasks: original, settings });
    await flush();
    expect(useAppStore.getState().tasks).toEqual([done]);
  });

  it("does not replace a newer connection event with a late startup query", async () => {
    const pending = session();
    pending.state("failed");
    pending.connection.resolve("connected");
    pending.snapshot.resolve({ tasks: [taskFixture()], settings });
    await flush();
    expect(useAppStore.getState().connection).toBe("failed");
    expect(useAppStore.getState().tasks).toEqual([]);
  });

  it("invalidates the previous connection while keeping known tasks until a fresh reply", async () => {
    const pending = session();
    const known = taskFixture({ id: "known" });
    useAppStore.setState({ tasks: [known] });
    pending.state("reconnecting");
    pending.snapshot.resolve({ tasks: [], settings });
    await flush();
    expect(useAppStore.getState().tasks).toEqual([known]);

    const next = deferred<AppSnapshot>();
    vi.mocked(pending.api.request).mockReturnValue(next.promise);
    pending.state("connected");
    const done = { ...known, status: "completed", progress: 100 };
    pending.event({ event: "task.completed", payload: { task: done } });
    next.resolve({ tasks: [known], settings });
    await flush();
    expect(useAppStore.getState().tasks).toEqual([done]);
  });

  it("treats a health payload as a refresh hint, never as a new lifecycle snapshot", async () => {
    const pending = session();
    pending.snapshot.resolve({ tasks: [], settings });
    await flush();
    const done = taskFixture({ status: "completed", progress: 100 });
    pending.event({ event: "task.completed", payload: { task: done } });
    const next = deferred<AppSnapshot>();
    vi.mocked(pending.api.request).mockReturnValue(next.promise);
    pending.event({ event: "sidecar.health", payload: { snapshot: { tasks: [taskFixture()], settings } } });
    expect(useAppStore.getState().tasks).toEqual([done]);
    pending.event({ event: "task.removed", payload: { taskId: done.id } });
    next.resolve({ tasks: [done], settings });
    await flush();
    expect(useAppStore.getState().tasks).toEqual([]);
  });

  it("ignores all callbacks and replies after cleanup, and releases both subscriptions", async () => {
    const pending = session();
    stop?.();
    pending.state("connected");
    pending.event({ event: "task.created", payload: { task: taskFixture() } });
    pending.connection.resolve("failed");
    pending.logDir.resolve("late");
    pending.snapshot.resolve({ tasks: [taskFixture()], settings });
    await flush();
    expect(useAppStore.getState()).toMatchObject({ tasks: [], connection: "connecting", logDir: "" });
    expect(pending.offState).toHaveBeenCalledTimes(1);
    expect(pending.offEvent).toHaveBeenCalledTimes(1);
  });

  it("handles rejected background lookups and can recover on the next connection", async () => {
    const pending = session();
    pending.connection.reject(new Error("offline"));
    pending.logDir.reject(new Error("offline"));
    pending.snapshot.reject(new Error("offline"));
    await flush();
    const recovered = { tasks: [taskFixture()], settings };
    vi.mocked(pending.api.request).mockResolvedValue(recovered);
    pending.state("connected");
    await flush();
    expect(useAppStore.getState().tasks).toEqual(recovered.tasks);
  });
});
