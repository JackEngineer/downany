import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Missing helpers must fail as an assertion during the first red run.
let gate = {};
try {
  gate = await import("./windows_real_download_helpers.mjs");
} catch (error) {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
}

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "downany-gate-unit-"));
  t.after(() => {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("downany-gate-unit-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return root;
}

test("gate setup isolates every output and disables accounts and side effects", (t) => {
  assert.equal(typeof gate.prepareDownloadGateRoot, "function");
  const root = temporaryRoot(t);
  const result = gate.prepareDownloadGateRoot(root);
  const settings = JSON.parse(fs.readFileSync(path.join(result.dataDir, "config.json")));
  assert.equal(settings.download_dir, path.join(root, "output"));
  assert.equal(settings.clipboard_monitor, false);
  assert.equal(settings.telegram_auto_send_enabled, false);
  assert.equal(settings.cookies_from_browser, "");
  assert.equal(settings.telemetry_enabled, false);
  assert.equal(settings.auto_start_downloads, true);
  assert.equal(settings.embed_metadata, true);
  assert.equal(result.profileDir, path.join(root, "electron-profile"));
  for (const directory of [result.dataDir, result.outputDir, result.profileDir]) {
    assert.ok(fs.statSync(directory).isDirectory());
    assert.ok(directory.startsWith(root + path.sep));
  }
});

test("gate setup refuses existing data without changing it", (t) => {
  assert.equal(typeof gate.prepareDownloadGateRoot, "function");
  const root = temporaryRoot(t);
  const original = path.join(root, "config.json");
  fs.writeFileSync(original, "do not overwrite");
  assert.throws(() => gate.prepareDownloadGateRoot(root), /empty/i);
  assert.equal(fs.readFileSync(original, "utf8"), "do not overwrite");
  assert.deepEqual(fs.readdirSync(root), ["config.json"]);
});

test("gate environment cannot inherit development tools or protocol registration", () => {
  assert.equal(typeof gate.buildDownloadGateEnvironment, "function");
  const inherited = {
    PATH: "keep", NODE_OPTIONS: "--no-experimental-webstorage", ELECTRON_RUN_AS_NODE: "1",
    DOWNANY_BIN_DIR: "wrong-tools", VIDEODL_DATA_DIR: "daily-data",
    DOWNANY_SKIP_PROTOCOL_REGISTRATION: "0", VITE_DEV_SERVER_URL: "http://wrong-app",
    HTTPS_PROXY: "http://127.0.0.1:7897", NO_PROXY: "example.invalid",
  };
  const env = gate.buildDownloadGateEnvironment(inherited, path.resolve("isolated"));
  assert.equal(env.PATH, "keep");
  assert.equal(env.DOWNANY_DATA_DIR, path.resolve("isolated"));
  assert.equal(env.DOWNANY_UPDATE_DISABLED, "1");
  assert.equal(env.DOWNANY_SKIP_PROTOCOL_REGISTRATION, "1");
  for (const key of ["NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "DOWNANY_BIN_DIR", "VIDEODL_DATA_DIR", "VITE_DEV_SERVER_URL"]) {
    assert.equal(env[key], undefined);
  }
  assert.equal(env.HTTPS_PROXY, inherited.HTTPS_PROXY);
  assert.ok(env.NO_PROXY.split(",").includes("127.0.0.1"));
  assert.ok(env.NO_PROXY.split(",").includes("localhost"));
  assert.equal(inherited.DOWNANY_SKIP_PROTOCOL_REGISTRATION, "0");
});

function outputFixture(t) {
  const output = temporaryRoot(t);
  const file = path.join(output, "movie.mp4");
  fs.writeFileSync(file, Buffer.from([1, 2, 3, 4]));
  return { output, task: { id: "fixture", status: "completed", progress: 100,
    file_path: file, downloaded_bytes: 4, total_bytes: 4 } };
}

test("completion validation ties the task to a nonempty isolated file and exact bytes", (t) => {
  assert.equal(typeof gate.assertCompletedDownload, "function");
  const { output, task } = outputFixture(t);
  const result = gate.assertCompletedDownload(task, output);
  assert.equal(result.path, task.file_path);
  assert.equal(result.bytes, 4);
  assert.equal(result.sha256, "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a");
});

for (const [name, patch] of [
  ["unfinished state", { status: "downloading" }],
  ["incomplete progress", { progress: 99 }],
  ["incorrect downloaded bytes", { downloaded_bytes: 3 }],
  ["incorrect total bytes", { total_bytes: 5 }],
]) {
  test(`completion validation rejects ${name}`, (t) => {
    assert.equal(typeof gate.assertCompletedDownload, "function");
    const { output, task } = outputFixture(t);
    assert.throws(() => gate.assertCompletedDownload({ ...task, ...patch }, output));
  });
}

test("completion validation refuses files outside the isolated output directory", (t) => {
  assert.equal(typeof gate.assertCompletedDownload, "function");
  const { task } = outputFixture(t);
  const elsewhere = temporaryRoot(t);
  assert.throws(() => gate.assertCompletedDownload(task, elsewhere), /outside/i);
});

const validProbe = {
  format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "60.0" },
  streams: [
    { codec_type: "video", codec_name: "h264", width: 854, height: 480, disposition: { attached_pic: 0 } },
    { codec_type: "audio", codec_name: "aac", sample_rate: "44100", channels: 2 },
  ],
};

test("media validation requires playable video and audio, not just a cover", () => {
  assert.equal(typeof gate.validateMediaProbe, "function");
  assert.equal(gate.validateMediaProbe(validProbe).durationSeconds, 60);
  const coverOnly = structuredClone(validProbe);
  coverOnly.streams[0].disposition.attached_pic = 1;
  assert.throws(() => gate.validateMediaProbe(coverOnly), /video/i);
  assert.throws(() => gate.validateMediaProbe({ ...validProbe, streams: validProbe.streams.slice(0, 1) }), /audio/i);
  assert.throws(() => gate.validateMediaProbe({ ...validProbe, format: { duration: "NaN" } }), /duration/i);
});

test("task waiting stops immediately at a terminal failure", async () => {
  assert.equal(typeof gate.waitForTask, "function");
  let reads = 0;
  await assert.rejects(gate.waitForTask(async () => {
    reads += 1;
    return { id: "failed-task", status: "failed", error_code: "network" };
  }, (task) => task?.status === "completed", { timeoutMs: 500 }), /failed-task.*failed/);
  assert.equal(reads, 1);
});

test("task waiting can explicitly expect failure and handles eventual completion", async () => {
  assert.equal(typeof gate.waitForTask, "function");
  assert.equal((await gate.waitForTask(async () => ({ status: "failed" }),
    (task) => task?.status === "failed")).status, "failed");
  const states = [null, { status: "downloading" }, { status: "completed" }];
  const final = await gate.waitForTask(async () => states.shift(),
    (task) => task?.status === "completed", { pollIntervalMs: 1, timeoutMs: 500 });
  assert.equal(final.status, "completed");
});

test("task waiting has a bounded deadline even when no task appears", async () => {
  assert.equal(typeof gate.waitForTask, "function");
  await assert.rejects(gate.waitForTask(async () => null, () => false,
    { timeoutMs: 10, pollIntervalMs: 1 }), /timed out/i);
});

const requiredArguments = [
  `--executable=${path.resolve("Downany.exe")}`,
  `--playwright-module=${path.resolve("playwright")}`,
];

test("default gate requires the complete external and recovery suite", () => {
  assert.equal(typeof gate.parseGateArguments, "function");
  assert.throws(() => gate.parseGateArguments(requiredArguments), /browser.*extension/i);
  const options = gate.parseGateArguments([...requiredArguments,
    `--browser-executable=${path.resolve("chrome.exe")}`, `--extension-dir=${path.resolve("extension")}`]);
  assert.equal(options.suite, "all");
  assert.equal(options.expectedVersion, "0.3.0");
  assert.deepEqual(options.expectedCases, ["public-direct", "public-extension", "failed-task-retry",
    "pause-restart-resume", "network-interruption-recovery"]);
});

test("partial diagnostics explicitly record their reduced scope", () => {
  assert.equal(typeof gate.parseGateArguments, "function");
  const direct = gate.parseGateArguments([...requiredArguments, "--suite=public-direct"]);
  assert.deepEqual(direct.expectedCases, ["public-direct"]);
  const recovery = gate.parseGateArguments([...requiredArguments, "--suite=recovery", "--expected-version=0.3.1"]);
  assert.equal(recovery.expectedVersion, "0.3.1");
  assert.deepEqual(recovery.expectedCases, ["public-direct", "failed-task-retry",
    "pause-restart-resume", "network-interruption-recovery"]);
});

test("gate arguments fail closed on typos, duplicate flags and invalid paths", () => {
  assert.equal(typeof gate.parseGateArguments, "function");
  for (const extras of [["--suite=unknown"], ["--suite=public-direct", "--falut-recovery=true"],
    ["--suite=public-direct", "--suite=all"], ["--suite=public-direct", "--expected-version=latest"]]) {
    assert.throws(() => gate.parseGateArguments([...requiredArguments, ...extras]));
  }
  assert.throws(() => gate.parseGateArguments(["--executable=relative.exe",
    requiredArguments[1], "--suite=public-direct"]), /absolute/i);
});

test("case coverage refuses missing or duplicate evidence", () => {
  assert.equal(typeof gate.assertGateCoverage, "function");
  assert.throws(() => gate.assertGateCoverage([{ label: "public-direct" }], ["public-direct", "public-extension"]));
  assert.throws(() => gate.assertGateCoverage([{ label: "public-direct" }, { label: "public-direct" }], ["public-direct"]));
  assert.doesNotThrow(() => gate.assertGateCoverage([{ label: "public-direct" }], ["public-direct"]));
});

test("task waiting also bounds an unresponsive snapshot request", async () => {
  await assert.rejects(gate.waitForTask(() => new Promise(() => {}), () => false,
    { timeoutMs: 15 }), /read timed out/i);
});

test("audit failures are reportable without exposing private file names", () => {
  assert.equal(typeof gate.captureAudit, "function");
  assert.deepEqual(gate.captureAudit(() => ({ files: 3 })), { value: { files: 3 }, error: null });
  const privateError = Object.assign(new Error("locked C:/private/user-config.json"), { code: "EACCES" });
  const failed = gate.captureAudit(() => { throw privateError; });
  assert.deepEqual(failed, { value: null, error: { name: "Error", code: "EACCES" } });
  assert.ok(!JSON.stringify(failed).includes("private"));
});
