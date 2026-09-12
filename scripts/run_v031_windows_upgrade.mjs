/** 在临时 Windows 安装目录中验证正式 v0.3.0 NSIS 覆盖升级到 v0.3.1 候选。 */
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

export const OFFICIAL_V030_WINDOWS_SHA256 = "ea4749ed52edf8bfd350ad3bd0a7eebf17fafe7c5eba19b53e306bb2c3cae946";

export function installerArguments(installRoot) {
  assert.ok(path.isAbsolute(installRoot), "Install root must be absolute");
  return ["/S", "/currentuser", `/D=${installRoot}`];
}

export function buildFreshInstallEnvironment(inherited, dataDir, homeDir) {
  const environment = buildDownloadGateEnvironment(inherited, dataDir);
  environment.HOME = homeDir;
  environment.USERPROFILE = homeDir;
  environment.DOWNANY_BRIDGE_PORT = "0";
  return environment;
}

export function parseArguments(rawArguments) {
  const allowed = new Set([
    "--source-artifact", "--candidate-artifact", "--candidate-executable",
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
    "--source-artifact", "--candidate-artifact", "--candidate-executable", "--playwright-module", "--results",
  ];
  assert.ok(required.every((name) => args.has(name)), "Source, candidate, Playwright and results paths are required");
  for (const name of required) assert.ok(path.isAbsolute(args.get(name)), `${name} must be absolute`);
  const sourceVersion = args.get("--source-version") || "0.3.0";
  const candidateVersion = args.get("--candidate-version") || "0.3.1";
  assert.equal(path.basename(args.get("--source-artifact")), `Downany-${sourceVersion}-win-x64.exe`, "Unexpected source artifact name");
  assert.equal(path.basename(args.get("--candidate-artifact")), `Downany-${candidateVersion}-win-x64.exe`, "Unexpected candidate artifact name");
  assert.equal(path.basename(args.get("--candidate-executable")).toLowerCase(), "downany.exe", "Unexpected candidate executable name");
  assert.match(sourceVersion, /^\d+\.\d+\.\d+$/, "Source version must be major.minor.patch");
  assert.match(candidateVersion, /^\d+\.\d+\.\d+$/, "Candidate version must be major.minor.patch");
  assert.notEqual(sourceVersion, candidateVersion, "Source and candidate versions must differ");
  return {
    sourceArtifact: args.get("--source-artifact"),
    candidateArtifact: args.get("--candidate-artifact"),
    candidateExecutable: args.get("--candidate-executable"),
    playwrightModule: args.get("--playwright-module"),
    resultsPath: args.get("--results"),
    sourceVersion,
    candidateVersion,
  };
}

async function installNsis(installer, installRoot) {
  await runFile(installer, installerArguments(installRoot), {
    windowsHide: true,
    timeout: 5 * 60_000,
    maxBuffer: 1024 * 1024,
  });
  const executable = path.join(installRoot, "Downany.exe");
  assert.ok(fs.statSync(executable).isFile(), "NSIS did not install Downany.exe");
  return executable;
}

async function uninstallNsis(installRoot) {
  const uninstaller = path.join(installRoot, "Uninstall Downany.exe");
  if (!fs.existsSync(uninstaller)) return;
  await runFile(uninstaller, ["/S", "/currentuser"], {
    windowsHide: true,
    timeout: 5 * 60_000,
    maxBuffer: 1024 * 1024,
  });
}

async function generateMedia(executable, target) {
  const ffmpeg = path.join(packagedMediaBin(executable, "win32"), "ffmpeg.exe");
  await runFile(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30",
    "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000",
    "-t", "12", "-c:v", "mpeg4", "-q:v", "5", "-c:a", "aac", "-shortest", target,
  ], { windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024 });
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

function candidateFileMatches(installedRoot, unpackedRoot) {
  const relativeFiles = [
    "Downany.exe",
    "resources/app.asar",
    "resources/sidecar/DownanySidecar/DownanySidecar.exe",
    "resources/bin/ffmpeg.exe",
    "resources/bin/ffprobe.exe",
  ];
  return Object.fromEntries(relativeFiles.map((relative) => {
    const installed = path.join(installedRoot, relative);
    const unpacked = path.join(unpackedRoot, relative);
    assert.ok(fs.statSync(installed).isFile() && fs.statSync(unpacked).isFile(), `Candidate file missing: ${relative}`);
    assert.equal(sha256File(installed), sha256File(unpacked), `Installed candidate differs: ${relative}`);
    return [relative, true];
  }));
}

function assertInside(root, target, label) {
  const relative = path.relative(fs.realpathSync(root), fs.realpathSync(target));
  assert.ok(relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), `${label} escaped isolated root`);
}

