import { spawn } from "node:child_process";
import type { Duplex } from "node:stream";
import { killProcessTree } from "../processTree";
import type {
  ContainedProcessCandidate,
  ProcessTreeHandle,
  ProcessTreeOperationResult,
  ProcessTreeSnapshot,
  TelegramOwnedProcessInfo,
  TelegramSpawnedProcess,
} from "./supervisor";

interface ProcessHostHandshake {
  schemaVersion: 2;
  instanceId: string;
  guardianPid: number;
  guardianStartedAt: string;
  targetPid: number;
  targetStartedAt: string;
  containment: "windows_job_object" | "darwin_process_group";
  processGroupId: number | null;
}

export interface TelegramProcessHostAdapterOptions {
  platform?: NodeJS.Platform;
  nowIso?: () => string;
  handshakeTimeoutMs?: number;
  log?: (level: "info" | "warn" | "error", message: string) => void;
}

function commandLine(args: readonly string[]): string {
  return args
    .map((arg) => /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg)
    .join(" ");
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseHandshake(value: unknown): ProcessHostHandshake {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("ProcessHost handshake 不是对象");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 2 || typeof record.instanceId !== "string") {
    throw new Error("ProcessHost handshake 版本或 instanceId 无效");
  }
  const positivePid = (field: string): number => {
    const pid = record[field];
    if (!Number.isInteger(pid) || (pid as number) <= 1) throw new Error(`ProcessHost handshake ${field} 无效`);
    return pid as number;
  };
  const guardianPid = positivePid("guardianPid");
  const targetPid = positivePid("targetPid");
  const guardianStartedAt = record.guardianStartedAt;
  const targetStartedAt = record.targetStartedAt;
  if (typeof guardianStartedAt !== "string" || typeof targetStartedAt !== "string") {
    throw new Error("ProcessHost handshake 时间戳无效");
  }
  if (record.containment !== "windows_job_object" && record.containment !== "darwin_process_group") {
    throw new Error("ProcessHost handshake containment 无效");
  }
  const processGroupId = record.processGroupId;
  if (processGroupId !== null && (!Number.isInteger(processGroupId) || (processGroupId as number) <= 1)) {
    throw new Error("ProcessHost handshake processGroupId 无效");
  }
  return {
    schemaVersion: 2,
    instanceId: record.instanceId,
    guardianPid,
    guardianStartedAt,
    targetPid,
    targetStartedAt,
    containment: record.containment,
    processGroupId: processGroupId as number | null,
  };
}

async function readHandshake(stream: NodeJS.ReadableStream, timeoutMs: number): Promise<ProcessHostHandshake> {
  const deadline = Date.now() + timeoutMs;
  let buffer = "";
  stream.setEncoding?.("utf8");
  return new Promise<ProcessHostHandshake>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.off?.("data", onData);
      stream.off?.("error", onError);
      stream.off?.("end", onEnd);
      fn();
    };
    const onData = (chunk: string | Buffer): void => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        if (buffer.length > 64 * 1024) finish(() => reject(new Error("ProcessHost handshake 超长")));
        return;
      }
      const line = buffer.slice(0, newline).trim();
      if (!line) return;
      try {
        finish(() => resolve(parseHandshake(JSON.parse(line))));
      } catch (error) {
        finish(() => reject(error instanceof Error ? error : new Error(String(error))));
      }
    };
    const onError = (error: Error): void => finish(() => reject(error));
    const onEnd = (): void => finish(() => reject(new Error("ProcessHost 控制通道提前关闭")));
    const remaining = Math.max(1, deadline - Date.now());
    const timer = setTimeout(() => finish(() => reject(new Error("等待 ProcessHost handshake 超时"))), remaining);
    stream.on("data", onData);
    stream.once("error", onError);
    stream.once("end", onEnd);
  });
}

