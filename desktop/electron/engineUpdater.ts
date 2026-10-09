import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface EngineManifest { schemaVersion: 1; sha256: string; version: string }
interface EngineInfo { source: "bundled" | "updated"; selection: string; version: string; fallbackReason?: string }
interface EngineState {
  current: EngineInfo;
  pending: EngineManifest | null;
  operation?: { id: string; kind: "check" | "prepare"; state: "running" | "succeeded" | "failed"; result?: Record<string, unknown> } | null;
}
interface EngineUpdaterOptions {
  dataDir: string;
  request: (method: string, payload?: Record<string, unknown>) => Promise<unknown>;
  restart: () => Promise<void>;
  freezeOtherWork: () => Promise<boolean>;
  resumeOtherWork: () => Promise<void>;
  setActivating: (value: boolean) => void;
  pollMs?: number;
}
export type EngineUpdateResult =
  | { ok: true; state: "activated"; version: string }
  | { ok: true; state: "current"; version: string }
  | { ok: false; state: "prepared"; version: string; currentVersion: string }
  | { ok: false; state: "rolled_back"; version: string; currentVersion: string }
  | { ok: false; state: "failed"; version: string };

const VERSION = /^[0-9][0-9A-Za-z.+_-]{0,63}$/;
const SHA = /^[a-f0-9]{64}$/;

function manifest(value: unknown): EngineManifest {
  const row = value as Partial<EngineManifest> | null;
  if (!row || row.schemaVersion !== 1 || typeof row.sha256 !== "string" || !SHA.test(row.sha256)
    || typeof row.version !== "string" || !VERSION.test(row.version)) throw new Error("下载工具更新记录无效");
  return { schemaVersion: 1, sha256: row.sha256, version: row.version };
}

function engineInfo(value: unknown): EngineInfo {
  const row = value as Partial<EngineInfo> | null;
  if (!row || typeof row.version !== "string" || !VERSION.test(row.version)
    || !((row.source === "bundled" && row.selection === "bundled")
      || (row.source === "updated" && typeof row.selection === "string" && SHA.test(row.selection)))) {
    throw new Error("无法确认当前下载工具版本");
  }
  return row as EngineInfo;
}

function sameEngine(actual: EngineInfo, expected: EngineInfo): boolean {
  return actual.version === expected.version && actual.source === expected.source
    && actual.selection === expected.selection && !actual.fallbackReason;
}

function writeAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value) + "\n", "utf8");
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  try { fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
}

function writeSelection(root: string, selected: EngineManifest | null): void {
  const file = path.join(root, "active.json");
  if (selected) writeAtomic(file, selected);
  else fs.rmSync(file, { force: true });
}

/** 未完成的启用一律先恢复旧选择；由 Main 执行，不依赖坏引擎能否启动。 */
export function recoverEngineActivation(dataDir: string): void {
  const root = path.join(dataDir, "engines");
  const journal = path.join(root, "activation.json");
  if (!fs.existsSync(journal)) return;
  try {
    if (fs.lstatSync(journal).isSymbolicLink() || fs.statSync(journal).size > 16 * 1024) throw new Error();
    const record = JSON.parse(fs.readFileSync(journal, "utf8"));
    if (record.schemaVersion !== 1) throw new Error();
    manifest(record.target);
    const previous = record.previous === null ? null : manifest(record.previous);
    writeSelection(root, previous);
    fs.unlinkSync(journal);
  } catch {
    throw new Error("下载工具更新恢复失败，请检查应用数据目录后重新启动");
  }
}

export class EngineUpdater {
  private updatePromise: Promise<EngineUpdateResult> | null = null;
  private checkPromise: Promise<Record<string, unknown>> | null = null;
  private closing = false;
  private blocked = false;

  constructor(private readonly options: EngineUpdaterOptions) {}

  private async state(): Promise<EngineState> {
    const raw = await this.options.request("updater.getEngineState", {}) as EngineState;
    return { ...raw, current: engineInfo(raw?.current), pending: raw?.pending ? manifest(raw.pending) : null };
  }

  get recoveryRequired(): boolean { return this.blocked; }

  async getState(): Promise<(EngineState & { recoveryRequired: false }) | { recoveryRequired: true }> {
    // 需要重启时不能依赖已失联/仍冻结的 Sidecar，也不能报告旧引擎可用。
    if (this.blocked) return { recoveryRequired: true };
    try {
      const state = await this.state();
      return this.blocked ? { recoveryRequired: true } : { ...state, recoveryRequired: false };
    } catch (error) {
      if (this.blocked) return { recoveryRequired: true };
      throw error;
    }
  }

