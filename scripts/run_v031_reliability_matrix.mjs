/** 在隔离的最终候选包中执行 v0.3.1 真实网站矩阵；结果文件不记录 URL、路径或原始错误。 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  assertCompletedDownload,
  buildDownloadGateEnvironment,
  prepareDownloadGateRoot,
  validateMediaProbe,
  waitForTask,
} from "./windows_real_download_helpers.mjs";
import { stopChildProcessTree } from "./package_smoke_helpers.mjs";
import { validateReliabilityMatrix } from "./v031_acceptance_helpers.mjs";
import {
  buildSanitizedCaseResult,
  mergeTargetResults,
  parseMatrixRunArguments,
  resolveMatrixCases,
} from "./v031_matrix_run_helpers.mjs";

const runFile = promisify(execFile);

function expectedRuntimeTarget() {
  if (process.platform === "darwin" && process.arch === "arm64") return "macos-arm64";
  if (process.platform === "win32" && process.arch === "x64") return "windows-x64";
  return `${process.platform}-${process.arch}`;
}

function packagedMediaBin(executable) {
  if (process.platform === "darwin") {
    return path.resolve(path.dirname(executable), "../Resources/bin");
  }
  return path.join(path.dirname(executable), "resources", "bin");
}

function mediaTool(bin, name) {
  return path.join(bin, process.platform === "win32" ? `${name}.exe` : name);
}

function readExistingResults(resultsPath) {
  const backup = `${resultsPath}.bak`;
  if (!fs.existsSync(resultsPath) && fs.existsSync(backup)) {
    fs.renameSync(backup, resultsPath);
  }
  if (!fs.existsSync(resultsPath)) return [];
  const value = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
  assert.ok(Array.isArray(value), "Existing results must be a JSON array");
  return value;
}

function writeResults(resultsPath, results) {
  fs.mkdirSync(path.dirname(resultsPath), { recursive: true });
  const temporary = `${resultsPath}.tmp-${process.pid}`;
  const backup = `${resultsPath}.bak`;
  if (fs.existsSync(temporary)) fs.rmSync(temporary);
  if (fs.existsSync(backup)) fs.rmSync(backup);
  fs.writeFileSync(temporary, `${JSON.stringify(results, null, 2)}\n`, { flag: "wx" });
  if (fs.existsSync(resultsPath)) fs.renameSync(resultsPath, backup);
  try {
    fs.renameSync(temporary, resultsPath);
    if (fs.existsSync(backup)) fs.rmSync(backup);
  } catch (error) {
    if (!fs.existsSync(resultsPath) && fs.existsSync(backup)) fs.renameSync(backup, resultsPath);
    throw error;
  }
}

async function parseCollection(page, url) {
  return page.evaluate(({ sourceUrl }) => new Promise((resolve, reject) => {
    let parseId = "";
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("collection parse timed out"));
    }, 120_000);
    const unsubscribe = window.api.onEvent((event) => {
      if (event.event !== "download.parseResult") return;
      const payload = event.payload || {};
      if (!parseId || payload.parseId !== parseId) return;
      clearTimeout(timeout);
      unsubscribe();
      if (payload.ok) resolve(payload);
      else reject(new Error("collection parse failed"));
    });
    window.api.request("download.parseUrls", {
      urls: [sourceUrl],
      allow_playlist: true,
      timeout: 90,
    }).then((reply) => {
      parseId = reply.parseId;
    }, () => {
      clearTimeout(timeout);
      unsubscribe();
      reject(new Error("collection parse could not start"));
    });
  }), { sourceUrl: url });
}

async function createCaseTask(page, row, url) {
  let urls = [url];
  let items;
  if (row.scenario === "collection") {
    const parsed = await parseCollection(page, url);
    const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    const entry = entries.find((item) => item?.url && String(item.available ?? "1") !== "0");
    assert.ok(entry, "Collection did not expose an available entry");
    urls = [String(entry.url)];
    items = [{
      url: String(entry.url),
      title: String(entry.title || entry.id || "集合样本"),
      group_id: `acceptance-${row.id}`,
      group_title: String(parsed.playlist?.title || "集合样本"),
      playlist_index: Number(entry.index) || 1,
    }];
  }
  const reply = await page.evaluate(({ taskUrls, taskItems }) =>
    window.api.request("download.createTasks", {
      urls: taskUrls,
      items: taskItems,
      expandPlaylists: false,
    }), { taskUrls: urls, taskItems: items });
  assert.equal(reply.taskIds?.length, 1, "Each matrix case must create exactly one task");
  return reply.taskIds[0];
}

async function readTask(page, taskId) {
  const snapshot = await page.evaluate(() => window.api.request("app.getSnapshot", {}));
  return snapshot.tasks.find((task) => task.id === taskId) || null;
}

async function verifyArtifact(task, outputDir, binDir) {
  const file = assertCompletedDownload(task, outputDir);
  const probe = await runFile(mediaTool(binDir, "ffprobe"), [
    "-v", "error", "-show_streams", "-show_format", "-of", "json", file.path,
  ], { windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 });
  validateMediaProbe(JSON.parse(probe.stdout));
  const decoded = await runFile(mediaTool(binDir, "ffmpeg"), [
    "-hide_banner", "-v", "error", "-nostdin", "-xerror", "-err_detect", "explode",
    "-i", file.path, "-map", "0:v:0", "-map", "0:a:0", "-f", "hash", "-hash", "sha256", "-",
  ], { windowsHide: true, timeout: 10 * 60_000, maxBuffer: 1024 * 1024 });
  assert.match(decoded.stdout.trim(), /^SHA256=[a-f0-9]{64}$/i, "Full decode did not produce a checksum");
  return { playable: true, sha256: file.sha256, bytes: file.bytes };
}

async function runMatrix(options) {
  assert.equal(options.target, expectedRuntimeTarget(), "Target does not match this operating system and architecture");
  assert.ok(fs.statSync(options.executable).isFile(), "Candidate executable is missing");
  const matrix = JSON.parse(fs.readFileSync(options.matrixPath, "utf8"));
  validateReliabilityMatrix(matrix);
  const selectedRows = options.caseId ? matrix.filter((row) => row.id === options.caseId) : matrix;
  assert.ok(selectedRows.length, "Requested case id is not in the matrix");
  const resolved = resolveMatrixCases(selectedRows, process.env);
  if (resolved.missing.length) {
    throw new Error(`Missing URL environment keys: ${resolved.missing.join(", ")}`);
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), `downany-v031-${options.target}-`));
  console.log(`Owned artifact directory: ${root}`);
  const directories = prepareDownloadGateRoot(root);
  if (options.cookiefile) {
    assert.ok(fs.statSync(options.cookiefile).isFile(), "Cookie file is missing");
    const configPath = path.join(directories.dataDir, "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.cookiefile = options.cookiefile;
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  }
  const environment = buildDownloadGateEnvironment(process.env, directories.dataDir);
  const require = createRequire(path.join(options.playwrightModule, "package.json"));
  const playwright = require("playwright");
  let app;
  const updates = [];
  try {
    app = await playwright._electron.launch({
      executablePath: options.executable,
      args: [`--user-data-dir=${directories.profileDir}`],
      cwd: path.dirname(options.executable),
      env: environment,
      timeout: 60_000,
    });
    const page = await app.firstWindow({ timeout: 30_000 });
    await page.waitForFunction(() => !!window.api, undefined, { timeout: 30_000 });
    const identity = await app.evaluate(({ app: electronApp }) => ({ version: electronApp.getVersion() }));
    assert.equal(identity.version, options.expectedVersion, "Candidate version does not match the requested release");
    const binDir = packagedMediaBin(options.executable);
    assert.ok(fs.statSync(mediaTool(binDir, "ffmpeg")).isFile(), "Packaged ffmpeg is missing");
    assert.ok(fs.statSync(mediaTool(binDir, "ffprobe")).isFile(), "Packaged ffprobe is missing");

    for (const { row, url } of resolved.cases) {
      const taskId = await createCaseTask(page, row, url);
      const task = await waitForTask(
        () => readTask(page, taskId),
        (current) => ["completed", "failed", "cancelled"].includes(current?.status),
        { timeoutMs: options.timeoutMs, pollIntervalMs: 500 },
      );
      let artifact = { playable: false };
      if (task.status === "completed") artifact = await verifyArtifact(task, directories.outputDir, binDir);
      const result = buildSanitizedCaseResult({
        target: options.target,
        row,
        task,
        artifact,
        recordedAt: new Date().toISOString(),
      });
      updates.push(result);
      writeResults(options.resultsPath, mergeTargetResults(readExistingResults(options.resultsPath), [result]));
      console.log(`${row.id}: ${result.outcome}`);
    }
  } finally {
    if (app) {
      const child = app.process();
      try { await app.close(); } finally { await stopChildProcessTree(child); }
    }
    // 隔离运行目录可能包含 URL、Cookie 路径和原始错误；只保留成品与脱敏结果。
    fs.rmSync(directories.dataDir, { recursive: true, force: true });
    fs.rmSync(directories.profileDir, { recursive: true, force: true });
  }
  return updates;
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log("node scripts/run_v031_reliability_matrix.mjs --executable=<absolute candidate> --playwright-module=<absolute playwright directory> --matrix=<absolute matrix.json> --results=<absolute results.json> --target=macos-arm64|windows-x64 [--expected-version=0.3.1] [--cookiefile=<absolute Netscape cookies.txt>] [--case=<case id>] [--timeout-minutes=15]");
    return;
  }
  const options = parseMatrixRunArguments(process.argv.slice(2));
  await runMatrix(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error?.message || "Matrix run failed");
    process.exitCode = 1;
  });
}