async function verifyFreshCandidateInstall({ options, playwright, root }) {
  const firstRoot = path.join(root, "first-install");
  const dataDir = path.join(firstRoot, "downany-data");
  const profileDir = path.join(firstRoot, "electron-profile");
  const homeDir = path.join(firstRoot, "home");
  const installRoot = path.join(firstRoot, "Applications", "Downany");
  for (const directory of [dataDir, profileDir, homeDir, path.dirname(installRoot)]) fs.mkdirSync(directory, { recursive: true });
  const session = {
    playwright,
    executable: "",
    expectedVersion: options.candidateVersion,
    root: firstRoot,
    dataDir,
    profileDir,
    outputDir: path.join(homeDir, "Downloads", "Downany"),
    environment: buildFreshInstallEnvironment(process.env, dataDir, homeDir),
    pageErrors: [], stderr: "", cases: [], launches: [], app: null, browser: null,
  };
  try {
    assert.deepEqual(fs.readdirSync(dataDir), [], "First-install data directory must begin empty");
    session.executable = await installNsis(options.candidateArtifact, installRoot);
    const candidateFiles = candidateFileMatches(installRoot, path.dirname(options.candidateExecutable));
    const fixturePath = path.join(firstRoot, "first-download-fixture.mp4");
    await generateMedia(session.executable, fixturePath);
    session.faultServer = await createMediaFaultServer(fixturePath, { chunkBytes: 8_192, intervalMs: 25 });
    await launchGateApp(session);
    const configPath = path.join(dataDir, "config.json");
    assert.ok(fs.statSync(configPath).isFile(), "First launch did not create configuration");
    const firstSnapshot = await snapshot(session);
    assert.equal(path.resolve(firstSnapshot.settings.download_dir), path.resolve(session.outputDir), "Fresh install chose an unexpected output directory");
    assertInside(firstRoot, firstSnapshot.settings.download_dir, "Default output directory");
    const taskId = await addFromInput(session, `${session.faultServer.baseUrl}/first-download.mp4`);
    await session.page.locator(`#task-${taskId}`).waitFor({ state: "visible", timeout: 15_000 });
    const completed = await verifyCompletedMedia(session, taskId, "first-download-completed");
    await session.page.locator(`#task-${taskId}`).getByRole("button", { name: "打开", exact: true })
      .waitFor({ state: "visible", timeout: 15_000 });
    assertInside(firstRoot, completed.path, "Downloaded file");
    assert.deepEqual(session.pageErrors, [], "Renderer emitted page errors during first download");
    return {
      installerExecutionVerified: true,
      candidateLaunchVerified: true,
      candidateFilesMatchUnpacked: candidateFiles,
      freshDataDirectory: true,
      configurationCreatedOnFirstLaunch: true,
      defaultOutputInsideIsolatedHome: true,
      addedLinkFeedbackVisible: true,
      completedStateVisible: completed.visibleCompleted,
      openFileActionVisible: true,
      artifact: {
        bytes: completed.bytes,
        sha256: completed.sha256,
        decodedSha256: completed.decodedSHA256,
        videoCodec: completed.video.codec,
        audioCodec: completed.audio.codec,
      },
    };
  } finally {
    try { await closeGateApp(session); } finally {
      try { await session.faultServer?.close(); } finally {
        await uninstallNsis(installRoot);
      }
    }
  }
}

