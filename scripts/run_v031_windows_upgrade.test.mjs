import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import test from "node:test";

import {
  OFFICIAL_V030_WINDOWS_SHA256,
  buildFreshInstallEnvironment,
  installerArguments,
  parseArguments,
  assertOwnedUpgradeTree,
  createOwnedUpgradeRoot,
  removeOwnedUpgradeRoot,
  uninstallNsis,
} from "./run_v031_windows_upgrade.mjs";

const absolute = (name) => path.resolve(".build", "windows-upgrade-test", name);

test("Windows upgrade gate requires official v0.3.0 and exact v0.3.1 package inputs", () => {
  const parsed = parseArguments([
    `--source-artifact=${absolute("Downany-0.3.0-win-x64.exe")}`,
    `--candidate-artifact=${absolute("Downany-0.3.1-win-x64.exe")}`,
    `--candidate-executable=${absolute("win-unpacked/Downany.exe")}`,
    `--playwright-module=${absolute("node_modules/playwright")}`,
    `--results=${absolute("v0.3.1-windows-upgrade-results.json")}`,
  ]);
  assert.equal(parsed.sourceVersion, "0.3.0");
  assert.equal(parsed.candidateVersion, "0.3.1");
  assert.equal(OFFICIAL_V030_WINDOWS_SHA256, "db2c3df75e9097573c3525c58e7a1c98ba276c29ad60faa22d6d7fef9adaa8cb");
});

test("Windows upgrade gate rejects missing, relative and ambiguous package paths", () => {
  assert.throws(() => parseArguments([]), /required/i);
  assert.throws(() => parseArguments([
    "--source-artifact=Downany-0.3.0-win-x64.exe",
    `--candidate-artifact=${absolute("Downany-0.3.1-win-x64.exe")}`,
    `--candidate-executable=${absolute("win-unpacked/Downany.exe")}`,
    `--playwright-module=${absolute("node_modules/playwright")}`,
    `--results=${absolute("results.json")}`,
  ]), /absolute/i);
  assert.throws(() => parseArguments([
    `--source-artifact=${absolute("wrong.exe")}`,
    `--candidate-artifact=${absolute("Downany-0.3.1-win-x64.exe")}`,
    `--candidate-executable=${absolute("win-unpacked/Downany.exe")}`,
    `--playwright-module=${absolute("node_modules/playwright")}`,
    `--results=${absolute("results.json")}`,
  ]), /source artifact/i);
});

test("NSIS install arguments keep the owned destination last", () => {
  const installRoot = absolute("installed/Downany");
  assert.deepEqual(installerArguments(installRoot), ["/S", "/currentuser", `/D=${installRoot}`]);
});

test("fresh Windows installation uses an isolated home and dynamic bridge", () => {
  const dataDir = absolute("fresh/downany-data");
  const homeDir = absolute("fresh/home");
  const environment = buildFreshInstallEnvironment({
    PATH: "keep",
    DOWNANY_DATA_DIR: "daily-data",
    HOME: "daily-home",
    USERPROFILE: "daily-profile",
  }, dataDir, homeDir);
  assert.equal(environment.PATH, "keep");
  assert.equal(environment.DOWNANY_DATA_DIR, dataDir);
  assert.equal(environment.DOWNANY_BRIDGE_PORT, "0");
  assert.equal(environment.HOME, homeDir);
  assert.equal(environment.USERPROFILE, homeDir);
});

test("Windows upgrade gate validates an explicit next-release candidate", () => {
  const parsed = parseArguments([
    `--source-artifact=${absolute("Downany-0.3.0-win-x64.exe")}`,
    `--candidate-artifact=${absolute("Downany-0.3.2-win-x64.exe")}`,
    `--candidate-executable=${absolute("win-unpacked/Downany.exe")}`,
    `--playwright-module=${absolute("playwright")}`,
    `--results=${absolute("results.json")}`, "--candidate-version=0.3.2",
  ]);
  assert.equal(parsed.candidateVersion, "0.3.2");
  assert.equal(parsed.sourceVersion, "0.3.0");
});


const cleanUninstallProbe = () => ({
  schemaVersion: 1, platform: "win32", arch: "x64",
  checks: [
    ...["hkcu", "hklm"].flatMap((hive) => ["32", "64"].flatMap((view) =>
      ["install", "uninstall", "protocol"].map((kind) => `registry.${hive}.${view}.${kind}`))),
    "shortcut.desktop", "shortcut.commonDesktop", "shortcut.programs", "shortcut.commonPrograms",
    "directory.localPrograms", "directory.programFiles", "directory.programFilesX86", "cache.installer", "process.downany",
  ].map((id) => ({ id, state: "absent" })),
});

