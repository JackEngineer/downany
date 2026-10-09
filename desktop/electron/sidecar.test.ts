import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
  default: { spawn: spawnMock },
}));

vi.mock("./paths", () => ({
  resolveRepoRoot: vi.fn(() => "D:/repo"),
  resolveSidecarLaunch: vi.fn(() => ({
    command: "fake-sidecar",
    args: [],
    cwd: "D:/repo",
    env: {},
  })),
}));

vi.mock("./processTree", () => ({
  killProcessTree: vi.fn(),
}));

import { SidecarProcess } from "./sidecar";
import { killProcessTree } from "./processTree";

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  pid: number | undefined;
  kill: ReturnType<typeof vi.fn>;
}

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = undefined;
  child.kill = vi.fn(() => true);
  return child;
}

function writeProtocolLine(stream: PassThrough, message: Record<string, unknown>): void {
  stream.write(`${JSON.stringify(message)}\n`);
}

function createProtocolChild(exitOnShutdown = true) {
  const child = createFakeChild();
  const messages: Array<Record<string, unknown>> = [];
  const requests: Array<Record<string, unknown>> = [];
  let input = "";
  const respond = (request: Record<string, unknown>, payload: unknown) => {
    writeProtocolLine(child.stdout, { type: "response", correlationId: request.id, payload });
  };
  child.stdin.on("data", (chunk: Buffer) => {
    input += chunk.toString("utf8");
    let newline: number;
    while ((newline = input.indexOf("\n")) >= 0) {
      const message = JSON.parse(input.slice(0, newline)) as Record<string, unknown>;
      input = input.slice(newline + 1);
      messages.push(message);
      if (message.type !== "request") continue;
      requests.push(message);
      if (message.method === "app.shutdown") {
        respond(message, { ok: true });
        if (exitOnShutdown) queueMicrotask(() => child.emit("exit", 0));
      }
    }
  });
  return { child, messages, requests, respond };
}

function sendHello(child: FakeChild) {
  writeProtocolLine(child.stdout, { type: "hello", protocolVersion: 1, payload: {} });
}

async function flushPromises() {
  for (let count = 0; count < 8; count += 1) await Promise.resolve();
}

describe("SidecarProcess handshake", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    vi.mocked(killProcessTree).mockReset();
  });

  it("rejects status polling until the Electron hello has been written", async () => {
    const peer = createProtocolChild();
    spawnMock.mockReturnValue(peer.child);
    const sidecar = new SidecarProcess({
      repoRoot: "D:/repo", appVersion: "test", requestTimeoutMs: 25,
    });
    const started = sidecar.start();
    const beforeHello = sidecar.request("updater.getEngineState").catch((error: Error) => error);
    let duringHello: Promise<unknown> | undefined;
    sidecar.once("raw-hello", () => {
      duringHello = sidecar.request("updater.getEngineState").catch((error: Error) => error);
    });
    sendHello(peer.child);
    await started;
    const [beforeResult, duringResult] = await Promise.all([beforeHello, duringHello]);
    const handshakeMessages = peer.messages.slice();
    await sidecar.stop();
    expect(handshakeMessages.map((message) => message.type)).toEqual(["hello"]);
    expect(beforeResult).toEqual(new Error("Sidecar 未连接"));
    expect(duringResult).toEqual(new Error("Sidecar 未连接"));
  });

  it("stops an unhandshaken child without sending shutdown as its first protocol line", async () => {
    const peer = createProtocolChild();
    peer.child.pid = 101;
    vi.mocked(killProcessTree).mockImplementation(() => {
      queueMicrotask(() => peer.child.emit("exit", 0));
    });
    spawnMock.mockReturnValue(peer.child);
    const sidecar = new SidecarProcess({ repoRoot: "D:/repo", appVersion: "test" });
    const started = sidecar.start().catch((error: Error) => error);
    await sidecar.stop();
    expect(await started).toBeInstanceOf(Error);
    expect(peer.messages).toEqual([]);
    expect(sidecar.getConnectionState()).toBe("disconnected");
  });

  it("reports the running Electron app version to the Sidecar", async () => {
    const child = createFakeChild();
    spawnMock.mockReturnValue(child);

    const messages: Array<Record<string, unknown>> = [];
    let stdinBuffer = "";
    child.stdin.on("data", (chunk: Buffer) => {
      stdinBuffer += chunk.toString("utf8");
      let newlineIndex: number;
      while ((newlineIndex = stdinBuffer.indexOf("\n")) >= 0) {
        const line = stdinBuffer.slice(0, newlineIndex).trim();
        stdinBuffer = stdinBuffer.slice(newlineIndex + 1);
        if (!line) continue;
        const message = JSON.parse(line) as Record<string, unknown>;
        messages.push(message);
        if (message.type === "request" && message.method === "app.shutdown") {
          writeProtocolLine(child.stdout, {
            protocolVersion: 1,
            type: "response",
            correlationId: message.id,
            payload: { ok: true },
            timestamp: new Date().toISOString(),
          });
          queueMicrotask(() => child.emit("exit", 0));
        }
      }
    });

    const sidecar = new SidecarProcess({
      repoRoot: "D:/repo",
      appVersion: "9.8.7",
      heartbeatIntervalMs: 60_000,
    });
    const startPromise = sidecar.start();

    writeProtocolLine(child.stdout, {
      protocolVersion: 1,
      type: "hello",
      payload: { app: "Downany", appVersion: "0.2.5" },
      timestamp: new Date().toISOString(),
    });
    await startPromise;

    const hello = messages.find((message) => message.type === "hello");
    expect(hello).toEqual(
      expect.objectContaining({
        payload: { app: "electron", appVersion: "9.8.7" },
      }),
    );

    await sidecar.stop();
    expect(child.kill).not.toHaveBeenCalled();
  });
});

