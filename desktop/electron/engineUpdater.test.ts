// @vitest-environment node
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EngineUpdater, recoverEngineActivation } from "./engineUpdater";

const target = { schemaVersion: 1 as const, sha256: "a".repeat(64), version: "2026.08.19" };
const old = { version: "2026.07.04", selection: "bundled", source: "bundled" };
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "downany-engine-update-"));
  roots.push(dataDir);
  const engines = path.join(dataDir, "engines");
  fs.mkdirSync(engines);
  let current = { ...old };
  let pending: typeof target | null = target;
  let frozen = false;
  let busy = false;
  let operation: Record<string, unknown> | null = null;
  const flags: boolean[] = [];
  const request = vi.fn(async (method: string, payload?: Record<string, unknown>): Promise<unknown> => {
    if (method === "updater.getEngineState") return { current, pending, operation };
    if (method === "updater.freezeEngine") {
      if (busy) return { frozen: false, reason: "busy" };
      expect(payload?.sha256).toBe(target.sha256);
      frozen = true;
      return { frozen: true, token: "ticket", current, pending };
    }
    if (method === "updater.unfreezeEngine") { frozen = false; return { ok: true }; }
    if (method === "updater.updateYtDlp") {
      pending = target;
      operation = { id: "prepare", kind: "prepare", state: "succeeded", result: { ok: true } };
      return { jobId: "prepare" };
    }
    if (method === "updater.checkYtDlp") {
      operation = { id: "check", kind: "check", state: "succeeded", result: {
        currentVersion: old.version, latestVersion: target.version, updateAvailable: true,
      } };
      return { jobId: "check" };
    }
    throw new Error(`unexpected ${method}`);
  });
  const restart = vi.fn(async () => {
    expect(flags.at(-1)).toBe(true);
    const file = path.join(engines, "active.json");
    const selected = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
    current = selected ? { source: "updated", selection: selected.sha256, version: selected.version } : { ...old };
    frozen = false;
  });
  const freezeOtherWork = vi.fn(async () => true);
  const resumeOtherWork = vi.fn(async () => undefined);
  const updater = new EngineUpdater({ dataDir, request, restart, freezeOtherWork, resumeOtherWork,
    setActivating: (value) => flags.push(value), pollMs: 0 });
  return { updater, dataDir, engines, request, restart, flags, freezeOtherWork, resumeOtherWork,
    isFrozen: () => frozen, setBusy: () => { busy = true; },
    noPending: () => { pending = null; }, setCurrent: (info: typeof current) => { current = info; },
  };
}

