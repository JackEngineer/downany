/** 在隔离安装目录中验证公开版 v0.3.0 覆盖升级到 v0.3.1 候选包。 */
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
  addFromInput,
  closeGateApp,
  launchGateApp,
  snapshot,
  taskState,
  verifyCompletedMedia,
} from "./test_windows_real_downloads.mjs";
import { assertBridgeUnused } from "./package_smoke_helpers.mjs";
import { createMediaFaultServer } from "./windows_media_fault_server.mjs";
import {
  buildDownloadGateEnvironment,
  packagedMediaBin,
  prepareDownloadGateRoot,
  sha256File,
} from "./windows_real_download_helpers.mjs";

const runFile = promisify(execFile);

export function appBundleForExecutable(executable) {
  const macOSDirectory = path.dirname(executable);
  const contentsDirectory = path.dirname(macOSDirectory);
  const appBundle = path.dirname(contentsDirectory);
  assert.equal(path.basename(macOSDirectory), "MacOS", "Executable is not inside a macOS app bundle");
  assert.equal(path.basename(contentsDirectory), "Contents", "Executable is not inside a macOS app bundle");
  assert.equal(path.extname(appBundle), ".app", "Executable is not inside a macOS app bundle");
  return appBundle;
}

export function parseArguments(rawArguments) {
  const allowed = new Set([
    "--source-executable", "--source-artifact", "--candidate-executable", "--candidate-artifact",
    "--playwright-module", "--results", "--source-version", "--candidate-version",
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
  const required = [
    "--source-executable", "--source-artifact", "--candidate-executable", "--candidate-artifact",
    "--playwright-module", "--results",
  ];
  assert.ok(required.every((name) => args.has(name)), "Source, candidate, Playwright and results paths are required");
  for (const name of required) assert.ok(path.isAbsolute(args.get(name)), `${name} must be absolute`);
  const sourceVersion = args.get("--source-version") || "0.3.0";
  const candidateVersion = args.get("--candidate-version") || "0.3.1";
  assert.match(sourceVersion, /^\d+\.\d+\.\d+$/, "Source version must be major.minor.patch");
  assert.match(candidateVersion, /^\d+\.\d+\.\d+$/, "Candidate version must be major.minor.patch");
  assert.notEqual(sourceVersion, candidateVersion, "Source and candidate versions must differ");
  return {
    sourceExecutable: args.get("--source-executable"),
    sourceArtifact: args.get("--source-artifact"),
    candidateExecutable: args.get("--candidate-executable"),
    candidateArtifact: args.get("--candidate-artifact"),
    playwrightModule: args.get("--playwright-module"),
    resultsPath: args.get("--results"),
    sourceVersion,
    candidateVersion,
  };
}

export function copyInstalledApp(sourceExecutable, destinationApp, ownedRoot) {
  const relative = path.relative(ownedRoot, destinationApp);
  assert.ok(relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), "Install path escaped owned root");
  if (fs.existsSync(destinationApp)) fs.rmSync(destinationApp, { recursive: true, force: true });
  fs.cpSync(appBundleForExecutable(sourceExecutable), destinationApp, {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
  const installedExecutable = path.join(destinationApp, "Contents", "MacOS", path.basename(sourceExecutable));
  assert.equal(sha256File(installedExecutable), sha256File(sourceExecutable), "Installed executable differs from package input");
  return installedExecutable;
}

async function generateMedia(executable, target) {
  const ffmpeg = path.join(packagedMediaBin(executable, "darwin"), "ffmpeg");
  await runFile(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30",
    "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000",
    "-t", "12", "-c:v", "mpeg4", "-q:v", "5", "-c:a", "aac", "-shortest", target,
  ], { timeout: 60_000, maxBuffer: 1024 * 1024 });
  assert.ok(fs.statSync(target).size > 100_000, "Generated upgrade fixture is unexpectedly small");
}

function selectedSettings(settings) {
  return {
    downloadDirRetained: true,
    defaultQuality: settings.default_quality,
    concurrentDownloads: settings.concurrent_downloads,
    themeMode: settings.theme_mode,
    embedMetadata: settings.embed_metadata,
  };
}

export async function run(options) {
  assert.equal(process.platform, "darwin", "This gate targets macOS only");
  assert.equal(process.arch, "arm64", "This gate targets Apple Silicon only");
  for (const file of [options.sourceExecutable, options.sourceArtifact, options.candidateExecutable, options.candidateArtifact]) {
    assert.ok(fs.statSync(file).isFile(), "Upgrade package input is missing");
  }
  // Public v0.3.0 always uses 17888, so refuse to disturb an existing app
  // before allocating or copying any acceptance data.
  await assertBridgeUnused();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "downany-v031-macos-upgrade-"));
  const directories = prepareDownloadGateRoot(root);
  const installRoot = path.join(root, "Applications");
  const installedApp = path.join(installRoot, "Downany.app");
  fs.mkdirSync(installRoot);
  const require = createRequire(path.join(options.playwrightModule, "package.json"));
  const session = {
    playwright: require("playwright"),
    executable: "",
    expectedVersion: options.sourceVersion,
    root,
    ...directories,
    environment: buildDownloadGateEnvironment(process.env, directories.dataDir),
    pageErrors: [], stderr: "", cases: [], launches: [], app: null, browser: null,
  };
  let passed = false;
  try {
    session.executable = copyInstalledApp(options.sourceExecutable, installedApp, root);
    await generateMedia(session.executable, path.join(root, "upgrade-fixture.mp4"));
    session.faultServer = await createMediaFaultServer(path.join(root, "upgrade-fixture.mp4"), {
      chunkBytes: 8_192,
      intervalMs: 35,
    });
    // v0.3.0 predates the dynamic bridge-port switch and always binds 17888.
    // launchGateApp therefore proves that the product port is unused first.
    session.environment.DOWNANY_BRIDGE_PORT = "17888";
    await launchGateApp(session);
    const sourceSettings = await session.page.evaluate((downloadDir) => window.api.request("settings.update", {
      download_dir: downloadDir,
      default_quality: "480p",
      concurrent_downloads: 2,
      theme_mode: "dark",
      embed_metadata: false,
    }), directories.outputDir);
    const completedId = await addFromInput(session, `${session.faultServer.baseUrl}/completed.mp4`);
    const completed = await verifyCompletedMedia(session, completedId, "source-completed");
    const pausedId = await addFromInput(session, `${session.faultServer.baseUrl}/paused.mp4`);
    await taskState(session, pausedId, "downloading", { progress: true, timeoutMs: 60_000 });
    await session.page.locator(`#task-${pausedId}`).getByRole("button", { name: "暂停", exact: true }).click();
    const paused = await taskState(session, pausedId, "paused", { timeoutMs: 30_000 });
    assert.ok(paused.downloaded_bytes > 0, "Source package did not persist a resumable partial download");
    await closeGateApp(session);

    const sourceCompletedHash = sha256File(completed.path);
    session.executable = copyInstalledApp(options.candidateExecutable, installedApp, root);
    session.expectedVersion = options.candidateVersion;
    session.environment.DOWNANY_BRIDGE_PORT = "0";
    await launchGateApp(session);
    const upgraded = await snapshot(session);
    const upgradedSettings = upgraded.settings;
    assert.equal(upgradedSettings.download_dir, sourceSettings.download_dir);
    for (const key of ["default_quality", "concurrent_downloads", "theme_mode", "embed_metadata"]) {
      assert.equal(upgradedSettings[key], sourceSettings[key], `Upgrade changed ${key}`);
    }
    const restoredCompleted = upgraded.tasks.find((item) => item.id === completedId);
    const restoredPaused = upgraded.tasks.find((item) => item.id === pausedId);
    assert.equal(restoredCompleted?.status, "completed", "Completed task was not retained");
    assert.equal(restoredPaused?.status, "paused", "Paused task was not retained");
    assert.equal(sha256File(completed.path), sourceCompletedHash, "Upgrade changed an existing completed file");
    const requestsBeforeResume = session.faultServer.requests.length;
    await session.page.locator(`#task-${pausedId}`).getByRole("button", { name: "继续", exact: true }).click();
    const resumed = await verifyCompletedMedia(session, pausedId, "candidate-resumed");
    const rangeRequest = session.faultServer.requests.slice(requestsBeforeResume).find((item) =>
      item.pathname === "/paused.mp4" && item.status === 206 && item.rangeStart > 0);
    assert.ok(rangeRequest, "Upgraded task restarted from zero instead of resuming");
    assert.equal(sha256File(completed.path), sourceCompletedHash, "Resume changed the earlier completed file");
    assert.deepEqual(session.pageErrors, [], "Renderer emitted page errors during upgrade");

    const report = {
      target: "macos-arm64",
      result: "passed",
      recordedAt: new Date().toISOString(),
      source: { version: options.sourceVersion, artifactSha256: sha256File(options.sourceArtifact) },
      candidate: { version: options.candidateVersion, artifactSha256: sha256File(options.candidateArtifact) },
      installMethod: "isolated-app-copy-replacement",
      manualInstallation: false,
      sourceLaunchVerified: true,
      candidateLaunchVerified: true,
      settingsPreserved: selectedSettings(upgradedSettings),
      queuePreserved: { completedTask: true, pausedTask: true, sameTaskIds: true },
      resume: { partialBytes: paused.downloaded_bytes, rangeStart: rangeRequest.rangeStart, completed: true },
      existingCompletedFileUnchanged: true,
      completedArtifacts: [completed, resumed].map((item) => ({
        phase: item.label,
        bytes: item.bytes,
        sha256: item.sha256,
        decodedSha256: item.decodedSHA256,
        videoCodec: item.video.codec,
        audioCodec: item.audio.codec,
      })),
    };
    fs.mkdirSync(path.dirname(options.resultsPath), { recursive: true });
    fs.writeFileSync(options.resultsPath, `${JSON.stringify(report, null, 2)}\n`);
    passed = true;
    return report;
  } finally {
    try { await closeGateApp(session); } finally {
      await session.faultServer?.close();
      if (passed) fs.rmSync(root, { recursive: true, force: true });
      else console.error(`Upgrade evidence retained for diagnosis: ${root}`);
    }
  }
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log("node scripts/run_v031_macos_upgrade.mjs --source-executable=<absolute v0.3.0 executable> --source-artifact=<absolute v0.3.0 DMG> --candidate-executable=<absolute v0.3.1 executable> --candidate-artifact=<absolute v0.3.1 DMG> --playwright-module=<absolute Playwright directory> --results=<absolute results.json>");
    return;
  }
  const report = await run(parseArguments(process.argv.slice(2)));
  console.log(`macOS upgrade gate ${report.result}: ${report.source.version} -> ${report.candidate.version}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error?.message || "macOS upgrade gate failed");
    process.exitCode = 1;
  });
}
