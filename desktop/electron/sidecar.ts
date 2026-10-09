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
  appVersion: string;
  pythonPath?: string;
  dataDir?: string;
  requestTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatFailLimit?: number;
  maxRestarts?: number;
  shutdownTimeoutMs?: number;
}

export class SidecarProcess extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private readyProc: ChildProcessWithoutNullStreams | null = null;
  private procExit: Promise<void> | null = null;
  private buffer = "";
  private pending = new Map<string, PendingRequest>();
  private state: ConnectionState = "disconnected";
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private missedHeartbeats = 0;
  private restarts = 0;
  private stopping = false;
  private generation = 0;
  private stopPromise: Promise<void> | null = null;
  private restartPromise: Promise<void> | null = null;
  private readonly opts: Required<
    Pick<
      SidecarOptions,
      | "repoRoot"
      | "requestTimeoutMs"
      | "heartbeatIntervalMs"
      | "heartbeatFailLimit"
      | "maxRestarts"
      | "shutdownTimeoutMs"
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
      shutdownTimeoutMs: 5000,
      ...opts,
    };
  }

  getConnectionState(): ConnectionState {
    return this.state;
  }

  async start(): Promise<void> {
    if (this.proc && !this.stopPromise) throw new Error("Sidecar 已启动或尚未退出");
    const generation = ++this.generation;
    if (this.stopPromise) await this.stopPromise;
    if (generation !== this.generation) throw new Error("Sidecar 启动已取消");
    if (this.proc) throw new Error("Sidecar 已启动或尚未退出");
    this.stopping = false;
    this.setState("connecting");
    try {
      await this.spawnAndHandshake(generation);
      if (generation !== this.generation || this.stopping) throw new Error("Sidecar 启动已取消");
      this.startHeartbeat();
      this.setState("connected");
      this.restarts = 0;
    } catch (error) {
      if (generation === this.generation && !this.stopping) this.setState("failed");
      throw error;
    }
  }

  /** 业务层须先确认空闲；此处只保证进程替换顺序与隔离。 */
  restart(): Promise<void> {
    if (this.restartPromise) return this.restartPromise;
    const stopped = this.stop();
    const generation = this.generation;
    this.setState("reconnecting");
    this.restartPromise = (async () => {
      await stopped;
      if (generation !== this.generation) throw new Error("Sidecar 重启已取消");
      await this.start();
      this.emit("reconnected");
    })().finally(() => { this.restartPromise = null; });
    return this.restartPromise;
  }

  async request(method: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    // Python 的首个输入必须是 hello；重连期间的状态查询也不能抢先入管道。
    if (!this.proc?.stdin || this.readyProc !== this.proc || (this.stopping && method !== "app.shutdown")) {
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

  stop(): Promise<void> {
    this.generation += 1;
    this.stopping = true;
    this.stopHeartbeat();
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopProcess().finally(() => { this.stopPromise = null; });
    return this.stopPromise;
  }

  private async stopProcess(): Promise<void> {
    const child = this.proc;
    const exited = this.procExit;
    try {
      if (child) {
        await this.request("app.shutdown", {});
      }
    } catch {
      // ignore
    }
    // shutdown 的应答不代表解析 worker 已退出；按旧 PID 收尾所属进程树，
    // 即使 exit 已清空 this.proc，也不能把这些 worker 留给下一代实例。
    if (child?.pid) this.killProcess(child);
    if (child && exited && !await this.waitForExit(exited)) {
      this.killProcess(child);
      if (!await this.waitForExit(exited)) {
        this.failPending(new Error("Sidecar 停止超时"));
        this.setState("failed");
        throw new Error("Sidecar 停止超时");
      }
    }
    this.buffer = "";
    this.failPending(new Error("Sidecar 已停止"));
    this.setState("disconnected");
  }

  private async spawnAndHandshake(generation: number): Promise<void> {
    const launch = resolveSidecarLaunch(__dirname, {
      pythonPath: this.opts.pythonPath,
      dataDir: this.opts.dataDir,
      repoRoot: this.opts.repoRoot,
    });
    const child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env: {
        ...launch.env,
        PYTHONUNBUFFERED: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
      // 独立进程组，便于一次杀掉 PyInstaller 父子进程，避免孤儿占库
      detached: process.platform !== "win32",
    });
    this.proc = child;
    this.readyProc = null;
    this.buffer = "";
    let handshaken = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (this.proc === child) this.onStdout(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      if (this.proc === child) this.emit("log", chunk);
    });
    // 管道错误异步发出，不能靠 request() 的 try/catch 捕获。
    // 保留旧流的监听以吸收迟到错误；恢复只由当前 child 的 exit 驱动。
    child.stdin.on("error", () => {
      if (this.proc !== child) return;
      this.readyProc = null;
      this.stopHeartbeat();
      this.failPending(new Error("Sidecar 输入管道已关闭"));
      this.killProcess(child);
    });
    this.procExit = new Promise((resolve) => {
      const onExit = (code: number | null) => {
        resolve();
        if (this.proc !== child) return;
        this.proc = null;
        this.readyProc = null;
        this.procExit = null;
        this.buffer = "";
        this.failPending(new Error(`Sidecar 退出 code=${code}`));
        if (handshaken && !this.stopping) void this.handleCrash(generation);
      };
      child.once("exit", onExit);
      // spawn 失败可能只发 error + close，不发 exit。
      child.once("close", onExit);
    });
    const exited = this.procExit;

    try {
      const hello = await this.waitForHello(child);
      if (hello.protocolVersion !== PROTOCOL_VERSION) {
        throw new Error(`协议版本不兼容: ${hello.protocolVersion}`);
      }
      if (this.proc !== child || generation !== this.generation || this.stopping) {
        throw new Error("Sidecar 启动已取消");
      }
      this.write({
        protocolVersion: PROTOCOL_VERSION,
        type: "hello",
        payload: { app: "electron", appVersion: this.opts.appVersion },
        timestamp: new Date().toISOString(),
      });
      handshaken = true;
      this.readyProc = child;
    } catch (err) {
      // handshake 失败时杀掉孤儿进程，避免占着资源却无法通信
      if (this.proc === child) {
        this.killProcess(child);
        await this.waitForExit(exited);
      }
      throw err;
    }
  }

  private waitForHello(child: ChildProcessWithoutNullStreams): Promise<{ protocolVersion: number }> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.off("raw-hello", onHello);
        child.off("exit", onExit);
        child.off("error", onError);
      };
      // onedir 通常 <2s；保留余量覆盖慢盘 / 首次签名校验
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("等待 Sidecar hello 超时"));
      }, 90000);
      const onHello = (msg: Record<string, unknown>) => {
        cleanup();
        resolve(msg as { protocolVersion: number });
      };
      const onExit = () => {
        cleanup();
        reject(new Error("Sidecar 在握手完成前退出"));
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      this.on("raw-hello", onHello);
      child.once("exit", onExit);
      child.once("error", onError);
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
    const child = this.proc;
    try {
      await this.request("app.ping", {});
      if (child !== this.proc || this.stopping) return;
      this.missedHeartbeats = 0;
    } catch {
      if (child !== this.proc || this.stopping) return;
      this.missedHeartbeats += 1;
      if (this.missedHeartbeats >= this.opts.heartbeatFailLimit) {
        this.emit("log", "心跳连续失败，判定 Sidecar 失联\n");
        this.killProcess();
      }
    }
  }

  private async handleCrash(generation: number): Promise<void> {
    if (generation !== this.generation || this.stopping) return;
    this.stopHeartbeat();
    if (this.restarts >= this.opts.maxRestarts) {
      this.setState("failed");
      return;
    }
    this.restarts += 1;
    this.setState("reconnecting");
    const delay = Math.min(1000 * 2 ** (this.restarts - 1), 8000);
    await new Promise((r) => setTimeout(r, delay));
    if (generation !== this.generation || this.stopping) return;
    try {
      await this.spawnAndHandshake(generation);
      if (generation !== this.generation || this.stopping) return;
      this.startHeartbeat();
      this.setState("connected");
      this.emit("reconnected");
    } catch (err) {
      if (generation !== this.generation || this.stopping) return;
      this.emit("log", `重连失败: ${String(err)}\n`);
      if (this.proc) {
        this.setState("failed");
        return;
      }
      await this.handleCrash(generation);
    }
  }

  private waitForExit(exited: Promise<void>): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), this.opts.shutdownTimeoutMs);
      void exited.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private killProcess(child = this.proc): void {
    if (!child) return;
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