function snapshotFromHandshake(
  handshake: ProcessHostHandshake,
  hostExecutable: string,
  targetArgs: readonly string[],
  platform: NodeJS.Platform,
  generationId: string,
): { candidate: ContainedProcessCandidate; snapshot: ProcessTreeSnapshot } {
  const root: TelegramOwnedProcessInfo = {
    pid: handshake.targetPid,
    parentPid: handshake.guardianPid,
    executablePath: targetArgs[0],
    startedAt: handshake.targetStartedAt,
    commandLine: commandLine(targetArgs),
  };
  const guardian: TelegramOwnedProcessInfo = {
    pid: handshake.guardianPid,
    parentPid: null,
    executablePath: hostExecutable,
    startedAt: handshake.guardianStartedAt,
    commandLine: commandLine([hostExecutable, "--instance-id", handshake.instanceId, "--", ...targetArgs]),
  };
  const containment = platform === "win32" ? "windows_job_object" : "darwin_process_group";
  if (handshake.containment !== containment) throw new Error("ProcessHost 平台 containment 不匹配");
  const candidate: ContainedProcessCandidate = {
    instanceId: handshake.instanceId,
    guardian,
    root,
    containment,
    processGroupId: handshake.processGroupId,
  };
  const snapshot: ProcessTreeSnapshot = {
    schemaVersion: 2,
    root,
    guardian,
    platform,
    containment,
    processGroupId: handshake.processGroupId,
    members: [
      { pid: guardian.pid, startedAt: guardian.startedAt },
      { pid: root.pid, startedAt: root.startedAt },
    ],
    generationId,
  };
  return { candidate, snapshot };
}

function killSnapshot(snapshot: ProcessTreeSnapshot): void {
  if (snapshot.platform !== "win32" && snapshot.processGroupId && snapshot.processGroupId > 1) {
    try {
      process.kill(-snapshot.processGroupId, "SIGTERM");
    } catch {
      // The group may already have exited; the guardian fallback below still runs.
    }
  }
  killProcessTree(snapshot.guardian.pid, snapshot.platform);
}