function uninstallFixture(t, name = "installation") {
  const ownership = createOwnedUpgradeRoot();
  const installRoot = path.join(ownership.root, name);
  fs.mkdirSync(installRoot);
  const uninstaller = path.join(installRoot, "Uninstall Downany.exe");
  fs.writeFileSync(uninstaller, "unit-test fixture: never executable");
  // 本函数没有安装产品，只清理本测试实际创建并完整审计过的文件根。
  t.after(() => {
    if (fs.existsSync(ownership.root)) {
      assertOwnedUpgradeTree(ownership);
      fs.rmSync(ownership.root, { recursive: true, force: true });
    }
  });
  return { ownership, installRoot, uninstaller };
}

test("uninstall waits for identity removal after a successful command and reports retained cache", async (t) => {
  const fixture = uninstallFixture(t);
  let time = 0, probes = 0, commands = 0;
  const result = await uninstallNsis(fixture.installRoot, {
    ownership: fixture.ownership, timeoutMs: 20, pollIntervalMs: 2, now: () => time,
    execute: async (file, args, options) => {
      commands++;
      assert.equal(file, fixture.uninstaller);
      assert.deepEqual(args, ["/S", "/currentuser"]);
      assert.equal(options.windowsHide, true);
      fs.unlinkSync(file);
    },
    collectPreflight: async ({ timeoutMs }) => {
      assert.ok(timeoutMs > 0 && timeoutMs <= 20);
      const report = cleanUninstallProbe(); probes++;
      report.checks.find(({ id }) => id === "cache.installer").state = "present";
      if (probes === 1) report.checks.find(({ id }) => id === "registry.hkcu.64.install").state = "present";
      return report;
    },
    wait: async (milliseconds) => { time += milliseconds; },
  });
  assert.equal(commands, 1);
  assert.equal(probes, 2);
  assert.equal(result.uninstallVerified, true);
  assert.equal(result.installerCache, "retained");
  assert.equal(result.programFilesRemoved, true);
  assert.ok(result.programFileChecks.every(({ state }) => state === "absent"));
});

test("uninstall command exit zero cannot hide a remaining key program file or trigger cleanup", async (t) => {
  const fixture = uninstallFixture(t);
  const main = path.join(fixture.installRoot, "Downany.exe"); fs.writeFileSync(main, "owned sentinel");
  let time = 0, probes = 0;
  await assert.rejects(uninstallNsis(fixture.installRoot, {
    ownership: fixture.ownership, timeoutMs: 5, pollIntervalMs: 2, now: () => time,
    execute: async () => fs.unlinkSync(fixture.uninstaller),
    collectPreflight: async () => { probes++; return cleanUninstallProbe(); },
    wait: async (milliseconds) => { time += milliseconds; },
  }), /Windows uninstall verification timed out: program.main/);
  assert.equal(probes, 3);
  assert.equal(time, 5);
  assert.equal(fs.readFileSync(main, "utf8"), "owned sentinel");
});

test("remaining uninstaller self-delete helper must clear within the bounded wait", async (t) => {
  const fixture = uninstallFixture(t);
  let probes = 0, time = 0;
  const result = await uninstallNsis(fixture.installRoot, {
    ownership: fixture.ownership, timeoutMs: 20, now: () => time, pollIntervalMs: 2,
    execute: async () => {},
    collectPreflight: async () => {
      if (++probes === 2) fs.unlinkSync(fixture.uninstaller);
      return cleanUninstallProbe();
    },
    wait: async (milliseconds) => { time += milliseconds; },
  });
  assert.equal(probes, 2);
  assert.equal(result.uninstallVerified, true);
});

test("uninstall refuses unreadable identity or incomplete reports and retains owned evidence", async (t) => {
  for (const mode of ["unreadable", "incomplete"]) {
    const fixture = uninstallFixture(t, mode);
    const report = cleanUninstallProbe();
    if (mode === "unreadable") report.checks.find(({ id }) => id === "registry.hkcu.64.protocol").state = "error";
    else report.checks.pop();
    await assert.rejects(uninstallNsis(fixture.installRoot, {
      ownership: fixture.ownership, execute: async () => fs.unlinkSync(fixture.uninstaller),
      collectPreflight: async () => report,
    }), /uninstall verification (?:unavailable|blocked)/);
    assert.ok(fs.existsSync(fixture.ownership.root));
  }
});

test("a missing uninstaller never produces verified uninstall evidence", async (t) => {
  const fixture = uninstallFixture(t); fs.unlinkSync(fixture.uninstaller);
  let executions = 0;
  await assert.rejects(uninstallNsis(fixture.installRoot, {
    ownership: fixture.ownership, execute: async () => { executions++; },
  }), /Required uninstaller/);
  assert.equal(executions, 0);
});