describe("SidecarProcess controlled lifecycle", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    vi.mocked(killProcessTree).mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("keeps polling out of both replacement and rollback handshakes", async () => {
    const peers = [createProtocolChild(), createProtocolChild(), createProtocolChild()];
    peers.forEach((peer) => spawnMock.mockReturnValueOnce(peer.child));
    const sidecar = new SidecarProcess({
      repoRoot: "D:/repo", appVersion: "test", requestTimeoutMs: 25,
    });
    const started = sidecar.start();
    sendHello(peers[0].child);
    await started;
    const earlyResults: unknown[] = [];
    const firstLines: unknown[] = [];
    try {
      for (const peer of peers.slice(1)) {
        const restarting = sidecar.restart();
        await flushPromises();
        const poll = sidecar.request("updater.getEngineState").catch((error: Error) => error);
        sendHello(peer.child);
        await restarting;
        earlyResults.push(await poll);
        firstLines.push(peer.messages[0]?.type);
        const readyPoll = sidecar.request("updater.getEngineState");
        peer.respond(peer.requests.at(-1)!, { current: { version: "verified" } });
        await expect(readyPoll).resolves.toEqual({ current: { version: "verified" } });
      }
    } finally {
      await sidecar.stop();
    }
    expect(firstLines).toEqual(["hello", "hello"]);
    expect(earlyResults).toEqual([new Error("Sidecar 未连接"), new Error("Sidecar 未连接")]);
    expect(peers.map((peer) => peer.requests.at(-1)?.method)).toEqual([
      "app.shutdown", "app.shutdown", "app.shutdown",
    ]);
  });

  it("absorbs stdin failure, rejects pending work, and recovers without late old errors affecting the replacement", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const old = createProtocolChild();
    const next = createProtocolChild();
    old.child.kill.mockImplementation(() => {
      queueMicrotask(() => old.child.emit("exit", 1));
      return true;
    });
    spawnMock.mockReturnValueOnce(old.child).mockImplementationOnce(() => {
      queueMicrotask(() => sendHello(next.child));
      return next.child;
    });
    const sidecar = new SidecarProcess({ repoRoot: "D:/repo", appVersion: "test" });
    const started = sidecar.start();
    sendHello(old.child);
    await started;
    const pending = sidecar.request("app.ping").catch((error: Error) => error);
    try {
      expect(() => old.child.stdin.emit("error", new Error("write EPIPE"))).not.toThrow();
      expect(await pending).toBeInstanceOf(Error);
      await vi.advanceTimersByTimeAsync(1000);
      expect(sidecar.getConnectionState()).toBe("connected");
      const reply = sidecar.request("app.getSnapshot");
      let settled = false;
      void reply.then(() => { settled = true; }, () => { settled = true; });
      expect(() => old.child.stdin.emit("error", new Error("late EPIPE"))).not.toThrow();
      await flushPromises();
      expect(settled).toBe(false);
      expect(sidecar.getConnectionState()).toBe("connected");
      next.respond(next.requests.at(-1)!, { owner: "replacement" });
      await expect(reply).resolves.toEqual({ owner: "replacement" });
    } finally {
      await sidecar.stop();
    }
  });

  it("absorbs a shutdown stdin error and exits without reconnecting", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const child = createFakeChild();
    child.stdin.resume();
    child.kill.mockImplementation(() => {
      queueMicrotask(() => child.emit("exit", 1));
      return true;
    });
    spawnMock.mockReturnValue(child);
    const sidecar = new SidecarProcess({ repoRoot: "D:/repo", appVersion: "test" });
    const reconnected = vi.fn();
    sidecar.on("reconnected", reconnected);
    const started = sidecar.start();
    sendHello(child);
    await started;
    const pending = sidecar.request("app.ping").catch((error: Error) => error);
    const stopped = sidecar.stop();
    try {
      expect(() => child.stdin.emit("error", new Error("write EPIPE"))).not.toThrow();
      expect(await pending).toBeInstanceOf(Error);
      await stopped;
      await vi.advanceTimersByTimeAsync(1000);
      expect(sidecar.getConnectionState()).toBe("disconnected");
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(reconnected).not.toHaveBeenCalled();
    } finally {
      child.emit("exit", 1);
      await stopped;
    }
  });

  it("cleans the retired process group before replacement and ignores its delayed close", async () => {
    const old = createProtocolChild();
    const next = createProtocolChild();
    old.child.pid = 101;
    next.child.pid = 202;
    const liveWorkers = new Set([101, 202]);
    vi.mocked(killProcessTree).mockImplementation((pid) => { liveWorkers.delete(pid); });
    let oldWorkerAliveAtSpawn = true;
    spawnMock.mockReturnValueOnce(old.child).mockImplementationOnce(() => {
      oldWorkerAliveAtSpawn = liveWorkers.has(101);
      queueMicrotask(() => sendHello(next.child));
      return next.child;
    });
    const sidecar = new SidecarProcess({ repoRoot: "D:/repo", appVersion: "test" });
    const started = sidecar.start();
    sendHello(old.child);
    await started;
    await sidecar.restart();
    try {
      expect(oldWorkerAliveAtSpawn).toBe(false);
      expect(liveWorkers.has(101)).toBe(false);
      old.child.emit("close", 0);
      await flushPromises();
      expect(liveWorkers.has(202)).toBe(true);
      expect(sidecar.getConnectionState()).toBe("connected");
      const reply = sidecar.request("app.ping");
      next.respond(next.requests.at(-1)!, { owner: "replacement" });
      await expect(reply).resolves.toEqual({ owner: "replacement" });
    } finally {
      await sidecar.stop();
    }
    expect(liveWorkers.size).toBe(0);
  });

  it("waits for the old child to exit before stop resolves", async () => {
    const old = createProtocolChild(false);
    spawnMock.mockReturnValue(old.child);
    const sidecar = new SidecarProcess({ repoRoot: "D:/repo", appVersion: "test" });
    const started = sidecar.start();
    sendHello(old.child);
    await started;
    let stopped = false;
    const stopping = sidecar.stop().then(() => { stopped = true; });
    await flushPromises();
    const resolvedBeforeExit = stopped;
    const killedBeforeExit = old.child.kill.mock.calls.length;
    old.child.emit("exit", 0);
    await stopping;
    expect(resolvedBeforeExit).toBe(false);
    expect(killedBeforeExit).toBe(0);
    expect(sidecar.getConnectionState()).toBe("disconnected");
  });

  it("keeps the replacement child connected after a delayed old exit and routes requests to it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const old = createProtocolChild(false);
    const next = createProtocolChild();
    spawnMock.mockImplementationOnce(() => old.child).mockImplementationOnce(() => {
      queueMicrotask(() => sendHello(next.child));
      return next.child;
    });
    const sidecar = new SidecarProcess({ repoRoot: "D:/repo", appVersion: "test" });
    const started = sidecar.start();
    sendHello(old.child);
    await started;
    const replacing = sidecar.stop().then(() => sidecar.start());
    await flushPromises();
    old.child.emit("exit", 0);
    await replacing;
    try {
      expect(sidecar.getConnectionState()).toBe("connected");
      const reply = sidecar.request("app.getSnapshot");
      expect(next.requests.at(-1)?.method).toBe("app.getSnapshot");
      next.respond(next.requests.at(-1)!, { owner: "replacement" });
      await expect(reply).resolves.toEqual({ owner: "replacement" });
      expect(old.requests.map((request) => request.method)).toEqual(["app.shutdown"]);
    } finally {
      await sidecar.stop();
    }
  });

  it("restarts once, clears old pending requests and partial output, and ignores retired child messages", async () => {
    expect(typeof SidecarProcess.prototype.restart).toBe("function");
    const old = createProtocolChild(false);
    const next = createProtocolChild();
    spawnMock.mockImplementationOnce(() => old.child).mockImplementationOnce(() => {
      queueMicrotask(() => sendHello(next.child));
      return next.child;
    });
    const sidecar = new SidecarProcess({ repoRoot: "D:/repo", appVersion: "test" });
    const reconnected = vi.fn();
    const event = vi.fn();
    sidecar.on("reconnected", reconnected);
    sidecar.on("event", event);
    const started = sidecar.start();
    sendHello(old.child);
    await started;
    const abandoned = sidecar.request("old.request").catch((error: Error) => error);
    const restarting = sidecar.restart();
    const sameRestart = sidecar.restart();
    expect(sidecar.getConnectionState()).toBe("reconnecting");
    old.child.stdout.write('{"type":"unfinished');
    await flushPromises();
    expect(next.requests).toEqual([]);
    expect(reconnected).not.toHaveBeenCalled();
    old.child.emit("exit", 0);
    await Promise.all([restarting, sameRestart]);
    expect(await abandoned).toBeInstanceOf(Error);
    const reply = sidecar.request("new.request");
    const request = next.requests.at(-1)!;
    let replied = false;
    void reply.then(() => { replied = true; });
    old.respond(request, { owner: "old" });
    writeProtocolLine(old.child.stdout, { type: "event", event: "stale.event", payload: {} });
    old.child.emit("close", 0);
    await flushPromises();
    expect(replied).toBe(false);
    expect(event).not.toHaveBeenCalled();
    expect(sidecar.getConnectionState()).toBe("connected");
    next.respond(request, { owner: "replacement" });
    await expect(reply).resolves.toEqual({ owner: "replacement" });
    expect(reconnected).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    await sidecar.stop();
  });

  it("does not resurrect an old crash backoff after a manual stop and fresh start", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const old = createProtocolChild();
    const next = createProtocolChild();
    spawnMock.mockReturnValueOnce(old.child).mockReturnValueOnce(next.child);
    const sidecar = new SidecarProcess({ repoRoot: "D:/repo", appVersion: "test" });
    const started = sidecar.start();
    sendHello(old.child);
    await started;
    old.child.emit("exit", 1);
    expect(sidecar.getConnectionState()).toBe("reconnecting");
    await sidecar.stop();
    const fresh = sidecar.start();
    sendHello(next.child);
    await fresh;
    await vi.advanceTimersByTimeAsync(1000);
    const connected = sidecar.getConnectionState();
    const spawns = spawnMock.mock.calls.length;
    await sidecar.stop();
    expect(connected).toBe("connected");
    expect(spawns).toBe(2);
  });

  it("still recovers from an unexpected crash and serves the next process", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const old = createProtocolChild();
    const next = createProtocolChild();
    spawnMock.mockImplementationOnce(() => old.child).mockImplementationOnce(() => {
      queueMicrotask(() => sendHello(next.child));
      return next.child;
    });
    const sidecar = new SidecarProcess({ repoRoot: "D:/repo", appVersion: "test" });
    const reconnected = vi.fn();
    sidecar.on("reconnected", reconnected);
    const started = sidecar.start();
    sendHello(old.child);
    await started;
    const abandoned = sidecar.request("unfinished.request").catch((error: Error) => error);
    old.child.emit("exit", 2);
    expect(sidecar.getConnectionState()).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(1000);
    expect(await abandoned).toBeInstanceOf(Error);
    expect(sidecar.getConnectionState()).toBe("connected");
    const reply = sidecar.request("app.ping");
    next.respond(next.requests.at(-1)!, { ok: true });
    await expect(reply).resolves.toEqual({ ok: true });
    expect(reconnected).toHaveBeenCalledTimes(1);
    await sidecar.stop();
  });

  it("waits for confirmed exit after forcing an unresponsive shutdown", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const old = createProtocolChild(false);
    spawnMock.mockReturnValue(old.child);
    const sidecar = new SidecarProcess({ repoRoot: "D:/repo", appVersion: "test", shutdownTimeoutMs: 50 });
    const started = sidecar.start();
    sendHello(old.child);
    await started;
    let stopped = false;
    const stopping = sidecar.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(50);
    expect(old.child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(stopped).toBe(false);
    old.child.emit("exit", 0);
    await stopping;
    expect(sidecar.getConnectionState()).toBe("disconnected");
  });

  it("does not spawn a replacement when stop cannot confirm that the old child exited", async () => {
    expect(typeof SidecarProcess.prototype.restart).toBe("function");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const old = createProtocolChild(false);
    spawnMock.mockReturnValue(old.child);
    const sidecar = new SidecarProcess({ repoRoot: "D:/repo", appVersion: "test", shutdownTimeoutMs: 50 });
    const started = sidecar.start();
    sendHello(old.child);
    await started;
    const failed = sidecar.restart().catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(100);
    expect(await failed).toBeInstanceOf(Error);
    expect(sidecar.getConnectionState()).toBe("failed");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    await expect(sidecar.start()).rejects.toThrow();
    old.child.emit("exit", 0);
    await sidecar.stop();
  });

  it("lets an explicit stop cancel a restart while the old process is exiting", async () => {
    const old = createProtocolChild(false);
    spawnMock.mockReturnValue(old.child);
    const sidecar = new SidecarProcess({ repoRoot: "D:/repo", appVersion: "test" });
    const started = sidecar.start();
    sendHello(old.child);
    await started;
    const restarting = sidecar.restart().catch((error: Error) => error);
    const stopped = sidecar.stop();
    old.child.emit("exit", 0);
    await stopped;
    expect(await restarting).toBeInstanceOf(Error);
    expect(sidecar.getConnectionState()).toBe("disconnected");
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("can start again after a spawn error closes without an exit event", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const failed = createProtocolChild();
    const next = createProtocolChild();
    spawnMock.mockReturnValueOnce(failed.child).mockReturnValueOnce(next.child);
    const sidecar = new SidecarProcess({ repoRoot: "D:/repo", appVersion: "test", shutdownTimeoutMs: 50 });
    let settled = false;
    const started = sidecar.start().catch((error: Error) => { settled = true; return error; });
    failed.child.emit("error", new Error("spawn ENOENT"));
    failed.child.emit("close", -2);
    await flushPromises();
    const settledOnClose = settled;
    await vi.advanceTimersByTimeAsync(50);
    expect(await started).toBeInstanceOf(Error);
    expect(sidecar.getConnectionState()).toBe("failed");
    expect(settledOnClose).toBe(true);
    const retry = sidecar.start();
    sendHello(next.child);
    await retry;
    expect(sidecar.getConnectionState()).toBe("connected");
    await sidecar.stop();
  });

  it("rejects a duplicate start without disabling the current process crash recovery", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const old = createProtocolChild();
    const next = createProtocolChild();
    spawnMock.mockImplementationOnce(() => old.child).mockImplementationOnce(() => {
      queueMicrotask(() => sendHello(next.child));
      return next.child;
    });
    const sidecar = new SidecarProcess({ repoRoot: "D:/repo", appVersion: "test" });
    const started = sidecar.start();
    sendHello(old.child);
    await started;
    await expect(sidecar.start()).rejects.toThrow();
    old.child.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sidecar.getConnectionState()).toBe("connected");
    expect(spawnMock).toHaveBeenCalledTimes(2);
    await sidecar.stop();
  });

  it("rejects a replacement that exits before hello without reporting a successful restart", async () => {
    const old = createProtocolChild();
    const failed = createProtocolChild();
    spawnMock.mockImplementationOnce(() => old.child).mockImplementationOnce(() => {
      queueMicrotask(() => failed.child.emit("exit", 1));
      return failed.child;
    });
    const sidecar = new SidecarProcess({ repoRoot: "D:/repo", appVersion: "test" });
    const reconnected = vi.fn();
    sidecar.on("reconnected", reconnected);
    const started = sidecar.start();
    sendHello(old.child);
    await started;
    await expect(sidecar.restart()).rejects.toThrow("握手完成前退出");
    expect(sidecar.getConnectionState()).toBe("failed");
    expect(reconnected).not.toHaveBeenCalled();
    await sidecar.stop();
  });
});