describe("engine update coordination", () => {
  it("confirms the replacement's actual identity before reporting activation", async () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.engines, "pending.json"), JSON.stringify(target));
    expect(await f.updater.update()).toEqual({ ok: true, state: "activated", version: target.version });
    expect(f.restart).toHaveBeenCalledOnce();
    expect(JSON.parse(fs.readFileSync(path.join(f.engines, "active.json"), "utf8"))).toEqual(target);
    expect(fs.existsSync(path.join(f.engines, "activation.json"))).toBe(false);
    expect(fs.existsSync(path.join(f.engines, "pending.json"))).toBe(false);
    expect(f.flags).toEqual([true, false]);
    expect(f.resumeOtherWork).toHaveBeenCalledOnce();
  });

  it.each(["download", "telegram"])("keeps a prepared update without interrupting busy %s work", async (kind) => {
    const f = fixture();
    if (kind === "download") f.setBusy();
    else f.freezeOtherWork.mockResolvedValue(false);
    expect(await f.updater.update()).toEqual({ ok: false, state: "prepared", version: target.version, currentVersion: old.version });
    expect(f.restart).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(f.engines, "active.json"))).toBe(false);
    expect(f.isFrozen()).toBe(false);
    expect(f.flags.at(-1)).toBe(false);
  });

  it("prepares asynchronously then uses the confirmed pending identity", async () => {
    const f = fixture(); f.noPending();
    expect((await f.updater.update()).state).toBe("activated");
    expect(f.request).toHaveBeenCalledWith("updater.updateYtDlp", {});
  });

  it("coalesces concurrent update clicks into one replacement", async () => {
    const f = fixture();
    const first = f.updater.update();
    const second = f.updater.update();
    expect(first).toBe(second);
    await Promise.all([first, second]);
    expect(f.restart).toHaveBeenCalledOnce();
  });

  it("rolls back when the new process reports a fallback or wrong version", async () => {
    const f = fixture();
    f.restart.mockImplementationOnce(async () => {
      f.setCurrent({ ...old });
    });
    expect((await f.updater.update()).state).toBe("rolled_back");
    expect(f.restart).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(path.join(f.engines, "active.json"))).toBe(false);
    expect(fs.existsSync(path.join(f.engines, "activation.json"))).toBe(false);
    expect(f.flags.at(-1)).toBe(false);
  });

  it("restores a previously updated engine, not merely the bundled version", async () => {
    const f = fixture();
    const previous = { schemaVersion: 1, sha256: "b".repeat(64), version: old.version };
    f.setCurrent({ source: "updated", selection: previous.sha256, version: previous.version });
    fs.writeFileSync(path.join(f.engines, "active.json"), JSON.stringify(previous));
    f.restart.mockRejectedValueOnce(new Error("PRIVATE path failed"));
    const result = await f.updater.update();
    expect(result.state).toBe("rolled_back");
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(JSON.parse(fs.readFileSync(path.join(f.engines, "active.json"), "utf8"))).toEqual(previous);
  });

  it("keeps work fenced if neither the target nor the old engine can be confirmed", async () => {
    const f = fixture();
    f.restart.mockRejectedValue(new Error("PRIVATE network path"));
    const result = await f.updater.update();
    expect(result.state).toBe("failed");
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(f.flags.at(-1)).toBe(true);
    expect(f.resumeOtherWork).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(f.engines, "activation.json"))).toBe(true);
    recoverEngineActivation(f.dataDir);
    expect(fs.existsSync(path.join(f.engines, "activation.json"))).toBe(false);
    expect(fs.existsSync(path.join(f.engines, "active.json"))).toBe(false);
  });

  it("preserves the current engine when background preparation fails", async () => {
    const f = fixture(); f.noPending();
    f.request.mockImplementation(async (method) => method === "updater.updateYtDlp"
      ? { jobId: "bad" }
      : { current: old, pending: null, operation: { id: "bad", kind: "prepare", state: "failed", error: "PRIVATE" } });
    await expect(f.updater.update()).rejects.toThrow("下载工具更新准备失败");
    expect(f.restart).not.toHaveBeenCalled();
    expect(f.flags).toEqual([]);
  });

  it("does not reopen work when the freeze took effect but its response was lost", async () => {
    const f = fixture();
    const request = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (method, payload) => {
      const result = await request(method, payload);
      if (method === "updater.freezeEngine") throw new Error("response lost");
      return result;
    });
    expect((await f.updater.update()).state).toBe("failed");
    expect(f.isFrozen()).toBe(true);
    expect(f.flags.at(-1)).toBe(true);
    expect(f.resumeOtherWork).not.toHaveBeenCalled();
  });

  it("reports a restart requirement if release of the old engine fence cannot be confirmed", async () => {
    const f = fixture();
    fs.mkdirSync(path.join(f.engines, "activation.json"));
    const request = f.request.getMockImplementation()!;
    f.request.mockImplementation((method, payload) => method === "updater.unfreezeEngine"
      ? Promise.reject(new Error("response lost")) : request(method, payload));
    expect((await f.updater.update()).state).toBe("failed");
    expect(f.flags.at(-1)).toBe(true);
    expect(f.resumeOtherWork).not.toHaveBeenCalled();
  });

  it("retains a safe recovery status for reopened windows when the sidecar is unavailable", async () => {
    const f = fixture();
    const request = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (method, payload) => {
      const result = await request(method, payload);
      if (method === "updater.freezeEngine") throw new Error("response lost");
      return result;
    });
    expect((await f.updater.update()).state).toBe("failed");
    f.request.mockRejectedValue(new Error("PRIVATE sidecar unavailable"));
    await expect(f.updater.getState()).resolves.toEqual({ recoveryRequired: true });
    expect(f.updater.recoveryRequired).toBe(true);
    expect(f.flags.at(-1)).toBe(true);
    expect(f.resumeOtherWork).not.toHaveBeenCalled();
  });

  it("does not restart or downgrade if preparation finds the current engine is already latest", async () => {
    const f = fixture(); f.noPending();
    f.request.mockImplementation(async (method) => method === "updater.updateYtDlp"
      ? { jobId: "same" }
      : { current: old, pending: null, operation: { id: "same", kind: "prepare", state: "succeeded",
        result: { ok: false, upToDate: true, version: old.version } } });
    expect(await f.updater.update()).toEqual({ ok: true, state: "current", version: old.version });
    expect(f.restart).not.toHaveBeenCalled();
    expect(f.flags).toEqual([]);
  });

  it("check reports actual current and pending versions without activation", async () => {
    const f = fixture();
    expect(await f.updater.check()).toEqual({ currentVersion: old.version, latestVersion: target.version,
      updateAvailable: true, pendingVersion: target.version });
    expect(f.restart).not.toHaveBeenCalled();
  });

  it("does not apply an invalid identity supplied in a pending record", async () => {
    const f = fixture();
    f.request.mockResolvedValue({ current: old, pending: { ...target, sha256: "../private" } });
    await expect(f.updater.update()).rejects.toThrow();
    expect(f.restart).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(f.engines, "active.json"))).toBe(false);
  });

  it("restores an interrupted activation before startup", () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.engines, "active.json"), JSON.stringify(target));
    fs.writeFileSync(path.join(f.engines, "activation.json"), JSON.stringify({ schemaVersion: 1, previous: null, target }));
    recoverEngineActivation(f.dataDir);
    expect(fs.existsSync(path.join(f.engines, "active.json"))).toBe(false);
    expect(fs.existsSync(path.join(f.engines, "activation.json"))).toBe(false);
  });
});
