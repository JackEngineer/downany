import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";

import * as smokeHelpers from "./package_smoke_helpers.mjs";

import {
  DIAGNOSTIC_ZIP_MEMBERS,
  assertBridgeUnused,
  assertDiagnosticZipMembers,
  assertSmokeTaskVisible,
  enqueueSmokeTask,
  listZipEntries,
  readZipEntry,
  waitForBridgeReady,
} from "./package_smoke_helpers.mjs";

test("isolates smoke data, updates and protocol registration without changing the parent environment", () => {
  const inherited = { PATH: "tools", DOWNANY_DATA_DIR: "real-data", DOWNANY_SKIP_PROTOCOL_REGISTRATION: "0" };
  assert.deepEqual(smokeHelpers.buildPackagedSmokeEnvironment(inherited, "D:/isolated-data"), {
    PATH: "tools", DOWNANY_DATA_DIR: "D:/isolated-data",
    DOWNANY_UPDATE_DISABLED: "1", DOWNANY_SKIP_PROTOCOL_REGISTRATION: "1",
  });
  assert.equal(inherited.DOWNANY_DATA_DIR, "real-data");
  assert.equal(inherited.DOWNANY_SKIP_PROTOCOL_REGISTRATION, "0");
});

function smokeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "downany-smoke-helper-"));
  t.after(() => {
    const resolved = fs.realpathSync(root);
    const relative = path.relative(fs.realpathSync(os.tmpdir()), resolved);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    assert.ok(path.basename(resolved).startsWith("downany-smoke-helper-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return root;
}

test("creates first-use configuration with output inside its isolated data root", (t) => {
  const root = smokeFixture(t);
  const prepared = smokeHelpers.prepareSmokeData(root);
  const config = JSON.parse(fs.readFileSync(path.join(prepared.dataDir, "config.json"), "utf8"));
  assert.equal(prepared.dataDir, path.join(root, "downany-data"));
  assert.equal(prepared.outputDir, path.join(root, "output"));
  assert.equal(config.download_dir, prepared.outputDir);
  assert.ok(fs.statSync(prepared.outputDir).isDirectory());
});

test("marks legacy migrations complete before a packaged smoke can import user data", (t) => {
  const root = smokeFixture(t);
  const prepared = smokeHelpers.prepareSmokeData(root);

  assert.equal(
    fs.readFileSync(path.join(prepared.dataDir, ".migration_v1_done"), "utf8"),
    "ok\n",
  );
  assert.equal(
    fs.readFileSync(
      path.join(prepared.dataDir, ".migration_videodownloader_done"),
      "utf8",
    ),
    "ok\n",
  );
});

test("preserves an existing safe smoke configuration byte for byte", (t) => {
  const root = smokeFixture(t);
  const dataDir = path.join(root, "downany-data");
  const outputDir = path.join(root, "custom-output");
  fs.mkdirSync(dataDir);
  const original = JSON.stringify({ download_dir: outputDir, theme_mode: "light", extra: "keep-me" });
  fs.writeFileSync(path.join(dataDir, "config.json"), original);
  assert.deepEqual(smokeHelpers.prepareSmokeData(root), { dataDir, outputDir });
  assert.equal(fs.readFileSync(path.join(dataDir, "config.json"), "utf8"), original);
});

test("refuses existing missing or escaping output paths without overwriting settings", (t) => {
  for (const config of [{ extra: "keep-me" }, { download_dir: "relative/output" }, { download_dir: os.tmpdir() }]) {
    const root = smokeFixture(t);
    const dataDir = path.join(root, "downany-data");
    fs.mkdirSync(dataDir);
    const original = JSON.stringify(config);
    fs.writeFileSync(path.join(dataDir, "config.json"), original);
    assert.throws(() => smokeHelpers.prepareSmokeData(root), /isolated|absolute/i);
    assert.equal(fs.readFileSync(path.join(dataDir, "config.json"), "utf8"), original);
  }
});

test("rejects an output directory junction that escapes the isolated root", { skip: process.platform !== "win32" }, (t) => {
  const root = smokeFixture(t);
  const outside = smokeFixture(t);
  fs.symlinkSync(outside, path.join(root, "output"), "junction");
  assert.throws(() => smokeHelpers.prepareSmokeData(root), /isolated/i);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("rejects a browser profile junction before creating smoke configuration", { skip: process.platform !== "win32" }, (t) => {
  const root = smokeFixture(t);
  const outside = smokeFixture(t);
  fs.symlinkSync(outside, path.join(root, "electron-user-data"), "junction");
  assert.throws(() => smokeHelpers.prepareSmokeData(root), /isolated/i);
  assert.equal(fs.existsSync(path.join(root, "downany-data", "config.json")), false);
  assert.deepEqual(fs.readdirSync(outside), []);
});

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

function refused() {
  return Object.assign(new TypeError("fetch failed"), {
    cause: { code: "ECONNREFUSED" },
  });
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessToDisappear(pid, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (processExists(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !processExists(pid);
}

async function stopControlledProcess(pid) {
  if (!pid || !processExists(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  await waitForProcessToDisappear(pid);
}

test(
  "stops a detached Windows descendant before losing the parent tree",
  { skip: process.platform !== "win32", timeout: 10_000 },
  async (t) => {
    const descendantProgram = "setInterval(() => {}, 1000)";
    const parentProgram = [
      "const { spawn } = require('node:child_process');",
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantProgram)}], { stdio: 'ignore', windowsHide: true, detached: true });`,
      "child.unref();",
      "process.stdout.write(String(child.pid) + '\\n');",
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const parent = spawn(process.execPath, ["-e", parentProgram], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    parent.stdout.setEncoding("utf8");

    let descendantPid = 0;
    t.after(async () => {
      await stopControlledProcess(descendantPid);
      await stopControlledProcess(parent.pid);
    });

    descendantPid = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("controlled parent did not report its child PID")),
        2_000,
      );
      parent.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      parent.stdout.once("data", (chunk) => {
        clearTimeout(timer);
        resolve(Number(String(chunk).trim()));
      });
    });
    assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);

    await smokeHelpers.stopChildProcessTree(parent, {
      platform: "win32",
      timeoutMs: 2_000,
    });

    assert.equal(await waitForProcessToDisappear(parent.pid), true);
    assert.equal(await waitForProcessToDisappear(descendantPid), true);
  },
);

test("falls back to the owned Windows process handle when taskkill cannot start", async () => {
  const child = new EventEmitter();
  child.pid = 123;
  child.exitCode = null;
  child.signalCode = null;
  child.killCalls = 0;
  child.kill = () => {
    child.killCalls += 1;
    child.exitCode = 0;
    queueMicrotask(() => child.emit("exit", 0, null));
    return true;
  };

  await smokeHelpers.stopChildProcessTree(child, {
    platform: "win32",
    spawnProcess: () => {
      throw new Error("taskkill is unavailable");
    },
    timeoutMs: 25,
  });

  assert.equal(child.killCalls, 1);
  assert.equal(child.exitCode, 0);
});

test("falls back to the owned Windows process handle when taskkill emits a spawn error", async () => {
  const child = new EventEmitter();
  child.pid = 123;
  child.exitCode = null;
  child.signalCode = null;
  child.killCalls = 0;
  child.kill = () => {
    child.killCalls += 1;
    child.exitCode = 0;
    queueMicrotask(() => child.emit("exit", 0, null));
    return true;
  };

  await smokeHelpers.stopChildProcessTree(child, {
    platform: "win32",
    spawnProcess: () =>
      spawn(`${process.execPath}.downany-nonexistent-command`, [], {
        stdio: "ignore",
        windowsHide: true,
      }),
    timeoutMs: 1_000,
  });

  assert.equal(child.killCalls, 1);
  assert.equal(child.exitCode, 0);
});

test("reports a failed taskkill when a Windows child is still running", async () => {
  const child = new EventEmitter();
  child.pid = 456;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => false;

  await assert.rejects(
    () =>
      smokeHelpers.stopChildProcessTree(child, {
        platform: "win32",
        spawnProcess: () => {
          const killer = new EventEmitter();
          killer.exitCode = null;
          killer.signalCode = null;
          killer.kill = () => true;
          queueMicrotask(() => {
            killer.exitCode = 1;
            killer.emit("exit", 1, null);
          });
          return killer;
        },
        timeoutMs: 1,
      }),
    /taskkill.*1.*still running/i,
  );
});

function zipFixture(entries, { encrypted = false } = {}) {
  const locals = [];
  const centrals = [];
  let localOffset = 0;
  for (const entry of entries) {
    const rawName =
      entry && typeof entry === "object" && !Buffer.isBuffer(entry)
        ? entry.name
        : entry;
    const name = Buffer.isBuffer(rawName) ? rawName : Buffer.from(rawName, "utf8");
    const data =
      entry && typeof entry === "object" && !Buffer.isBuffer(entry)
        ? Buffer.from(entry.data || "", "utf8")
        : Buffer.alloc(0);
    const method =
      entry &&
      typeof entry === "object" &&
      !Buffer.isBuffer(entry) &&
      entry.compression === "deflate"
        ? 8
        : 0;
    const compressed = method === 8 ? deflateRawSync(data) : data;
    const flags = 0x0800 | (encrypted ? 0x0001 : 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centrals.push(central, name);
    localOffset += local.length + name.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...locals, centralDirectory, end]);
}

test("bridge preflight accepts only a refused local connection", async () => {
  await assert.doesNotReject(() =>
    assertBridgeUnused(async () => {
      throw refused();
    }),
  );
  await assert.rejects(
    () => assertBridgeUnused(async () => jsonResponse(200, { ok: true })),
    /already responding/i,
  );
  await assert.rejects(
    () =>
      assertBridgeUnused(async () => {
        throw new Error("certificate failure");
      }),
    /could not prove.*unused/i,
  );
});

test("waits through connection refusal and sidecar startup until bridge is ready", async () => {
  const responses = [
    refused(),
    jsonResponse(200, {
      ok: true,
      service: "downany-bridge",
      sidecarReady: false,
    }),
    jsonResponse(200, {
      ok: true,
      service: "downany-bridge",
      sidecarReady: true,
    }),
  ];
  const health = await waitForBridgeReady({
    fetchImpl: async () => {
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    child: { exitCode: null, signalCode: null },
    timeoutMs: 1_000,
    pollIntervalMs: 0,
    sleep: async () => undefined,
    getStderr: () => "",
  });

  assert.equal(health.sidecarReady, true);
  assert.equal(responses.length, 0);
});

test("stops waiting when packaged Electron exits before bridge readiness", async () => {
  await assert.rejects(
    () =>
      waitForBridgeReady({
        fetchImpl: async () => {
          throw refused();
        },
        child: { exitCode: 9, signalCode: null },
        timeoutMs: 1_000,
        pollIntervalMs: 0,
        sleep: async () => undefined,
        getStderr: () => "fixture stderr",
      }),
    /exited.*9.*fixture stderr/i,
  );
});

test("enqueue and task lookup prove the same non-unknown task", async () => {
  const requests = [];
  const taskId = await enqueueSmokeTask({
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return jsonResponse(200, { ok: true, count: 1, taskIds: ["task-1"] });
    },
  });
  await assertSmokeTaskVisible({
    taskId,
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return jsonResponse(200, {
        ok: true,
        tasks: [{ id: "task-1", status: "pending", progress: 0 }],
      });
    },
  });

  assert.equal(taskId, "task-1");
  assert.equal(requests[0].url, "http://127.0.0.1:17888/enqueue");
  assert.equal(requests[0].options.method, "POST");
  const payload = JSON.parse(requests[0].options.body);
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].url, "http://127.0.0.1:17888/downany-package-smoke");
  assert.equal(
    requests[1].url,
    "http://127.0.0.1:17888/tasks?ids=task-1",
  );
});

test("task lookup rejects unknown or mismatched tasks", async () => {
  await assert.rejects(
    () =>
      assertSmokeTaskVisible({
        taskId: "task-1",
        fetchImpl: async () =>
          jsonResponse(200, {
            ok: true,
            tasks: [{ id: "task-1", status: "unknown" }],
          }),
      }),
    /unknown/i,
  );
  await assert.rejects(
    () =>
      assertSmokeTaskVisible({
        taskId: "task-1",
        fetchImpl: async () =>
          jsonResponse(200, {
            ok: true,
            tasks: [{ id: "other", status: "pending" }],
          }),
      }),
    /task-1/i,
  );
});

test("reads the exact privacy-safe diagnostic ZIP members", () => {
  const archive = zipFixture(DIAGNOSTIC_ZIP_MEMBERS);
  assert.deepEqual(listZipEntries(archive), DIAGNOSTIC_ZIP_MEMBERS);
  assert.deepEqual(assertDiagnosticZipMembers(archive), DIAGNOSTIC_ZIP_MEMBERS);
  assert.throws(
    () => assertDiagnosticZipMembers(zipFixture(DIAGNOSTIC_ZIP_MEMBERS.slice(1))),
    /diagnostic ZIP members.*environment\.json/i,
  );
  assert.throws(
    () => assertDiagnosticZipMembers(zipFixture([...DIAGNOSTIC_ZIP_MEMBERS, "raw.log"])),
    /diagnostic ZIP members.*raw\.log/i,
  );
});

test("reads one bounded stored diagnostic member", () => {
  const environment = JSON.stringify({ ffmpeg_available: true });
  const archive = zipFixture([
    { name: "environment.json", data: environment },
  ]);

  assert.equal(readZipEntry(archive, "environment.json").toString("utf8"), environment);
  assert.throws(() => readZipEntry(archive, "missing.json"), /missing/i);
  assert.throws(
    () => readZipEntry(archive, "environment.json", { maxBytes: 4 }),
    /byte limit/i,
  );
});

test("reads one bounded deflated diagnostic member", () => {
  const environment = JSON.stringify({
    ffmpeg_available: true,
    ffprobe_available: true,
  });
  const archive = zipFixture([
    { name: "environment.json", data: environment, compression: "deflate" },
  ]);

  assert.equal(readZipEntry(archive, "environment.json").toString("utf8"), environment);
});

test("rejects truncated, duplicate, encrypted, invalid UTF-8, and overflowing ZIP metadata", () => {
  const valid = zipFixture(DIAGNOSTIC_ZIP_MEMBERS);
  assert.throws(() => listZipEntries(valid.subarray(0, valid.length - 5)), /end record/i);
  assert.throws(
    () => listZipEntries(zipFixture(["privacy.json", "privacy.json"])),
    /duplicate/i,
  );
  assert.throws(
    () => listZipEntries(zipFixture(["privacy.json"], { encrypted: true })),
    /encrypted/i,
  );
  assert.throws(
    () => listZipEntries(zipFixture([Buffer.from([0xff])])),
    /UTF-8/i,
  );

  const overflowing = Buffer.from(valid);
  overflowing.writeUInt32LE(0xfffffffe, overflowing.length - 10);
  assert.throws(() => listZipEntries(overflowing), /bounds/i);

  const mismatchedLocalName = zipFixture(["privacy.json"]);
  mismatchedLocalName[30] = "x".charCodeAt(0);
  assert.throws(() => listZipEntries(mismatchedLocalName), /local.*name/i);
});