async function waitForSnapshotExit(snapshot: ProcessTreeSnapshot, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (!isPidAlive(snapshot.guardian.pid) && !isPidAlive(snapshot.root.pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isPidAlive(snapshot.guardian.pid) && !isPidAlive(snapshot.root.pid);
}

function handleForSnapshot(snapshot: ProcessTreeSnapshot): ProcessTreeHandle {
  return {
    platform: snapshot.platform,
    generationId: snapshot.generationId,
    snapshot: () => snapshot,
  };
}

/**
 * Production bridge for the checked-in DownanyProcessHost binary.
 *
 * The adapter deliberately refuses to guess an orphaned `launching` tree:
 * without a platform-specific enumerator and an owner proof, silently
 * clearing that state would risk leaving a credential-bearing process alive.
 * A verified snapshot can still be recovered because the ProcessHost PID and
 * (on macOS) process group are persisted in the owner state.
 */
export function createTelegramProcessHostAdapter(options: TelegramProcessHostAdapterOptions = {}) {
  const platform = options.platform || process.platform;
  const nowIso = options.nowIso || (() => new Date().toISOString());
  const handshakeTimeoutMs = options.handshakeTimeoutMs || 30_000;
  const log = options.log || (() => undefined);

  async function spawnContainedProcess(
    executable: string,
    args: readonly string[],
    spawnOptions: { cwd: string; env: NodeJS.ProcessEnv; shell: false; detached: boolean; windowsHide: true },
  ): Promise<TelegramSpawnedProcess> {
    const child = spawn(executable, args, {
      cwd: spawnOptions.cwd,
      env: spawnOptions.env,
      shell: false,
      detached: spawnOptions.detached,
      windowsHide: spawnOptions.windowsHide,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
    const control = child.stdio[3] as Duplex | null;
    if (!control || typeof control.write !== "function") {
      child.kill();
      throw new Error("ProcessHost 缺少 fd3 控制通道");
    }
    let handshake: ProcessHostHandshake;
    try {
      handshake = await readHandshake(control as NodeJS.ReadableStream, handshakeTimeoutMs);
    } catch (error) {
      child.kill();
      throw error;
    }
    const targetArgs = args.slice(args.indexOf("--") + 1);
    if (args.indexOf("--") < 0 || targetArgs.length === 0) {
      child.kill();
      throw new Error("ProcessHost 启动参数缺少 -- 或目标");
    }
    const generationId = handshake.instanceId;
    const identity = snapshotFromHandshake(handshake, executable, targetArgs, platform, generationId);
    if (child.pid !== identity.candidate.guardian.pid) {
      child.kill();
      throw new Error("ProcessHost handshake guardianPid 与宿主不一致");
    }
    // The Bot API is long-lived and stdout/stderr are not protocol channels;
    // drain both pipes so a verbose native build cannot deadlock on a full pipe.
    child.stdout?.resume();
    child.stderr?.resume();
    return {
      candidate: identity.candidate,
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      resume: async () => {
        const line = '{"command":"resume"}\n';
        await new Promise<void>((resolve, reject) => {
          control.once("error", reject);
          control.write(line, (error?: Error | null) => error ? reject(error) : resolve());
        });
      },
      once: (event: "exit" | "error", listener: (...args: any[]) => void) => {
        child.once(event, listener);
      },
    };
  }

  async function findOwnedProcessCandidates(): Promise<readonly ContainedProcessCandidate[]> {
    throw new Error("无法在没有持久 owner snapshot 的情况下枚举孤儿 ProcessHost");
  }

  async function captureContainedProcessTree(candidate: ContainedProcessCandidate, generationId: string): Promise<ProcessTreeHandle | null> {
    if (candidate.instanceId !== generationId) return null;
    return handleForSnapshot({
      schemaVersion: 2,
      root: candidate.root,
      guardian: candidate.guardian,
      platform,
      containment: candidate.containment,
      processGroupId: candidate.processGroupId,
      members: [
        { pid: candidate.guardian.pid, startedAt: candidate.guardian.startedAt },
        { pid: candidate.root.pid, startedAt: candidate.root.startedAt },
      ],
      generationId,
    });
  }

  async function refreshProcessTree(handle: ProcessTreeHandle, persist: (snapshot: ProcessTreeSnapshot) => Promise<void>): Promise<ProcessTreeSnapshot> {
    const snapshot = handle.snapshot();
    await persist(snapshot);
    return snapshot;
  }

  async function terminateAndWaitProcessTree(
    handle: ProcessTreeHandle,
    limits: { gracefulTimeoutMs: number; forceTimeoutMs: number },
    persist: (snapshot: ProcessTreeSnapshot) => Promise<void>,
  ): Promise<ProcessTreeOperationResult> {
    const snapshot = handle.snapshot();
    killSnapshot(snapshot);
    let exited = await waitForSnapshotExit(snapshot, limits.gracefulTimeoutMs);
    if (!exited) {
      killSnapshot(snapshot);
      exited = await waitForSnapshotExit(snapshot, limits.forceTimeoutMs);
    }
    if (exited) {
      await persist({ ...snapshot, members: [] });
    } else {
      log("warn", `ProcessHost 进程树未在期限内退出: ${snapshot.generationId}`);
      await persist(snapshot);
    }
    return { exited, snapshot: exited ? { ...snapshot, members: [] } : snapshot };
  }

  return {
    spawnContainedProcess,
    allocatePort: async (host: "127.0.0.1"): Promise<number> => {
      const net = await import("node:net");
      return await new Promise<number>((resolve, reject) => {
        const server = net.createServer();
        server.once("error", reject);
        server.listen(0, host, () => {
          const address = server.address();
          const port = typeof address === "object" && address ? address.port : 0;
          server.close((error) => error ? reject(error) : resolve(port));
        });
      });
    },
    probeTcp: async (host: "127.0.0.1", port: number, signal: AbortSignal): Promise<boolean> => {
      const net = await import("node:net");
      return await new Promise<boolean>((resolve) => {
        const socket = net.createConnection({ host, port });
        const finish = (value: boolean): void => {
          socket.destroy();
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        };
        const onAbort = (): void => finish(false);
        signal.addEventListener("abort", onAbort, { once: true });
        socket.once("connect", () => finish(true));
        socket.once("error", () => finish(false));
      });
    },
    inspectProcess: async (pid: number): Promise<TelegramOwnedProcessInfo | null> => {
      if (!isPidAlive(pid)) return null;
      return {
        pid,
        parentPid: null,
        executablePath: "",
        startedAt: nowIso(),
        commandLine: "",
      };
    },
    findOwnedProcessCandidates,
    captureContainedProcessTree,
    restoreProcessTree: handleForSnapshot,
    refreshProcessTree,
    terminateAndWaitProcessTree,
  };
}
