/** 在隔离的最终候选包中执行 v0.3.1 真实网站矩阵；结果文件不记录 URL、路径或原始错误。 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
import { assertIndependentMatrixSamples } from "./v031_sample_independence.mjs";
import {
  assertCredentialSettings,
  collectMatrixCase,
  createMatrixCaseTask,
  mergeTargetResults,
  parseMatrixRunArguments,
  removeAttemptState,
  resolveMatrixCases,
} from "./v031_matrix_run_helpers.mjs";

const runFile = promisify(execFile);

function fileSha256(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

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

export async function runMatrix(options, { loadReview } = {}) {
  assert.equal(options.target, expectedRuntimeTarget(), "Target does not match this operating system and architecture");
  assert.ok(fs.statSync(options.executable).isFile(), "Candidate executable is missing");
  assert.ok(fs.statSync(options.candidateArtifact).isFile(), "Candidate artifact is missing");
  const candidateSha256 = fileSha256(options.candidateArtifact);
  const matrix = JSON.parse(fs.readFileSync(options.matrixPath, "utf8"));
  validateReliabilityMatrix(matrix);
  const selectedRows = options.caseId ? matrix.filter((row) => row.id === options.caseId) : matrix;
  assert.ok(selectedRows.length, "Requested case id is not in the matrix");
  const resolved = resolveMatrixCases(selectedRows, process.env);
  if (resolved.missing.length) {
    throw new Error(`Missing URL environment keys: ${resolved.missing.join(", ")}`);
  }

  const selectedIds = new Set(selectedRows.map((row) => row.id));
  // 单条续跑也检查同候选已有样本；替换用例的旧行不能阻止它用新输入真实复验。
  const priorSamples = readExistingResults(options.resultsPath).filter((result) =>
    result.target === options.target && result.candidateSha256 === candidateSha256 && !selectedIds.has(result.id));
  assertIndependentMatrixSamples([
    ...priorSamples,
    ...resolved.cases.map(({ row, url }) => ({
      target: options.target, id: row.id, sampleSha256: createHash("sha256").update(url).digest("hex"),
    })),
  ], { loadReview });

  const credentialSource = options.cookiefile ? "cookiefile" : options.cookiesFromBrowser ? "browser" : "none";
  assert.ok(!selectedRows.some((row) => row.scenario === "login") || credentialSource !== "none",
    "Login cases require one credential source");
  if (options.cookiefile) assert.ok(fs.statSync(options.cookiefile).isFile(), "Cookie file is missing");
  const require = createRequire(path.join(options.playwrightModule, "package.json"));
  const playwright = require("playwright");
  const binDir = packagedMediaBin(options.executable);
  assert.ok(fs.statSync(mediaTool(binDir, "ffmpeg")).isFile(), "Packaged ffmpeg is missing");
  assert.ok(fs.statSync(mediaTool(binDir, "ffprobe")).isFile(), "Packaged ffprobe is missing");
  const updates = [];
  for (const { row, url } of resolved.cases) {
    const result = await collectMatrixCase({
      target: options.target, candidateSha256, row, url, credentialSource,
      runAttempt: (attempt) => runIsolatedAttempt(options, playwright, binDir, attempt),
    });
    updates.push(result);
    writeResults(options.resultsPath, mergeTargetResults(readExistingResults(options.resultsPath), [result]));
    console.log(`${row.id}: ${result.outcome}${result.loginEvidence ? ` (anonymous: ${result.loginEvidence.anonymous.outcome})` : ""}`);
  }
  return updates;
}

export async function runIsolatedAttempt(options, playwright, binDir, { row, url, credentialSource, phase }) {
  // 每个阶段独占数据、队列与 Electron profile；前一实例清理完成后才启动下一个。
  const instanceId = randomUUID();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `downany-v031-${options.target}-${phase}-`));
  console.log(`Owned artifact directory: ${root}`);
  const directories = prepareDownloadGateRoot(root);
  let app;
  try {
    const credentials = {
      cookiesFromBrowser: credentialSource === "browser" ? options.cookiesFromBrowser : "",
      cookiefile: credentialSource === "cookiefile" ? options.cookiefile : "",
    };
    const configPath = path.join(directories.dataDir, "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.cookies_from_browser = credentials.cookiesFromBrowser;
    config.cookiefile = credentials.cookiefile;
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const environment = buildDownloadGateEnvironment(process.env, directories.dataDir);
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
    const settings = await page.evaluate(() => window.api.request("settings.get", {}));
    assertCredentialSettings(settings, credentials);
    const created = await createMatrixCaseTask(page, row, url);
    if (created.failureStage === "collection_parse") {
      return { failureStage: "collection_parse", instanceId, recordedAt: new Date().toISOString() };
    }
    const { taskId } = created;
    const task = await waitForTask(
      () => readTask(page, taskId),
      (current) => ["completed", "failed", "cancelled"].includes(current?.status),
      { timeoutMs: options.timeoutMs, pollIntervalMs: 500 },
    );
    let artifact = { playable: false };
    if (task.status === "completed") artifact = await verifyArtifact(task, directories.outputDir, binDir);
    return { task, artifact, instanceId, recordedAt: new Date().toISOString() };
  } finally {
    try {
      if (app) {
        const child = app.process();
        try { await app.close(); } finally { await stopChildProcessTree(child); }
      }
    } finally {
      // 隔离运行目录可能包含 URL、Cookie 路径和原始错误；只保留成品与脱敏结果。
      removeAttemptState(directories);
    }
  }
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log("node scripts/run_v031_reliability_matrix.mjs --executable=<absolute candidate> --candidate-artifact=<absolute DMG or NSIS installer> --playwright-module=<absolute playwright directory> --matrix=<absolute matrix.json> --results=<absolute results.json> --target=macos-arm64|windows-x64 [--expected-version=0.3.1] [--cookiefile=<absolute Netscape cookies.txt>] [--cookies-from-browser=<browser name>] [--case=<case id>] [--timeout-minutes=15]");
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