export async function run(options) {
  assert.equal(process.platform, "win32", "This gate targets Windows only");
  assert.equal(process.arch, "x64", "This gate targets Windows x64 only");
  for (const file of [options.sourceArtifact, options.candidateArtifact, options.candidateExecutable]) {
    assert.ok(fs.statSync(file).isFile(), "Upgrade package input is missing");
  }
  assert.equal(sha256File(options.sourceArtifact), OFFICIAL_V030_WINDOWS_SHA256, "Source installer is not the official v0.3.0 release");
  await assertBridgeUnused();

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "downany-v031-windows-upgrade-"));
  const directories = prepareDownloadGateRoot(root);
  const installRoot = path.join(root, "Applications", "Downany");
  fs.mkdirSync(path.dirname(installRoot));
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
  let verified = null;
  try {
    session.executable = await installNsis(options.sourceArtifact, installRoot);
    await generateMedia(session.executable, path.join(root, "upgrade-fixture.mp4"));
    session.faultServer = await createMediaFaultServer(path.join(root, "upgrade-fixture.mp4"), {
      chunkBytes: 8_192,
      intervalMs: 35,
    });
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
    session.executable = await installNsis(options.candidateArtifact, installRoot);
    const candidateFiles = candidateFileMatches(installRoot, path.dirname(options.candidateExecutable));
    session.expectedVersion = options.candidateVersion;
    session.environment.DOWNANY_BRIDGE_PORT = "0";
    await launchGateApp(session);
    const upgraded = await snapshot(session);
    const upgradedSettings = upgraded.settings;
    assert.equal(upgradedSettings.download_dir, sourceSettings.download_dir);
    for (const key of ["default_quality", "concurrent_downloads", "theme_mode", "embed_metadata"]) {
      assert.equal(upgradedSettings[key], sourceSettings[key], `Upgrade changed ${key}`);
    }
    assert.equal(upgraded.tasks.find((item) => item.id === completedId)?.status, "completed", "Completed task was not retained");
    assert.equal(upgraded.tasks.find((item) => item.id === pausedId)?.status, "paused", "Paused task was not retained");
    assert.equal(sha256File(completed.path), sourceCompletedHash, "Upgrade changed an existing completed file");
    const requestsBeforeResume = session.faultServer.requests.length;
    await session.page.locator(`#task-${pausedId}`).getByRole("button", { name: "继续", exact: true }).click();
    const resumed = await verifyCompletedMedia(session, pausedId, "candidate-resumed");
    const rangeRequest = session.faultServer.requests.slice(requestsBeforeResume).find((item) =>
      item.pathname === "/paused.mp4" && item.status === 206 && item.rangeStart > 0);
    assert.ok(rangeRequest, "Upgraded task restarted from zero instead of resuming");
    assert.equal(sha256File(completed.path), sourceCompletedHash, "Resume changed the earlier completed file");
    assert.deepEqual(session.pageErrors, [], "Renderer emitted page errors during upgrade");

    const upgradeEvidence = {
      target: "windows-x64",
      result: "passed",
      recordedAt: new Date().toISOString(),
      source: { version: options.sourceVersion, artifactSha256: sha256File(options.sourceArtifact) },
      candidate: { version: options.candidateVersion, artifactSha256: sha256File(options.candidateArtifact) },
      installMethod: "silent-current-user-same-directory",
      manualInstallation: false,
      installerExecutionVerified: true,
      sourceLaunchVerified: true,
      candidateLaunchVerified: true,
      candidateFilesMatchUnpacked: candidateFiles,
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
    await closeGateApp(session);
    await session.faultServer.close();
    session.faultServer = null;
    await uninstallNsis(installRoot);
    await assertBridgeUnused();
    const firstInstall = await verifyFreshCandidateInstall({
      options,
      playwright: session.playwright,
      root,
    });
    await assertBridgeUnused();
    verified = { ...upgradeEvidence, firstInstall };
    fs.mkdirSync(path.dirname(options.resultsPath), { recursive: true });
    fs.writeFileSync(options.resultsPath, `${JSON.stringify(verified, null, 2)}\n`);
    fs.rmSync(root, { recursive: true, force: true });
    return verified;
  } catch (error) {
    console.error(`Windows upgrade evidence retained for diagnosis: ${root}`);
    throw error;
  } finally {
    try { await closeGateApp(session); } catch {}
    try { await session.faultServer?.close(); } catch {}
    if (!verified) {
      try { await uninstallNsis(installRoot); } catch {}
    }
  }
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log("node scripts/run_v031_windows_upgrade.mjs --source-artifact=<absolute v0.3.0 NSIS> --candidate-artifact=<absolute v0.3.1 NSIS> --candidate-executable=<absolute unpacked Downany.exe> --playwright-module=<absolute Playwright directory> --results=<absolute results.json>");
    return;
  }
  const report = await run(parseArguments(process.argv.slice(2)));
  console.log(`Windows upgrade gate ${report.result}: ${report.source.version} -> ${report.candidate.version}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error?.message || "Windows upgrade gate failed");
    process.exitCode = 1;
  });
}