  private async job(kind: "check" | "prepare"): Promise<Record<string, unknown>> {
    const method = kind === "check" ? "updater.checkYtDlp" : "updater.updateYtDlp";
    const started = await this.options.request(method, {}) as { jobId?: string };
    if (!started?.jobId) throw new Error("下载工具更新准备失败");
    const deadline = Date.now() + 180_000;
    while (!this.closing && Date.now() < deadline) {
      const { operation } = await this.state();
      if (!operation || operation.id !== started.jobId || operation.kind !== kind) break;
      if (operation.state === "succeeded") return operation.result || {};
      if (operation.state === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, this.options.pollMs ?? 250));
    }
    throw new Error("下载工具更新准备失败");
  }

  check(): Promise<Record<string, unknown>> {
    if (this.checkPromise) return this.checkPromise;
    if (this.updatePromise) return this.updatePromise.then(() => this.check());
    this.checkPromise = (async () => {
      if (this.closing || this.blocked) throw new Error("下载工具暂不可用，请重新启动应用");
      const info = await this.job("check");
      const state = await this.state();
      return { currentVersion: state.current.version, latestVersion: info.latestVersion,
        updateAvailable: info.updateAvailable === true,
        ...(state.pending && state.pending.sha256 !== state.current.selection ? { pendingVersion: state.pending.version } : {}) };
    })().finally(() => { this.checkPromise = null; });
    return this.checkPromise;
  }

  update(): Promise<EngineUpdateResult> {
    if (this.updatePromise) return this.updatePromise;
    const precedingCheck = this.checkPromise;
    this.updatePromise = (async (): Promise<EngineUpdateResult> => {
      if (precedingCheck) await precedingCheck.catch(() => undefined);
      if (this.closing || this.blocked) throw new Error("下载工具暂不可用，请重新启动应用");
      let state = await this.state();
      if (!state.pending || state.pending.sha256 === state.current.selection) {
        const prepared = await this.job("prepare");
        state = await this.state();
        if (prepared.upToDate === true && prepared.version === state.current.version) {
          return { ok: true, state: "current", version: state.current.version };
        }
      }
      if (!state.pending) throw new Error("下载工具更新准备失败");
      if (this.closing) throw new Error("应用正在关闭");
      return this.activate(state.pending, state.current);
    })().finally(() => { this.updatePromise = null; });
    return this.updatePromise;
  }

  private async activate(target: EngineManifest, before: EngineInfo): Promise<EngineUpdateResult> {
    const { request, restart, freezeOtherWork, resumeOtherWork, setActivating, dataDir } = this.options;
    const root = path.join(dataDir, "engines");
    const journal = path.join(root, "activation.json");
    let token: string | null = null;
    let freezeRequested = false;
    let journalWritten = false;
    let safeToResume = true;
    let previous: EngineManifest | null = null;
    let old = before;
    setActivating(true);
    try {
      if (!await freezeOtherWork()) return { ok: false, state: "prepared", version: target.version, currentVersion: before.version };
      freezeRequested = true;
      const frozen = await request("updater.freezeEngine", { sha256: target.sha256 }) as {
        frozen: boolean; reason?: string; token?: string; current?: EngineInfo; pending?: EngineManifest;
      };
      if (!frozen.frozen) {
        freezeRequested = false;
        if (frozen.reason === "busy") return { ok: false, state: "prepared", version: target.version, currentVersion: before.version };
        throw new Error("下载工具更新尚未准备好");
      }
      token = typeof frozen.token === "string" && frozen.token.length > 0 ? frozen.token : null;
      if (!token) throw new Error("无法确认下载工具启用状态");
      const selected = manifest(frozen.pending);
      if (selected.sha256 !== target.sha256 || selected.version !== target.version) throw new Error("下载工具更新记录已变化");
      old = engineInfo(frozen.current);
      previous = old.source === "updated" ? { schemaVersion: 1, sha256: old.selection, version: old.version } : null;
      writeAtomic(journal, { schemaVersion: 1, previous, target });
      journalWritten = true;
      writeSelection(root, target);
      await restart();
      token = null;
      const current = (await this.state()).current;
      if (!sameEngine(current, { source: "updated", selection: target.sha256, version: target.version })) throw new Error("新版下载工具未启用");
      // 只有新进程实际运行目标归档，才提交这次切换并对外报告成功。
      fs.unlinkSync(journal);
      journalWritten = false;
      try { fs.rmSync(path.join(root, "pending.json"), { force: true }); } catch { /* 当前身份已确认，残留 pending 不影响运行 */ }
      return { ok: true, state: "activated", version: current.version };
    } catch {
      // 请求已发出但未收到票据时，旧进程可能已经冻结；不能假定它仍可工作。
      if (freezeRequested && token === null && !journalWritten) {
        safeToResume = false;
        this.blocked = true;
        return { ok: false, state: "failed", version: target.version };
      }
      if (!journalWritten) throw new Error("下载工具更新未能启用，原版本保持不变");
      safeToResume = false;
      try {
        writeSelection(root, previous);
        await restart();
        token = null;
        const current = (await this.state()).current;
        if (!sameEngine(current, { ...old, fallbackReason: undefined })) throw new Error();
        fs.unlinkSync(journal);
        safeToResume = true;
        return { ok: false, state: "rolled_back", version: target.version, currentVersion: current.version };
      } catch {
        this.blocked = true;
        return { ok: false, state: "failed", version: target.version };
      }
    } finally {
      if (safeToResume) {
        if (token) await request("updater.unfreezeEngine", { token }).catch(() => { safeToResume = false; });
        if (safeToResume) {
          await resumeOtherWork();
          setActivating(false);
        } else {
          this.blocked = true;
          return { ok: false, state: "failed", version: target.version };
        }
      }
    }
  }

  async stop(): Promise<void> {
    this.closing = true;
    await this.updatePromise?.catch(() => undefined);
  }
}