test("owned-root cleanup requires two verified uninstalls and refuses unknown roots", (t) => {
  const fixture = uninstallFixture(t);
  for (const reports of [[], [{ uninstallVerified: true, programFilesRemoved: true }], [
    { uninstallVerified: true, programFilesRemoved: true }, { uninstallVerified: false, programFilesRemoved: true },
  ]]) {
    assert.throws(() => removeOwnedUpgradeRoot(fixture.ownership, reports), /Verified.*uninstalls/);
    assert.equal(fs.readFileSync(fixture.uninstaller, "utf8"), "unit-test fixture: never executable");
  }
  const passed = [{ uninstallVerified: true, programFilesRemoved: true }, { uninstallVerified: true, programFilesRemoved: true }];
  assert.throws(() => removeOwnedUpgradeRoot({ root: os.tmpdir() }, passed), /ownership is unknown/);
});

test("uninstall refuses an installation path outside the owned root before executing", async (t) => {
  const fixture = uninstallFixture(t);
  let executions = 0;
  await assert.rejects(uninstallNsis(path.dirname(fixture.ownership.root), {
    ownership: fixture.ownership, execute: async () => { executions++; },
  }), /escaped its owned root/);
  assert.equal(executions, 0);
});

test("reparse-point risk stops recursive cleanup before any deletion", (t) => {
  const fixture = uninstallFixture(t);
  const realLstat = fs.lstatSync;
  const mock = t.mock.method(fs, "lstatSync", (file, ...args) => {
    const stat = realLstat(file, ...args);
    return path.resolve(file) === fixture.installRoot ? Object.assign(Object.create(stat), { isSymbolicLink: () => true }) : stat;
  });
  const passed = [{ uninstallVerified: true, programFilesRemoved: true }, { uninstallVerified: true, programFilesRemoved: true }];
  try {
    assert.throws(() => removeOwnedUpgradeRoot(fixture.ownership, passed), /reparse point|redirected path/);
    assert.equal(fs.readFileSync(fixture.uninstaller, "utf8"), "unit-test fixture: never executable");
  } finally { mock.mock.restore(); }
});

test("verified uninstall permits cleanup only of its unchanged owned tree", async (t) => {
  const fixture = uninstallFixture(t);
  const result = await uninstallNsis(fixture.installRoot, {
    ownership: fixture.ownership, execute: async () => fs.unlinkSync(fixture.uninstaller),
    collectPreflight: async () => cleanUninstallProbe(),
  });
  removeOwnedUpgradeRoot(fixture.ownership, [result, result]);
  assert.equal(fs.existsSync(fixture.ownership.root), false);
});


test("a real owned junction cannot delete an external sentinel during cleanup", (t) => {
  const fixture = uninstallFixture(t);
  const external = createOwnedUpgradeRoot();
  const sentinel = path.join(external.root, "sentinel.txt");
  fs.writeFileSync(sentinel, "outside owned installation root");
  const hash = () => createHash("sha256").update(fs.readFileSync(sentinel)).digest("hex");
  const before = hash();
  const junction = path.join(fixture.ownership.root, "redirected-directory");
  t.after(() => {
    assertOwnedUpgradeTree(external);
    fs.rmSync(external.root, { recursive: true, force: true });
  });
  fs.symlinkSync(external.root, junction, process.platform === "win32" ? "junction" : "dir");
  const passed = [{ uninstallVerified: true, programFilesRemoved: true }, { uninstallVerified: true, programFilesRemoved: true }];
  try {
    assert.ok(fs.lstatSync(junction).isSymbolicLink());
    assert.equal(fs.realpathSync(junction), external.root);
    assert.throws(() => removeOwnedUpgradeRoot(fixture.ownership, passed), /reparse point|redirected path/);
    assert.equal(hash(), before);
    assert.equal(fs.readFileSync(fixture.uninstaller, "utf8"), "unit-test fixture: never executable");
  } finally {
    // 已验证的链接位于本测试根内；非递归移除链接，不遍历目标。
    assert.ok(fs.lstatSync(junction).isSymbolicLink());
    assert.equal(fs.realpathSync(junction), external.root);
    if (process.platform === "win32") fs.rmdirSync(junction);
    else fs.unlinkSync(junction);
    assert.equal(hash(), before);
  }
});


test("a probe completing after its deadline cannot certify bounded uninstall", async (t) => {
  const fixture = uninstallFixture(t);
  let time = 0;
  await assert.rejects(uninstallNsis(fixture.installRoot, {
    ownership: fixture.ownership, timeoutMs: 5, now: () => time,
    execute: async () => fs.unlinkSync(fixture.uninstaller),
    collectPreflight: async () => { time = 6; return cleanUninstallProbe(); },
  }), /exceeded its wait bound/);
  assert.ok(fs.existsSync(fixture.ownership.root));
});
