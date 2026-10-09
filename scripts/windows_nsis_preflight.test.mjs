import assert from "node:assert/strict";
import test from "node:test";

import { run } from "./run_v031_windows_upgrade.mjs";
import { assertWindowsNsisPreflight, collectWindowsNsisPreflight } from "./windows_nsis_preflight.mjs";

const REGISTRY_IDS = ["hkcu", "hklm"].flatMap((hive) => ["32", "64"].flatMap((view) =>
  ["install", "uninstall", "protocol"].map((kind) => `registry.${hive}.${view}.${kind}`)));
const FILE_IDS = [
  "shortcut.desktop", "shortcut.commonDesktop", "shortcut.programs", "shortcut.commonPrograms",
  "directory.localPrograms", "directory.programFiles", "directory.programFilesX86", "cache.installer",
];
const IDS = [...REGISTRY_IDS, ...FILE_IDS, "process.downany"];
const cleanReport = () => ({ schemaVersion: 1, platform: "win32", arch: "x64", checks: IDS.map((id) => ({ id, state: "absent" })) });

// Removing/reordering the actual run() preflight must expose the poisoned inputs.
test("upgrade gate rejects existing installation before reading installer inputs or starting cleanup", async () => {
  const report = cleanReport();
  report.checks.find((item) => item.id === "registry.hklm.64.install").state = "present";
  report.checks.find((item) => item.id === "registry.hkcu.64.protocol").state = "present";
  let inputReads = 0;
  const options = new Proxy({}, { get() { inputReads++; throw new Error("Installer inputs reached before preflight rejection"); } });
  await assert.rejects(run(options, { collectPreflight: async () => report }), /Windows installer preflight blocked/);
  assert.equal(inputReads, 0);
});


test("only a complete all-absent Windows x64 report permits installation", () => {
  assert.deepEqual(assertWindowsNsisPreflight(cleanReport()), cleanReport());
});

for (const id of IDS) {
  test(`preflight blocks an existing or unreadable ${id}`, () => {
    for (const state of ["present", "error"]) {
      const report = cleanReport();
      report.checks.find((item) => item.id === id).state = state;
      assert.throws(() => assertWindowsNsisPreflight(report), /Windows installer preflight blocked/);
    }
  });
}

for (const [name, alter] of [
  ["no report", () => undefined],
  ["wrong platform", (r) => ({ ...r, platform: "darwin" })],
  ["wrong architecture", (r) => ({ ...r, arch: "arm64" })],
  ["wrong schema", (r) => ({ ...r, schemaVersion: 2 })],
  ["empty checks", (r) => ({ ...r, checks: [] })],
  ["missing registry view", (r) => ({ ...r, checks: r.checks.slice(1) })],
  ["duplicate replacing a required check", (r) => ({ ...r, checks: [r.checks[1], ...r.checks.slice(1)] })],
  ["unknown check", (r) => ({ ...r, checks: [...r.checks, { id: "other", state: "absent" }] })],
  ["unknown state", (r) => ({ ...r, checks: [{ ...r.checks[0], state: "unknown" }, ...r.checks.slice(1)] })],
  ["non-boolean absence", (r) => ({ ...r, checks: [{ ...r.checks[0], state: false }, ...r.checks.slice(1)] })],
  ["raw registry value", (r) => ({ ...r, checks: [{ ...r.checks[0], value: "PRIVATE_SENTINEL" }, ...r.checks.slice(1)] })],
  ["raw extra output", (r) => ({ ...r, error: "PRIVATE_SENTINEL" })],
]) {
  test(`preflight refuses ${name} without echoing untrusted data`, () => {
    assert.throws(() => assertWindowsNsisPreflight(alter(cleanReport())), (error) => {
      assert.match(error.message, /Windows installer preflight blocked/);
      assert.ok(!error.message.includes("PRIVATE_SENTINEL"));
      return true;
    });
  });
}

const wireReport = () => ({ ...cleanReport(), checks: IDS.map((id) => id.startsWith("registry.") ? { id, win32Code: 2 } : { id, state: "absent" }) });

const collect = (runPowerShell) => collectWindowsNsisPreflight({ platform: "win32", arch: "x64", systemRoot: "C:\\Windows", runPowerShell });

