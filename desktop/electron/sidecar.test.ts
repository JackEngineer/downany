import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  pid: undefined;
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

describe("SidecarProcess handshake", () => {
  beforeEach(() => {
    spawnMock.mockReset();
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
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
