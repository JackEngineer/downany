/** 在隔离的 macOS 最终候选包中验证失败重试、暂停恢复和网络中断续传。 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  PUBLIC_SAMPLE,
  closeGateApp,
  launchGateApp,
  verifyFaultRecovery,
  verifyNoOverwrite,
  verifyPublicDirect,
} from "./test_windows_real_downloads.mjs";
import {
  assertGateCoverage,
  buildDownloadGateEnvironment,
  prepareDownloadGateRoot,
  sha256File,
} from "./windows_real_download_helpers.mjs";

const EXPECTED_CASES = [
  "public-direct",
  "duplicate-name-no-overwrite",
  "failed-task-retry",
  "pause-restart-resume",
  "network-interruption-recovery",
];

function parseArguments(rawArguments) {
  const allowed = new Set([
    "--executable", "--candidate-artifact", "--playwright-module", "--results", "--expected-version",
  ]);
  const args = new Map();
  for (const argument of rawArguments) {
    const separator = argument.indexOf("=");
    assert.ok(separator > 0, "Use --name=value arguments");
    const name = argument.slice(0, separator);
    const value = argument.slice(separator + 1);
    assert.ok(allowed.has(name) && !args.has(name) && value, `Unknown, duplicate or empty argument: ${name}`);
    args.set(name, value);
  }
  for (const name of ["--executable", "--candidate-artifact", "--playwright-module", "--results"]) {
    assert.ok(args.has(name), `${name} is required`);
    assert.ok(path.isAbsolute(args.get(name)), `${name} must be absolute`);
  }
  const expectedVersion = args.get("--expected-version") || "0.3.1";
  assert.match(expectedVersion, /^\d+\.\d+\.\d+$/, "Expected version must be major.minor.patch");
  return {
    executable: args.get("--executable"),
    candidateArtifact: args.get("--candidate-artifact"),
    playwrightModule: args.get("--playwright-module"),
    resultsPath: args.get("--results"),
    expectedVersion,
  };
}

function safeCase(item) {
  return {
    label: item.label,
    taskId: item.taskId,
    artifactBytes: item.bytes,
    artifactSha256: item.sha256,
    decodedSha256: item.decodedSHA256,
    durationSeconds: item.durationSeconds,
    container: item.container,
    video: item.video,
    audio: item.audio,
    visibleCompleted: item.visibleCompleted,
    ...(item.recovery ? { recovery: item.recovery } : {}),
  };
}

async function run(options) {
  assert.equal(process.platform, "darwin", "This gate targets macOS only");
  assert.equal(process.arch, "arm64", "This gate targets Apple Silicon only");
  assert.ok(fs.statSync(options.executable).isFile(), "Candidate executable is missing");
  assert.ok(fs.statSync(options.candidateArtifact).isFile(), "Candidate artifact is missing");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "downany-v031-macos-recovery-"));
  const directories = prepareDownloadGateRoot(root);
  const configPath = path.join(directories.dataDir, "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.default_quality = "720p";
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const require = createRequire(path.join(options.playwrightModule, "package.json"));
  const session = {
    playwright: require("playwright"),
    executable: options.executable,
    expectedVersion: options.expectedVersion,
    root,
    ...directories,
    environment: buildDownloadGateEnvironment(process.env, directories.dataDir),
    pageErrors: [], stderr: "", cases: [], launches: [], app: null, browser: null,
  };
  let passed = false;
  try {
    await launchGateApp(session);
    const source = await verifyPublicDirect(session);
    await verifyNoOverwrite(session, source);
    await verifyFaultRecovery(session, source);
    assertGateCoverage(session.cases, EXPECTED_CASES);
    assert.deepEqual(session.pageErrors, [], "Renderer emitted page errors");
    assert.equal(session.previousCompletedFilesUnchanged, true, "Completed files changed during recovery");
    const report = {
      target: "macos-arm64",
      candidateSha256: sha256File(options.candidateArtifact),
      expectedVersion: options.expectedVersion,
      recordedAt: new Date().toISOString(),
      sampleLicense: PUBLIC_SAMPLE.license,
      result: "passed",
      launchCount: session.launches.length,
      previousCompletedFilesUnchanged: true,
      cases: session.cases.map(safeCase),
    };
    fs.mkdirSync(path.dirname(options.resultsPath), { recursive: true });
    fs.writeFileSync(options.resultsPath, `${JSON.stringify(report, null, 2)}\n`);
    passed = true;
    return report;
  } finally {
    try { await closeGateApp(session); } finally {
      await session.faultServer?.close();
      if (passed) fs.rmSync(root, { recursive: true, force: true });
      else console.error(`Recovery evidence retained for diagnosis: ${root}`);
    }
  }
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log("node scripts/run_v031_macos_recovery.mjs --executable=<absolute candidate> --candidate-artifact=<absolute DMG> --playwright-module=<absolute Playwright directory> --results=<absolute results.json> [--expected-version=0.3.1]");
    return;
  }
  const report = await run(parseArguments(process.argv.slice(2)));
  console.log(`macOS recovery gate ${report.result}: ${report.cases.length} cases`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error?.message || "macOS recovery gate failed");
    process.exitCode = 1;
  });
}

export { parseArguments, run };
