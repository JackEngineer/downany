/** 从候选包应用副本验证 macOS 全新安装后的首次下载主流程。 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { copyInstalledApp } from "./run_v031_macos_upgrade.mjs";
import {
  closeGateApp,
  launchGateApp,
  snapshot,
  verifyCompletedMedia,
} from "./test_windows_real_downloads.mjs";
import { createMediaFaultServer } from "./windows_media_fault_server.mjs";
import {
  buildDownloadGateEnvironment,
  packagedMediaBin,
  sha256File,
  waitForTask,
} from "./windows_real_download_helpers.mjs";

const runFile = promisify(execFile);

export function parseArguments(rawArguments) {
  const allowed = new Set([
    "--package-executable", "--candidate-artifact", "--playwright-module", "--results", "--expected-version",
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
  const required = ["--package-executable", "--candidate-artifact", "--playwright-module", "--results"];
  assert.ok(required.every((name) => args.has(name)), "Package, candidate, Playwright and results paths are required");
  for (const name of required) assert.ok(path.isAbsolute(args.get(name)), `${name} must be absolute`);
  const expectedVersion = args.get("--expected-version") || "0.3.1";
  assert.match(expectedVersion, /^\d+\.\d+\.\d+$/, "Expected version must be major.minor.patch");
  return {
    packageExecutable: args.get("--package-executable"),
    candidateArtifact: args.get("--candidate-artifact"),
    playwrightModule: args.get("--playwright-module"),
    resultsPath: args.get("--results"),
    expectedVersion,
  };
}

async function generateMedia(executable, target) {
  const ffmpeg = path.join(packagedMediaBin(executable, "darwin"), "ffmpeg");
  await runFile(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30",
    "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000",
    "-t", "8", "-c:v", "mpeg4", "-q:v", "5", "-c:a", "aac", "-shortest", target,
  ], { timeout: 60_000, maxBuffer: 1024 * 1024 });
  assert.ok(fs.statSync(target).size > 100_000, "Generated first-download fixture is unexpectedly small");
}

function assertInside(root, target, label) {
  const relative = path.relative(fs.realpathSync(root), fs.realpathSync(target));
  assert.ok(relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), `${label} escaped isolated root`);
}

async function addFromVisibleButton(session, url) {
  const before = new Set((await snapshot(session)).tasks.map((task) => task.id));
  const input = session.page.getByRole("textbox", { name: "添加下载链接", exact: true });
  await input.fill(url);
  assert.equal(await input.inputValue(), url, "Visible add field changed the submitted URL");
  await session.page.getByRole("button", { name: "添加", exact: true }).click();
  const task = await waitForTask(async () => (await snapshot(session)).tasks.find((item) => !before.has(item.id)),
    (item) => !!item, { timeoutMs: 30_000 });
  return task.id;
}

async function verifyDownloadDirectoryGuard(session, url) {
  const unavailable = path.join(session.root, "occupied-download-path");
  fs.writeFileSync(unavailable, "not a directory\n", { flag: "wx" });
  await session.page.evaluate((downloadDir) => window.api.request("settings.update", {
    download_dir: downloadDir,
  }), unavailable);
  await waitForTask(
    () => snapshot(session),
    (value) => path.resolve(value?.settings?.download_dir || "") === path.resolve(unavailable),
    { timeoutMs: 15_000, pollIntervalMs: 100 },
  );
  const before = await snapshot(session);
  const input = session.page.getByRole("textbox", { name: "添加下载链接", exact: true });
  await input.fill(url);
  await session.page.getByRole("button", { name: "添加", exact: true }).click();
  await session.page.getByText("下载位置不可用", { exact: true }).waitFor({
    state: "visible", timeout: 15_000,
  });
  const blocked = await snapshot(session);
  assert.deepEqual(blocked.tasks.map((task) => task.id), before.tasks.map((task) => task.id),
    "Unavailable download directory still created a task");
  const settingsPage = await waitForTask(
    async () => {
      for (const page of session.app.windows()) {
        if (page.isClosed() || !page.url().includes("settings.html")) continue;
        try {
          if (await page.evaluate(() => document.activeElement?.id === "settings-focus-download")) return page;
        } catch {
          // The settings window can reload once while initial data arrives.
        }
      }
      return null;
    },
    (page) => !!page,
    { timeoutMs: 15_000, pollIntervalMs: 100 },
  );
  await session.page.evaluate((downloadDir) => window.api.request("settings.update", {
    download_dir: downloadDir,
  }), session.outputDir);
  await waitForTask(
    () => snapshot(session),
    (value) => path.resolve(value?.settings?.download_dir || "") === path.resolve(session.outputDir),
    { timeoutMs: 15_000, pollIntervalMs: 100 },
  );
  if (!settingsPage.isClosed()) await settingsPage.close();
  return {
    invalidPathBlocked: true,
    taskCountUnchanged: true,
    settingsControlFocused: true,
    recoveryDirectoryAccepted: true,
  };
}

export async function run(options) {
  assert.equal(process.platform, "darwin", "This gate targets macOS only");
  assert.equal(process.arch, "arm64", "This gate targets Apple Silicon only");
  for (const file of [options.packageExecutable, options.candidateArtifact]) {
    assert.ok(fs.statSync(file).isFile(), "First-install package input is missing");
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "downany-v031-macos-first-install-"));
  const dataDir = path.join(root, "downany-data");
  const profileDir = path.join(root, "electron-profile");
  const homeDir = path.join(root, "home");
  const installRoot = path.join(root, "Applications");
  for (const directory of [dataDir, profileDir, homeDir, installRoot]) fs.mkdirSync(directory);
  const installedApp = path.join(installRoot, "Downany.app");
  const executable = copyInstalledApp(options.packageExecutable, installedApp, root);
  const fixturePath = path.join(root, "first-download-fixture.mp4");
  await generateMedia(executable, fixturePath);
  const outputDir = path.join(homeDir, "Downloads", "Downany");
  const require = createRequire(path.join(options.playwrightModule, "package.json"));
  const environment = buildDownloadGateEnvironment(process.env, dataDir);
  environment.HOME = homeDir;
  const session = {
    playwright: require("playwright"),
    executable,
    expectedVersion: options.expectedVersion,
    root,
    dataDir,
    profileDir,
    outputDir,
    environment,
    pageErrors: [], stderr: "", cases: [], launches: [], app: null, browser: null,
  };
  let passed = false;
  try {
    assert.deepEqual(fs.readdirSync(dataDir), [], "First-install data directory must begin empty");
    session.faultServer = await createMediaFaultServer(fixturePath, { chunkBytes: 8_192, intervalMs: 25 });
    await launchGateApp(session);
    const configPath = path.join(dataDir, "config.json");
    assert.ok(fs.statSync(configPath).isFile(), "First launch did not create configuration");
    const firstSnapshot = await snapshot(session);
    assert.equal(path.resolve(firstSnapshot.settings.download_dir), path.resolve(outputDir), "Fresh install chose an unexpected output directory");
    const input = session.page.getByRole("textbox", { name: "添加下载链接", exact: true });
    assert.equal(await input.isVisible(), true, "First-download input is not visible");

    const firstDownloadUrl = `${session.faultServer.baseUrl}/first-download.mp4`;
    const downloadDirectoryGuard = await verifyDownloadDirectoryGuard(session, firstDownloadUrl);
    const taskId = await addFromVisibleButton(session, firstDownloadUrl);
    const taskRow = session.page.locator(`#task-${taskId}`);
    await taskRow.waitFor({ state: "visible", timeout: 15_000 });
    const acceptedSnapshot = await snapshot(session);
    const acceptedTask = acceptedSnapshot.tasks.find((item) => item.id === taskId);
    assert.ok(acceptedTask, "Added link did not create visible task feedback");
    const completed = await verifyCompletedMedia(session, taskId, "first-download-completed");
    const openButton = taskRow.getByRole("button", { name: "打开", exact: true });
    await openButton.waitFor({ state: "visible", timeout: 15_000 });
    assertInside(root, completed.path, "Downloaded file");
    assertInside(root, firstSnapshot.settings.download_dir, "Default output directory");
    assert.deepEqual(session.pageErrors, [], "Renderer emitted page errors during first download");

    const report = {
      target: "macos-arm64",
      result: "passed",
      recordedAt: new Date().toISOString(),
      candidateVersion: options.expectedVersion,
      candidateArtifactSha256: sha256File(options.candidateArtifact),
      packageExecutableSha256: sha256File(options.packageExecutable),
      installedExecutableSha256: sha256File(executable),
      installMethod: "isolated-app-copy-from-package",
      manualInstallation: false,
      freshDataDirectory: true,
      configurationCreatedOnFirstLaunch: true,
      defaultOutputInsideIsolatedHome: true,
      firstDownloadInputVisible: true,
      downloadDirectoryGuard,
      addedLinkFeedbackVisible: true,
      acceptedTaskInitialStatus: acceptedTask.status,
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
    assert.equal(report.packageExecutableSha256, report.installedExecutableSha256, "Installed executable differs from package");
    fs.mkdirSync(path.dirname(options.resultsPath), { recursive: true });
    fs.writeFileSync(options.resultsPath, `${JSON.stringify(report, null, 2)}\n`);
    passed = true;
    return report;
  } finally {
    try { await closeGateApp(session); } finally {
      await session.faultServer?.close();
      if (passed) fs.rmSync(root, { recursive: true, force: true });
      else console.error(`First-install evidence retained for diagnosis: ${root}`);
    }
  }
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log("node scripts/run_v031_macos_first_install.mjs --package-executable=<absolute executable from mounted DMG> --candidate-artifact=<absolute DMG> --playwright-module=<absolute Playwright directory> --results=<absolute results.json> [--expected-version=0.3.1]");
    return;
  }
  const report = await run(parseArguments(process.argv.slice(2)));
  console.log(`macOS first-install gate ${report.result}: ${report.candidateVersion}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error?.message || "macOS first-install gate failed");
    process.exitCode = 1;
  });
}
