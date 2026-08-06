import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

import {
  ConnectionState,
  PROTOCOL_VERSION,
  ProtocolErrorBody,
  ProtocolEvent,
} from "./protocol";
import { resolveSidecarLaunch } from "./paths";
import { killProcessTree } from "./processTree";

interface PendingRequest {
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface SidecarOptions {
  repoRoot: string;
  pythonPath?: string;
  dataDir?: string;
  requestTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatFailLimit?: number;
  maxRestarts?: number;
}

export class SidecarProcess extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private pending = new Map<string, PendingRequest>();
  private state: ConnectionState = "disconnected";
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private missedHeartbeats = 0;
  private restarts = 0;
  private stopping = false;
  private readonly opts: Required<
    Pick<
      SidecarOptions,
      | "repoRoot"
      | "requestTimeoutMs"
      | "heartbeatIntervalMs"
      | "heartbeatFailLimit"
      | "maxRestarts"
    >
  > &
    SidecarOptions;

  constructor(opts: SidecarOptions) {
    super();
    this.opts = {
      requestTimeoutMs: 15000,
      heartbeatIntervalMs: 5000,
      heartbeatFailLimit: 3,
      maxRestarts: 3,
      ...opts,
    };
  }

  getConnectionState(): ConnectionState {
    return this.state;
  }

  async start(): Promise<void> {
    this.stopping = false;
    this.setState("connecting");
    await this.spawnAndHandshake();
    this.startHeartbeat();
    this.setState("connected");
    this.restarts = 0;
  }

  async request(method: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.proc?.stdin) {
      throw new Error("Sidecar 未连接");
    }
    const id = randomUUID();
    const message = {
      protocolVersion: PROTOCOL_VERSION,
      type: "request",
      id,
      method,
      payload,
      timestamp: new Date().toISOString(),
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`请求超时: ${method}`));
      }, this.opts.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc!.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.stopHeartbeat();
    try {
      if (this.proc) {
        await this.request("app.shutdown", {});
      }
    } catch {
      // ignore
    }
    this.killProcess();
    this.failPending(new Error("Sidecar 已停止"));
    this.setState("disconnected");
  }

  private async spawnAndHandshake(): Promise<void> {
    const launch = resolveSidecarLaunch(__dirname, {
      pythonPath: this.opts.pythonPath,
      dataDir: this.opts.dataDir,
      repoRoot: this.opts.repoRoot,
    });
    this.proc = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env: {
        ...launch.env,
        PYTHONUNBUFFERED: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
      // 独立进程组，便于一次杀掉 PyInstaller 父子进程，避免孤儿占库
      detached: process.platform !== "win32",
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    this.proc.stderr.on("data", (chunk: string) => {
      this.emit("log", chunk);
    });
    this.proc.on("exit", (code) => {
      this.proc = null;
      this.failPending(new Error(`Sidecar 退出 code=${code}`));
      if (!this.stopping) {
        void this.handleCrash();
      }
    });

    try {
      const hello = await this.waitForHello();
      if (hello.protocolVersion !== PROTOCOL_VERSION) {
        throw new Error(`协议版本不兼容: ${hello.protocolVersion}`);
      }
      this.write({
        protocolVersion: PROTOCOL_VERSION,
        type: "hello",
        payload: { app: "electron", appVersion: "0.1.0-phase4" },
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      // handshake 失败时杀掉孤儿进程，避免占着资源却无法通信
      this.killProcess();
      throw err;
    }
  }

  private waitForHello(): Promise<{ protocolVersion: number }> {
    return new Promise((resolve, reject) => {
      // onedir 通常 <2s；保留余量覆盖慢盘 / 首次签名校验
      const timer = setTimeout(() => reject(new Error("等待 Sidecar hello 超时")), 90000);
      const onHello = (msg: Record<string, unknown>) => {
        clearTimeout(timer);
        this.off("raw-hello", onHello);
        resolve(msg as { protocolVersion: number });
      };
      this.on("raw-hello", onHello);
    });
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.emit("log", `非 JSON 协议行: ${line}\n`);
        continue;
      }
      this.handleMessage(msg);
    }
  }

  private handleMessage(msg: Record<string, unknown>): void {
    const type = msg.type;
    if (type === "hello") {
      this.emit("raw-hello", msg);
      return;
    }
    if (type === "event") {
      const event: ProtocolEvent = {
        event: String(msg.event || ""),
        payload: (msg.payload as Record<string, unknown>) || {},
      };
      this.emit("event", event);
      return;
    }
    if (type === "response") {
      const id = String(msg.correlationId || "");
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if (msg.error) {
        const err = msg.error as ProtocolErrorBody;
        pending.reject(new Error(`${err.code}: ${err.message}`));
      } else {
        pending.resolve(msg.payload);
      }
    }
  }

  private write(msg: Record<string, unknown>): void {
    this.proc?.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.missedHeartbeats = 0;
    this.heartbeatTimer = setInterval(() => {
      void this.pingOnce();
    }, this.opts.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async pingOnce(): Promise<void> {
    try {
      await this.request("app.ping", {});
      this.missedHeartbeats = 0;
    } catch {
      this.missedHeartbeats += 1;
      if (this.missedHeartbeats >= this.opts.heartbeatFailLimit) {
        this.emit("log", "心跳连续失败，判定 Sidecar 失联\n");
        this.killProcess();
      }
    }
  }

  private async handleCrash(): Promise<void> {
    this.stopHeartbeat();
    if (this.restarts >= this.opts.maxRestarts) {
      this.setState("failed");
      return;
    }
    this.restarts += 1;
    this.setState("reconnecting");
    const delay = Math.min(1000 * 2 ** (this.restarts - 1), 8000);
    await new Promise((r) => setTimeout(r, delay));
    if (this.stopping) return;
    try {
      await this.spawnAndHandshake();
      this.startHeartbeat();
      this.setState("connected");
      this.emit("reconnected");
    } catch (err) {
      this.emit("log", `重连失败: ${String(err)}\n`);
      await this.handleCrash();
    }
  }

  private killProcess(): void {
    if (!this.proc) return;
    const child = this.proc;
    this.proc = null;
    const pid = child.pid;
    if (pid) {
      killProcessTree(pid);
      return;
    }
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
  }

  private failPending(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    this.emit("state", state);
  }
}

export { resolveRepoRoot } from "./paths";
