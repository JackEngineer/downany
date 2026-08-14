import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { TelegramBotApiSupervisor, type ProcessOwnerState, type TelegramSupervisorDeps } from "./supervisor";

function deps(overrides: Partial<TelegramSupervisorDeps> = {}): TelegramSupervisorDeps {
  let owner: ProcessOwnerState | null = null;
  const candidate = {
    instanceId: "instance-1",
    guardian: { pid: 10, parentPid: null, executablePath: "C:\\resources\\process-host\\DownanyProcessHost.exe", startedAt: "2026-08-12T00:00:00.000Z", commandLine: "host" },
    root: { pid: 11, parentPid: 10, executablePath: "C:\\resources\\telegram-bot-api\\telegram-bot-api.exe", startedAt: "2026-08-12T00:00:00.000Z", commandLine: "C:\\resources\\telegram-bot-api\\telegram-bot-api.exe --local --http-ip-address=127.0.0.1 --http-port=43127 --dir=C:\\data\\telegram\\bot-api --temp-dir=C:\\data\\telegram\\temp" },
    containment: "windows_job_object" as const,
    processGroupId: null,
  };
  const snapshot = { schemaVersion: 2 as const, root: candidate.root, guardian: candidate.guardian, platform: "win32" as NodeJS.Platform, containment: "windows_job_object" as const, processGroupId: null, members: [{ pid: 10, startedAt: candidate.guardian.startedAt }, { pid: 11, startedAt: candidate.root.startedAt }], generationId: "instance-1" };
  const handle = { platform: "win32" as NodeJS.Platform, generationId: "instance-1", snapshot: () => snapshot };
  const process = {
    candidate,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    resume: async () => undefined,
    once: (_event: "exit" | "error", _listener: (...args: any[]) => void) => undefined,
  };
  const base: TelegramSupervisorDeps = {
    paths: {
      executable: "C:\\resources\\telegram-bot-api\\telegram-bot-api.exe",
      processHostExecutable: "C:\\resources\\process-host\\DownanyProcessHost.exe",
      rootDir: "C:\\data\\telegram",
      workDir: "C:\\data\\telegram\\bot-api",
      tempDir: "C:\\data\\telegram\\temp",
      credentialFile: "C:\\data\\telegram\\bot-token.v1",
      appCredentialsFile: "C:\\resources\\telegram-bot-api\\app-credentials.json",
      ownerStateFile: "C:\\data\\telegram\\owner-state.json",
      sidecarOwnerStateFile: "C:\\data\\telegram\\sidecar-owner-state.json",
    },
    appCredentials: { apiId: "123456", apiHash: "0123456789abcdef0123456789abcdef" },
    baseEnv: { PATH: "C:\\Windows\\System32", BOT_TOKEN: "123456:secret", GH_TOKEN: "secret" },
    isPackaged: true,
    spawnContainedProcess: async () => process,
    allocatePort: async () => 43127,
    probeTcp: async () => true,
    inspectProcess: async (pid) => pid === 10 ? candidate.guardian : pid === 11 ? candidate.root : null,
    findOwnedProcessCandidates: async () => [],
    captureContainedProcessTree: async () => handle,
    restoreProcessTree: () => handle,
    refreshProcessTree: async () => snapshot,
    terminateAndWaitProcessTree: async () => ({ exited: true, snapshot }),
    ownerStore: { load: async () => owner, write: async (value) => { owner = value; }, clear: async () => { owner = null; } },
    pathSecurity: {
      platform: "win32",
      currentUserSid: "S-1-5-21-test",
      inspectPath: async (value) => ({ exists: true, kind: /bot-token|owner-state|app-credentials\.json|\.exe$/.test(value) ? "file" as const : "directory" as const, isLinkOrReparsePoint: false, posixMode: null }),
      createDirectory: async () => undefined,
      chmod: async () => undefined,
      applyWindowsAcl: async () => undefined,
      inspectWindowsAcl: async () => ({ inheritanceDisabled: true, allowSids: ["S-1-5-21-test", "S-1-5-18"], fullControlSids: ["S-1-5-21-test", "S-1-5-18"] }),
    },
    nowIso: () => "2026-08-12T00:00:00.000Z",
    sleep: async () => undefined,
    randomId: () => "instance-1",
    log: () => undefined,
  };
  return { ...base, ...overrides };
}

describe("TelegramBotApiSupervisor", () => {
  it("uses the local endpoint, exact local flags, minimal env and resumes only after owner verification", async () => {
    let spawnArgs: { executable: string; args: readonly string[]; options: Record<string, unknown> } | undefined;
    let resumed = false;
    const base = deps();
    const original = base.spawnContainedProcess;
    const supervisor = new TelegramBotApiSupervisor({
      ...base,
      spawnContainedProcess: async (executable, args, options) => {
        spawnArgs = { executable, args, options };
        const process = await original(executable, args, options);
        return { ...process, resume: async () => { resumed = true; await process.resume(); } };
      },
    });
    await expect(supervisor.start()).resolves.toEqual({ host: "127.0.0.1", port: 43127, baseUrl: "http://127.0.0.1:43127" });
    expect(spawnArgs?.executable).toContain("DownanyProcessHost.exe");
    expect(spawnArgs?.args).toEqual([
      "--instance-id",
      "instance-1",
      "--",
      "C:\\resources\\telegram-bot-api\\telegram-bot-api.exe",
      "--local",
      "--http-ip-address=127.0.0.1",
      "--http-port=43127",
      "--dir=C:\\data\\telegram\\bot-api",
      "--temp-dir=C:\\data\\telegram\\temp",
    ]);
    expect(spawnArgs?.options.shell).toBe(false);
    expect((spawnArgs?.options.env as NodeJS.ProcessEnv).TELEGRAM_API_HASH).toBe("0123456789abcdef0123456789abcdef");
    expect((spawnArgs?.options.env as NodeJS.ProcessEnv).BOT_TOKEN).toBeUndefined();
    expect(resumed).toBe(true);
    expect(supervisor.getState()).toBe("ready");
    await supervisor.stop();
    expect(supervisor.getState()).toBe("stopped");
  });

  it("fails closed when the contained candidate does not match the guardian", async () => {
    const base = deps({
      spawnContainedProcess: async () => {
        const process = (await deps().spawnContainedProcess("", [], { cwd: "", env: {}, shell: false, detached: false, windowsHide: true }));
        return { ...process, candidate: { ...process.candidate, root: { ...process.candidate.root, parentPid: null } } };
      },
    });
    const supervisor = new TelegramBotApiSupervisor(base);
    await expect(supervisor.start()).rejects.toMatchObject({ code: "LOCAL_PROCESS_RECOVERY_REQUIRED" });
    expect(supervisor.getState()).toBe("failed");
  });

  it("revalidates packaged native resources before spawning after a resource drift", async () => {
    let spawnCount = 0;
    const base = deps({
      spawnContainedProcess: async (...args) => {
        spawnCount += 1;
        return deps().spawnContainedProcess(...args);
      },
    });
    const supervisor = new TelegramBotApiSupervisor({
      ...base,
      verifyPackagedResources: async () => { throw new Error("packaged manifest drift"); },
    } as TelegramSupervisorDeps & { verifyPackagedResources: () => Promise<void> });

    await expect(supervisor.start()).rejects.toThrow("packaged manifest drift");
    expect(spawnCount).toBe(0);
  });
});
