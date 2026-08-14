import { buildTelegramBotApiChildEnv, ensurePrivateTelegramPaths, ensureProcessHostResourceInput, ensureTelegramResourceInputs, type TelegramAppCredentials, type TelegramPathSecurityDeps, type TelegramRuntimePaths } from "./paths";

export type SupervisorState = "stopped" | "starting" | "ready" | "restarting" | "failed";

export interface TelegramBotApiEndpoint {
  host: "127.0.0.1";
  port: number;
  baseUrl: string;
}

export interface TelegramOwnedProcessInfo {
  pid: number;
  parentPid: number | null;
  executablePath: string;
  startedAt: string;
  commandLine: string;
}

export interface ContainedProcessCandidate {
  instanceId: string;
  guardian: TelegramOwnedProcessInfo;
  root: TelegramOwnedProcessInfo;
  containment: "windows_job_object" | "darwin_process_group";
  processGroupId: number | null;
}

export interface ProcessTreeSnapshot {
  schemaVersion: 2;
  root: TelegramOwnedProcessInfo;
  guardian: TelegramOwnedProcessInfo;
  platform: NodeJS.Platform;
  containment: "windows_job_object" | "darwin_process_group";
  processGroupId: number | null;
  members: readonly { pid: number; startedAt: string }[];
  generationId: string;
}

export interface ProcessTreeHandle {
  readonly platform: NodeJS.Platform;
  readonly generationId: string;
  snapshot(): ProcessTreeSnapshot;
}

export interface ProcessTreeOperationResult {
  exited: boolean;
  snapshot: ProcessTreeSnapshot;
}

export interface TelegramSpawnedProcess {
  candidate: ContainedProcessCandidate;
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  resume(): Promise<void>;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  once(event: "error", listener: (error: Error) => void): void;
}

export interface ProcessOwnerState {
  version: 5;
  kind: "telegram-bot-api";
  executablePath: string;
  processHostExecutablePath: string;
  workDir: string;
  expectedArgv: readonly string[];
  expectedCommandLine: string;
  expectedGuardianCommandLine: string;
  endpoint: TelegramBotApiEndpoint;
  instanceId: string;
  spawnWindowStartedAt: string;
  registration: "launching" | "quarantined" | "verified";
  spawnWindowEndedAt: string | null;
  pid?: number;
  startedAt?: string;
  candidate?: ContainedProcessCandidate;
  tree?: ProcessTreeSnapshot;
}

export interface ProcessOwnerStateStore {
  load(): Promise<ProcessOwnerState | null>;
  write(state: ProcessOwnerState): Promise<void>;
  clear(): Promise<void>;
}

export interface TelegramSupervisorStateChange {
  state: SupervisorState;
  endpoint: TelegramBotApiEndpoint | null;
  reason: "start" | "unexpected_exit" | "restart_ready" | "restart_exhausted" | "intentional_stop" | "stale_process_recovery_required" | "process_tree_capture_failed";
  failureCode: null | "LOCAL_SERVICE_UNAVAILABLE" | "LOCAL_PROCESS_RECOVERY_REQUIRED";
}

export interface TelegramSupervisorDeps {
  paths: TelegramRuntimePaths;
  appCredentials: TelegramAppCredentials;
  baseEnv: NodeJS.ProcessEnv;
  isPackaged?: boolean;
  envOverrideExecutable?: string | null;
  spawnContainedProcess(
    executable: string,
    args: readonly string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; shell: false; detached: boolean; windowsHide: true },
  ): Promise<TelegramSpawnedProcess>;
  allocatePort(host: "127.0.0.1"): Promise<number>;
  probeTcp(host: "127.0.0.1", port: number, signal: AbortSignal): Promise<boolean>;
  inspectProcess(pid: number): Promise<TelegramOwnedProcessInfo | null>;
  findOwnedProcessCandidates(query: {
    instanceId: string;
    processHostExecutablePath: string;
    targetExecutablePath: string;
    expectedGuardianCommandLine: string;
    expectedTargetCommandLine: string;
    spawnWindowStartedAt: string;
    spawnWindowEndedAt: string;
  }): Promise<readonly ContainedProcessCandidate[]>;
  captureContainedProcessTree(candidate: ContainedProcessCandidate, generationId: string): Promise<ProcessTreeHandle | null>;
  restoreProcessTree(snapshot: ProcessTreeSnapshot): ProcessTreeHandle;
  refreshProcessTree(handle: ProcessTreeHandle, persist: (snapshot: ProcessTreeSnapshot) => Promise<void>): Promise<ProcessTreeSnapshot>;
  terminateAndWaitProcessTree(handle: ProcessTreeHandle, options: { gracefulTimeoutMs: number; forceTimeoutMs: number }, persist: (snapshot: ProcessTreeSnapshot) => Promise<void>): Promise<ProcessTreeOperationResult>;
  ownerStore: ProcessOwnerStateStore;
  pathSecurity: TelegramPathSecurityDeps;
  verifyPackagedResources?: () => Promise<void>;
  nowIso(): string;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  randomId(): string;
  log(level: "info" | "warn" | "error", safeMessage: string): void;
}