test("collector invokes bounded noninteractive PowerShell and returns only the fixed probe report", async () => {
  let invocation;
  const report = await collect(async (file, args, options) => {
    invocation = { file, args, options };
    return { stdout: JSON.stringify(wireReport()), stderr: "" };
  });
  assert.deepEqual(report, cleanReport());
  assert.equal(invocation.file, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(invocation.args.slice(0, -1), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
  assert.ok(Buffer.from(invocation.args.at(-1), "base64").toString("utf16le").length > 0);
  assert.equal(invocation.options.windowsHide, true);
  assert.equal(invocation.options.shell, false);
  assert.ok(invocation.options.timeout > 0 && invocation.options.timeout <= 30_000);
  assert.ok(invocation.options.maxBuffer <= 128 * 1024);
});

test("collector keeps a fixed error state for guard rejection instead of inventing absence", async () => {
  const expected = wireReport(); expected.checks[0].win32Code = 5;
  const actual = await collect(async () => ({ stdout: JSON.stringify(expected), stderr: "" }));
  assert.equal(actual.checks[0].state, "error");
  assert.throws(() => assertWindowsNsisPreflight(actual), /Windows installer preflight blocked/);
});

for (const [name, result] of [
  ["empty output", { stdout: "", stderr: "" }],
  ["broken JSON", { stdout: "PRIVATE_SENTINEL", stderr: "" }],
  ["missing fields", { stdout: "{}", stderr: "" }],
  ["stderr despite exit zero", { stdout: JSON.stringify(wireReport()), stderr: "PRIVATE_SENTINEL" }],
]) {
  test(`collector refuses ${name}`, async () => {
    await assert.rejects(collect(async () => result), (error) => {
      assert.match(error.message, /Windows installer preflight unavailable/);
      assert.ok(!error.message.includes("PRIVATE_SENTINEL"));
      return true;
    });
  });
}

test("collector refuses a failed, timed out, or missing PowerShell process without raw diagnostics", async () => {
  for (const code of [1, "ETIMEDOUT", "ENOENT"]) {
    await assert.rejects(collect(async () => { throw Object.assign(new Error("PRIVATE_SENTINEL"), { code }); }), (error) => {
      assert.match(error.message, /Windows installer preflight unavailable/);
      assert.ok(!error.message.includes("PRIVATE_SENTINEL")); return true;
    });
  }
});

test("collector does not launch anything for unsupported hosts", async () => {
  let calls = 0;
  for (const host of [{ platform: "darwin", arch: "arm64" }, { platform: "win32", arch: "ia32" }]) {
    await assert.rejects(collectWindowsNsisPreflight({ ...host, runPowerShell: async () => { calls++; } }), /Windows installer preflight unavailable/);
  }
  assert.equal(calls, 0);
});

test("upgrade gate propagates probe failure before any installer input access", async () => {
  let reads = 0;
  const options = new Proxy({}, { get() { reads++; throw new Error("Unsafe installer access"); } });
  await assert.rejects(run(options, { collectPreflight: async () => { throw new Error("Windows installer preflight unavailable"); } }), /preflight unavailable/);
  assert.equal(reads, 0);
});

test("Windows read-only probe produces a complete classified report", { skip: process.platform !== "win32" || process.arch !== "x64" }, async () => {
  const report = await collectWindowsNsisPreflight();
  assert.deepEqual(report.checks.map((item) => item.id).sort(), [...IDS].sort());
  assert.ok(report.checks.every((item) => ["absent", "present", "error"].includes(item.state)));
});


test("registry absence requires native ERROR_FILE_NOT_FOUND or ERROR_PATH_NOT_FOUND", async () => {
  for (const [win32Code, state] of [[0, "present"], [2, "absent"], [3, "absent"], [5, "error"], [6, "error"], [8, "error"], [87, "error"], [1114, "error"], [-1, "error"]]) {
    const wire = wireReport(); wire.checks[0].win32Code = win32Code;
    const report = await collect(async () => ({ stdout: JSON.stringify(wire), stderr: "" }));
    assert.deepEqual(report.checks[0], { id: "registry.hkcu.32.install", state });
    if (state === "absent") assert.doesNotThrow(() => assertWindowsNsisPreflight(report));
    else assert.throws(() => assertWindowsNsisPreflight(report), /preflight blocked/);
  }
});

test("collector refuses ambiguous registry states and non-integer native return codes", async () => {
  for (const check of [
    { id: "registry.hkcu.32.install", state: "absent" },
    ...[null, "2", true, 2.5].map((win32Code) => ({ id: "registry.hkcu.32.install", win32Code })),
  ]) {
    const wire = wireReport(); wire.checks[0] = check;
    await assert.rejects(collect(async () => ({ stdout: JSON.stringify(wire), stderr: "" })), /preflight unavailable/);
  }
});

test("collector disables module progress before native compilation or CIM lookup", async () => {
  let command;
  await collect(async (_file, args) => {
    command = Buffer.from(args.at(-1), "base64").toString("utf16le");
    return { stdout: JSON.stringify(wireReport()), stderr: "" };
  });
  const preference = command.search(/^\$ProgressPreference\s*=\s*'SilentlyContinue'\s*$/m);
  const firstModuleCall = command.search(/^(?:Add-Type|\s*\$processes = @\(Get-CimInstance)\b/m);
  assert.ok(preference >= 0, "PowerShell command must silence progress records");
  assert.ok(firstModuleCall > preference, "Progress must be silenced before modules load");
});