function commandLine(args: readonly string[]): string {
  return args.map((arg) => /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg).join(" ");
}

function supervisorError(code: "LOCAL_SERVICE_UNAVAILABLE" | "LOCAL_PROCESS_RECOVERY_REQUIRED", message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

export class TelegramBotApiSupervisor {
  private state: SupervisorState = "stopped";
  private endpoint: TelegramBotApiEndpoint | null = null;
  private handle: ProcessTreeHandle | null = null;
  private startPromise: Promise<TelegramBotApiEndpoint> | null = null;
  private stopPromise: Promise<void> | null = null;
  private generation = "";
  private stopping = false;
  private restartCount = 0;
  private readonly listeners = new Set<(event: TelegramSupervisorStateChange) => void>();

  constructor(private readonly deps: TelegramSupervisorDeps) {}

  getState(): SupervisorState { return this.state; }

  onStateChange(listener: (event: TelegramSupervisorStateChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<TelegramBotApiEndpoint> {
    if (this.state === "ready" && this.endpoint) return this.endpoint;
    if (this.startPromise) return this.startPromise;
    this.stopping = false;
    this.startPromise = this.startInternal().finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  async health(): Promise<boolean> {
    if (this.state !== "ready" || !this.endpoint) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    try {
      return await this.deps.probeTcp(this.endpoint.host, this.endpoint.port, controller.signal);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopInternal().finally(() => { this.stopPromise = null; });
    return this.stopPromise;
  }

  private transition(event: TelegramSupervisorStateChange): void {
    this.state = event.state;
    this.endpoint = event.endpoint;
    for (const listener of this.listeners) listener(event);
  }

  private async startInternal(): Promise<TelegramBotApiEndpoint> {
    this.transition({ state: "starting", endpoint: null, reason: "start", failureCode: null });
    try {
      await this.recoverOwner();
      await ensurePrivateTelegramPaths({
        rootDir: this.deps.paths.rootDir,
        workDir: this.deps.paths.workDir,
        tempDir: this.deps.paths.tempDir,
        credentialFile: this.deps.paths.credentialFile,
        ownerStateFile: this.deps.paths.ownerStateFile,
        sidecarOwnerStateFile: this.deps.paths.sidecarOwnerStateFile,
      }, this.deps.pathSecurity);
      await ensureTelegramResourceInputs({
        executable: this.deps.paths.executable,
        appCredentialsFile: this.deps.paths.appCredentialsFile,
        isPackaged: this.deps.isPackaged ?? false,
        resourcesPath: this.resourcesRoot(),
        envOverrideExecutable: this.deps.envOverrideExecutable ?? null,
        hasDevelopmentCredentials: !this.deps.isPackaged,
      }, this.deps.pathSecurity);
      await ensureProcessHostResourceInput({
        processHostExecutable: this.deps.paths.processHostExecutable,
        isPackaged: this.deps.isPackaged ?? false,
        resourcesPath: this.resourcesRoot().replace(/[\\/]telegram-bot-api$/i, ""),
      }, this.deps.pathSecurity);
      if (this.deps.isPackaged && this.deps.verifyPackagedResources) {
        await this.deps.verifyPackagedResources();
      }

      const port = await this.deps.allocatePort("127.0.0.1");
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("本地 Bot API 端口无效");
      const endpoint: TelegramBotApiEndpoint = { host: "127.0.0.1", port, baseUrl: `http://127.0.0.1:${port}` };
      const args = [
        this.deps.paths.executable,
        "--local",
        "--http-ip-address=127.0.0.1",
        `--http-port=${port}`,
        `--dir=${this.deps.paths.workDir}`,
        `--temp-dir=${this.deps.paths.tempDir}`,
      ];
      this.generation = this.deps.randomId();
      const guardianArgs = ["--instance-id", this.generation, "--", ...args];
      const startedAt = this.deps.nowIso();
      const owner: ProcessOwnerState = {
        version: 5,
        kind: "telegram-bot-api",
        executablePath: this.deps.paths.executable,
        processHostExecutablePath: this.deps.paths.processHostExecutable,
        workDir: this.deps.paths.workDir,
        expectedArgv: args,
        expectedCommandLine: commandLine(args),
        expectedGuardianCommandLine: commandLine([this.deps.paths.processHostExecutable, ...guardianArgs]),
        endpoint,
        instanceId: this.generation,
        spawnWindowStartedAt: startedAt,
        registration: "launching",
        spawnWindowEndedAt: null,
        candidate: undefined,
        tree: undefined,
      };
      await this.deps.ownerStore.write(owner);
      const childEnv = buildTelegramBotApiChildEnv(this.deps.baseEnv, this.deps.appCredentials);
      const child = await this.deps.spawnContainedProcess(this.deps.paths.processHostExecutable, guardianArgs, {
        cwd: this.deps.paths.workDir,
        env: childEnv,
        shell: false,
        detached: this.deps.pathSecurity.platform !== "win32",
        windowsHide: true,
      });
      this.attachTerminal(child);
      this.assertCandidate(child.candidate, this.generation, args);
      const endedAt = this.deps.nowIso();
      const quarantined: ProcessOwnerState = {
        ...owner,
        registration: "quarantined",
        spawnWindowEndedAt: endedAt,
        pid: child.candidate.root.pid,
        startedAt: child.candidate.root.startedAt,
        candidate: child.candidate,
        tree: undefined,
      };
      await this.deps.ownerStore.write(quarantined);
      const handle = await this.deps.captureContainedProcessTree(child.candidate, this.generation);
      if (!handle) {
        this.transition({ state: "failed", endpoint: null, reason: "process_tree_capture_failed", failureCode: "LOCAL_PROCESS_RECOVERY_REQUIRED" });
        throw supervisorError("LOCAL_PROCESS_RECOVERY_REQUIRED", "无法捕获 Telegram Bot API 进程树");
      }
      this.handle = handle;
      const verified: ProcessOwnerState = {
        ...quarantined,
        registration: "verified",
        tree: handle.snapshot(),
      };
      await this.deps.ownerStore.write(verified);
      await child.resume();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      let healthy = false;
      try { healthy = await this.deps.probeTcp(endpoint.host, endpoint.port, controller.signal); } finally { clearTimeout(timer); }
      if (!healthy) throw supervisorError("LOCAL_SERVICE_UNAVAILABLE", "本地 Telegram 服务未就绪");
      this.restartCount = 0;
      this.transition({ state: "ready", endpoint, reason: "start", failureCode: null });
      return endpoint;
    } catch (error) {
      if (this.state !== "failed") {
        this.transition({ state: "failed", endpoint: null, reason: "start", failureCode: (error as { code?: string }).code === "LOCAL_PROCESS_RECOVERY_REQUIRED" ? "LOCAL_PROCESS_RECOVERY_REQUIRED" : "LOCAL_SERVICE_UNAVAILABLE" });
      }
      throw error;
    }
  }

  private resourcesRoot(): string {
    return this.deps.paths.appCredentialsFile.replace(/[\\/]telegram-bot-api[\\/]app-credentials\.json$/i, "");
  }

  private assertCandidate(candidate: ContainedProcessCandidate, instanceId: string, args: readonly string[]): void {
    const expectedContainment = this.deps.pathSecurity.platform === "win32" ? "windows_job_object" : "darwin_process_group";
    if (candidate.instanceId !== instanceId || candidate.root.executablePath !== this.deps.paths.executable || candidate.guardian.executablePath !== this.deps.paths.processHostExecutable || candidate.root.parentPid !== candidate.guardian.pid || candidate.guardian.pid <= 0 || candidate.root.pid <= 0 || candidate.containment !== expectedContainment) {
      throw supervisorError("LOCAL_PROCESS_RECOVERY_REQUIRED", "Telegram 进程身份校验失败");
    }
    const expected = commandLine([this.deps.paths.executable, ...args.slice(1)]);
    if (candidate.root.commandLine !== expected && candidate.root.commandLine !== commandLine(args)) {
      throw supervisorError("LOCAL_PROCESS_RECOVERY_REQUIRED", "Telegram 进程参数校验失败");
    }
  }

  private attachTerminal(process: TelegramSpawnedProcess): void {
    let settled = false;
    const terminal = (reason: string) => {
      if (settled || this.stopping) return;
      settled = true;
      void this.handleUnexpectedExit(reason);
    };
    process.once("error", () => terminal("error"));
    process.once("exit", () => terminal("exit"));
  }

  private async handleUnexpectedExit(reason: string): Promise<void> {
    const generation = this.generation;
    this.transition({ state: "restarting", endpoint: this.endpoint, reason: "unexpected_exit", failureCode: null });
    if (this.handle) {
      const result = await this.deps.terminateAndWaitProcessTree(this.handle, { gracefulTimeoutMs: 3_000, forceTimeoutMs: 2_000 }, async (snapshot) => {
        const owner = await this.deps.ownerStore.load();
        if (owner && owner.instanceId === generation) await this.deps.ownerStore.write({ ...owner, tree: snapshot });
      });
      if (!result.exited) {
        this.transition({ state: "failed", endpoint: null, reason: "unexpected_exit", failureCode: "LOCAL_PROCESS_RECOVERY_REQUIRED" });
        return;
      }
      this.handle = null;
      await this.deps.ownerStore.clear();
    }
    if (this.stopping) return;
    const delays = [1_000, 3_000, 10_000];
    if (this.restartCount >= delays.length) {
      this.transition({ state: "failed", endpoint: null, reason: "restart_exhausted", failureCode: "LOCAL_SERVICE_UNAVAILABLE" });
      return;
    }
    const index = this.restartCount++;
    const controller = new AbortController();
    try {
      await this.deps.sleep(delays[index], controller.signal);
      if (!this.stopping) {
        await this.start();
        this.deps.log("warn", `Telegram 本地服务已从 ${reason} 恢复`);
      }
    } catch {
      this.transition({ state: "failed", endpoint: null, reason: "restart_exhausted", failureCode: "LOCAL_SERVICE_UNAVAILABLE" });
    }
  }

  private async recoverOwner(): Promise<void> {
    const owner = await this.deps.ownerStore.load();
    if (!owner) return;
    if (owner.registration === "launching") {
      const candidates = await this.deps.findOwnedProcessCandidates({
        instanceId: owner.instanceId,
        processHostExecutablePath: owner.processHostExecutablePath,
        targetExecutablePath: owner.executablePath,
        expectedGuardianCommandLine: owner.expectedGuardianCommandLine,
        expectedTargetCommandLine: owner.expectedCommandLine,
        spawnWindowStartedAt: owner.spawnWindowStartedAt,
        spawnWindowEndedAt: owner.spawnWindowStartedAt,
      });
      if (candidates.length > 0) throw supervisorError("LOCAL_PROCESS_RECOVERY_REQUIRED", "Telegram 启动意图仍有未收敛进程");
      await this.deps.ownerStore.clear();
      return;
    }
    if (!owner.tree) throw supervisorError("LOCAL_PROCESS_RECOVERY_REQUIRED", "Telegram owner state 缺少进程树");
    const handle = this.deps.restoreProcessTree(owner.tree);
    const result = await this.deps.terminateAndWaitProcessTree(handle, { gracefulTimeoutMs: 3_000, forceTimeoutMs: 2_000 }, async (snapshot) => {
      await this.deps.ownerStore.write({ ...owner, tree: snapshot });
    });
    if (!result.exited) throw supervisorError("LOCAL_PROCESS_RECOVERY_REQUIRED", "旧 Telegram 进程树未收敛");
    await this.deps.ownerStore.clear();
  }

  private async stopInternal(): Promise<void> {
    this.stopping = true;
    const handle = this.handle;
    if (!handle) {
      this.endpoint = null;
      this.transition({ state: "stopped", endpoint: null, reason: "intentional_stop", failureCode: null });
      return;
    }
    const result = await this.deps.terminateAndWaitProcessTree(handle, { gracefulTimeoutMs: 3_000, forceTimeoutMs: 2_000 }, async (snapshot) => {
      const owner = await this.deps.ownerStore.load();
      if (owner) await this.deps.ownerStore.write({ ...owner, tree: snapshot });
    });
    if (!result.exited) {
      this.transition({ state: "failed", endpoint: null, reason: "intentional_stop", failureCode: "LOCAL_PROCESS_RECOVERY_REQUIRED" });
      throw supervisorError("LOCAL_PROCESS_RECOVERY_REQUIRED", "Telegram 本地服务未完全停止");
    }
    await this.deps.ownerStore.clear();
    this.handle = null;
    this.endpoint = null;
    this.transition({ state: "stopped", endpoint: null, reason: "intentional_stop", failureCode: null });
  }
}
