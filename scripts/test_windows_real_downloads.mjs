/** Opt-in installed Windows E2E gate. Never uses the daily app/browser profile. */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { assertBridgeUnused, stopChildProcessTree } from "./package_smoke_helpers.mjs";
import { createMediaFaultServer } from "./windows_media_fault_server.mjs";
import {
  assertCompletedDownload, assertGateCoverage, buildDownloadGateEnvironment, captureAudit, parseGateArguments,
  prepareDownloadGateRoot, sha256File, validateMediaProbe, waitForTask,
} from "./windows_real_download_helpers.mjs";

const runFile = promisify(execFile);
export const PUBLIC_SAMPLE = Object.freeze({
  url: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4",
  page: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4",
  title: "MDN flower video sample",
  license: "CC0 1.0",
  licenseUrl: "https://github.com/mdn/interactive-examples/blob/main/LICENSE",
  attribution: "MDN interactive examples",
});

function protectedDataDigest() {
  const roots = [
    ["downany", path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Downany")],
    ["electron", path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "downany-desktop")],
  ];
  const records = [];
  let totalBytes = 0;
  const assertAuditLimit = (condition) => {
    if (!condition) throw Object.assign(new Error("Protected file audit limit exceeded"), { code: "AUDIT_LIMIT_EXCEEDED" });
  };
  const walk = (root, directory, label) => {
    if (!fs.existsSync(directory)) return;
    assert.ok(!fs.lstatSync(directory).isSymbolicLink(), "Protected data contains a junction; audit it separately");
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      assert.ok(!item.isSymbolicLink(), "Protected data contains a junction; audit it separately");
      if (item.isDirectory()) walk(root, file, label);
      else if (item.isFile()) {
        const size = fs.statSync(file).size;
        totalBytes += size;
        assertAuditLimit(records.length < 10_000 && size <= 64 * 1024 * 1024 && totalBytes <= 256 * 1024 * 1024);
        records.push([label, path.relative(root, file), size, sha256File(file)]);
      }
    }
  };
  for (const [label, root] of roots) walk(root, root, label);
  records.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { files: records.length, sha256: crypto.createHash("sha256").update(JSON.stringify(records)).digest("hex") };
}

function installedIdentity(executable) {
  const base = path.dirname(executable);
  return Object.fromEntries([
    "Downany.exe", "resources/app.asar", "resources/sidecar/DownanySidecar/DownanySidecar.exe",
    "resources/bin/ffmpeg.exe", "resources/bin/ffprobe.exe",
  ].map((name) => [name, sha256File(path.join(base, name))]));
}

export async function launchGateApp(session) {
  await assertBridgeUnused();
  session.app = await session.playwright._electron.launch({
    executablePath: session.executable,
    args: [`--user-data-dir=${session.profileDir}`],
    cwd: path.dirname(session.executable),
    env: session.environment,
    timeout: 60_000,
  });
  session.app.process().stderr?.on("data", (chunk) => {
    session.stderr = (session.stderr + String(chunk)).slice(-32_000);
  });
  session.page = await session.app.firstWindow({ timeout: 30_000 });
  session.page.on("pageerror", (error) => session.pageErrors.push(error.message));
  await session.page.waitForFunction(() => !!window.api, undefined, { timeout: 30_000 });
  await session.page.getByRole("textbox", { name: "添加下载链接", exact: true }).waitFor({ state: "visible" });
  await session.page.waitForFunction(() => !document.querySelector('input[aria-label="添加下载链接"]')?.disabled);
  const identity = await session.app.evaluate(({ app, BrowserWindow }) => ({
    version: app.getVersion(), userData: app.getPath("userData"),
    bounds: BrowserWindow.getAllWindows()[0].getBounds(),
  }));
  assert.equal(identity.version, session.expectedVersion);
  assert.equal(path.resolve(identity.userData), path.resolve(session.profileDir));
  session.launches.push({ ...identity, pid: session.app.process().pid });
  return session.page;
}

export async function startWindowsDownloadSession({ playwright, executable, expectedVersion = "0.3.0",
  suite = "public-direct", expectedCases = ["public-direct"] }) {
  assert.equal(process.platform, "win32", "This gate targets Windows only");
  assert.ok(path.isAbsolute(executable) && fs.statSync(executable).isFile());
  assert.equal(path.basename(executable).toLowerCase(), "downany.exe");
  await assertBridgeUnused();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "downany-real-download-"));
  const directories = prepareDownloadGateRoot(root);
  const protectedAudit = captureAudit(protectedDataDigest);
  const installedAudit = captureAudit(() => installedIdentity(executable));
  const session = {
    playwright, executable, expectedVersion, suite, expectedCases, root, ...directories,
    environment: buildDownloadGateEnvironment(process.env, directories.dataDir),
    protectedBefore: protectedAudit.value, installedBefore: installedAudit.value,
    baselineAuditErrors: { protectedData: protectedAudit.error, installedFiles: installedAudit.error },
    pageErrors: [], stderr: "", cases: [], launches: [], app: null, browser: null,
  };
  console.log(`Owned evidence: ${root}`);
  fs.writeFileSync(path.join(root, "sample-license.json"), JSON.stringify(PUBLIC_SAMPLE, null, 2) + "\n");
  try {
    assert.ok(!protectedAudit.error && !installedAudit.error, "Pre-launch safety audit failed");
    await launchGateApp(session);
    await session.page.screenshot({ path: path.join(root, "startup.png") });
    return session;
  } catch (error) {
    await finishWindowsDownloadSession(session, { error });
    throw error;
  }
}

export async function snapshot(session) {
  return session.page.evaluate(() => window.api.request("app.getSnapshot", {}));
}

export async function addFromInput(session, url) {
  const before = new Set((await snapshot(session)).tasks.map((task) => task.id));
  const input = session.page.getByRole("textbox", { name: "添加下载链接", exact: true });
  await input.fill(url);
  await input.press("Enter");
  const task = await waitForTask(async () => (await snapshot(session)).tasks.find((item) => !before.has(item.id)),
    (item) => !!item, { timeoutMs: 30_000 });
  return task.id;
}

export async function taskState(session, taskId, state, options = {}) {
  return waitForTask(async () => (await snapshot(session)).tasks.find((item) => item.id === taskId),
    (task) => task?.status === state && (!options.progress || task.downloaded_bytes > 0), options);
}

export async function verifyCompletedMedia(session, taskId, label) {
  const task = await taskState(session, taskId, "completed", { timeoutMs: 240_000 });
  const file = assertCompletedDownload(task, session.outputDir);
  const bin = path.join(path.dirname(session.executable), "resources", "bin");
  const result = await runFile(path.join(bin, "ffprobe.exe"), [
    "-v", "error", "-show_streams", "-show_format", "-of", "json", file.path,
  ], { windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 });
  const media = validateMediaProbe(JSON.parse(result.stdout));
  const decoded = await runFile(path.join(bin, "ffmpeg.exe"), [
    "-hide_banner", "-v", "error", "-nostdin", "-xerror", "-err_detect", "explode",
    "-i", file.path, "-map", "0:v:0", "-map", "0:a:0", "-f", "hash", "-hash", "sha256", "-",
  ], { windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024 });
  const match = /^SHA256=([a-f0-9]{64})\s*$/i.exec(decoded.stdout.trim());
  assert.ok(match, "Full audio/video decode did not produce a checksum");
  // External enqueue intentionally selects the active queue. Finished tasks
  // leave that view, so use the real filter control before checking the row.
  await session.page.getByRole("button", { name: /^全部 \d+$/ }).click();
  await session.page.locator(`#task-${taskId}`).getByText("已完成", { exact: true }).waitFor({ timeout: 15_000 });
  await session.page.screenshot({ path: path.join(session.root, `${label}.png`) });
  const evidence = { label, ...file, ...media, decodedSHA256: match[1].toLowerCase(), visibleCompleted: true };
  session.cases.push(evidence);
  fs.writeFileSync(path.join(session.root, "cases.json"), JSON.stringify(session.cases, null, 2) + "\n");
  return evidence;
}

export async function verifyPublicDirect(session) {
  const id = await addFromInput(session, PUBLIC_SAMPLE.url);
  return verifyCompletedMedia(session, id, "public-direct");
}

export async function openExtensionSession(session, { browserExecutable, extensionDir }) {
  assert.ok(path.isAbsolute(browserExecutable) && fs.statSync(browserExecutable).isFile());
  assert.ok(path.isAbsolute(extensionDir));
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, "manifest.json")));
  assert.equal(manifest.manifest_version, 3);
  session.browser = await session.playwright.chromium.launchPersistentContext(path.join(session.root, "browser-profile"), {
    executablePath: browserExecutable, headless: true, chromiumSandbox: true,
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
  });
  session.extensionWorker = session.browser.serviceWorkers()[0] ||
    await session.browser.waitForEvent("serviceworker", { timeout: 30_000 });
  session.extensionId = new URL(session.extensionWorker.url()).host;
  session.extensionVersion = manifest.version;
  session.website = await session.browser.newPage();
  await session.website.goto(PUBLIC_SAMPLE.page, { waitUntil: "domcontentloaded", timeout: 60_000 });
  return session.website;
}

export async function openExtensionPopup(session) {
  await session.website.bringToFront();
  const popupEvent = session.browser.waitForEvent("page", { timeout: 15_000 });
  // Keep the media tab active while the real popup document resolves activeTab.
  // The extension is unmodified; only its popup is hosted in a background test tab.
  await session.extensionWorker.evaluate(async () => {
    await chrome.tabs.create({ url: chrome.runtime.getURL("popup.html"), active: false });
  });
  session.popup = await popupEvent;
  await session.popup.waitForLoadState("domcontentloaded");
  await session.popup.waitForFunction((expected) => document.getElementById("url")?.textContent === expected,
    PUBLIC_SAMPLE.page, { timeout: 15_000 });
  return session.popup;
}

export async function verifyPublicExtension(session, options) {
  await openExtensionSession(session, options);
  await session.website.locator("video").waitFor({ state: "visible", timeout: 30_000 });
  await session.website.screenshot({ path: path.join(session.root, "extension-source.png") });
  const popup = await openExtensionPopup(session);
  await popup.locator("#mediaList .media-item").first().waitFor({ state: "visible", timeout: 30_000 });
  const candidates = await popup.locator("#mediaList").innerText();
  assert.ok(candidates.includes("flower") || candidates.includes("mdn.mozilla.net"), "Expected public sample not detected");
  assert.equal(await popup.locator("#mediaList .media-item").count(), 1);
  await popup.locator("#mediaList").getByRole("checkbox").check();
  await popup.screenshot({ path: path.join(session.root, "extension-before-enqueue.png") });
  const before = new Set((await snapshot(session)).tasks.map((task) => task.id));
  await popup.getByRole("button", { name: /^下载选中 \(1\)$/ }).click();
  await popup.locator("#status").getByText("已发送 1 个任务到下载器", { exact: true }).waitFor({ timeout: 30_000 });
  const task = await waitForTask(async () => (await snapshot(session)).tasks.find((item) => !before.has(item.id)),
    (item) => !!item, { timeoutMs: 30_000 });
  const evidence = await verifyCompletedMedia(session, task.id, "public-extension");
  await popup.screenshot({ path: path.join(session.root, "extension-after-enqueue.png") });
  evidence.extension = { version: session.extensionVersion, sourceUrl: PUBLIC_SAMPLE.page,
    uiAction: "download-selected", candidates, nativeToolbarPopup: false };
  // The browser has no role in the following recovery cases. Release its
  // isolated profile/processes before restarting Electron on smaller machines.
  await session.browser.close();
  session.browser = null;
  session.popup = null;
  session.website = null;
  return evidence;
}

export async function verifyFaultRecovery(session, source) {
  // Only the transport is controlled: installed yt-dlp, FFmpeg, SQLite and UI
  // remain real. Reuse the publicly downloaded bytes, never synthetic media.
  const server = await createMediaFaultServer(source.path, {
    chunkBytes: 8192, intervalMs: 75, interruptAfterBytes: 262144,
  });
  session.faultServer = server;
  // Test-only configuration: a disabled saved address suppresses automatic
  // proxy discovery. Clear inherited proxy variables in the owned child too.
  // Neither the user's proxy settings nor their app configuration are edited.
  const settings = await session.page.evaluate(() => window.api.request("settings.update", {
    proxy_enabled: false, proxy_url: "http://127.0.0.1:9",
  }));
  assert.equal(settings.proxy_enabled, false);
  await closeGateApp(session);
  for (const key of Object.keys(session.environment)) {
    if (/^(HTTPS?|ALL)_PROXY$/i.test(key)) delete session.environment[key];
  }
  session.environment.NO_PROXY = "127.0.0.1,localhost";
  session.environment.no_proxy = session.environment.NO_PROXY;
  session.recoveryUsesDirectLoopback = true;
  await launchGateApp(session);
  const completedBefore = session.cases.map((item) => ({ path: item.path, sha256: item.sha256 }));

  const retryPath = "/failed-then-retry.mp4";
  server.setMode(retryPath, "missing");
  const retryId = await addFromInput(session, server.baseUrl + retryPath);
  const failure = await taskState(session, retryId, "failed", { timeoutMs: 60_000 });
  assert.ok(server.requests.some((item) => item.pathname === retryPath && item.status === 404));
  await session.page.locator(`#task-${retryId}`).getByText("下载失败", { exact: true }).waitFor();
  await session.page.screenshot({ path: path.join(session.root, "retry-before.png") });
  server.setMode(retryPath, "healthy");
  await session.page.locator(`#task-${retryId}`).getByRole("button", { name: "重试", exact: true }).click();
  const retried = await verifyCompletedMedia(session, retryId, "failed-task-retry");
  assert.equal(retried.decodedSHA256, source.decodedSHA256);
  retried.recovery = { initialStatus: failure.status, initialErrorCode: failure.error_code,
    sameTaskId: true, uiAction: "retry", decodedMatchesSource: true };

  const pausePath = "/pause-restart-resume.mp4";
  const pauseId = await addFromInput(session, server.baseUrl + pausePath);
  const active = await taskState(session, pauseId, "downloading", { progress: true, timeoutMs: 60_000 });
  await session.page.locator(`#task-${pauseId}`).getByRole("button", { name: "暂停", exact: true }).click();
  const paused = await taskState(session, pauseId, "paused", { timeoutMs: 30_000 });
  await session.page.screenshot({ path: path.join(session.root, "paused-before-restart.png") });
  await closeGateApp(session);
  await launchGateApp(session);
  const restored = await taskState(session, pauseId, "paused", { timeoutMs: 30_000 });
  assert.equal(restored.id, paused.id);
  await session.page.locator(`#task-${pauseId}`).getByText("已暂停", { exact: true }).waitFor();
  await session.page.screenshot({ path: path.join(session.root, "paused-after-restart.png") });
  const beforeResume = server.requests.length;
  await session.page.locator(`#task-${pauseId}`).getByRole("button", { name: "继续", exact: true }).click();
  const resumed = await verifyCompletedMedia(session, pauseId, "pause-restart-resume");
  const rangeResume = server.requests.slice(beforeResume).find((item) =>
    item.pathname === pausePath && item.status === 206 && item.rangeStart > 0);
  assert.ok(rangeResume, "Resume must transfer a nonzero HTTP Range, not silently restart from zero");
  assert.equal(resumed.decodedSHA256, source.decodedSHA256);
  resumed.recovery = { activeBytes: active.downloaded_bytes, pausedBytes: paused.downloaded_bytes,
    restoredStatus: restored.status, sameTaskId: true, uiActions: ["pause", "continue"],
    rangeStart: rangeResume.rangeStart, decodedMatchesSource: true };

  const interruptPath = "/disconnect-once.mp4";
  server.setMode(interruptPath, "disconnect-once");
  const interruptedId = await addFromInput(session, server.baseUrl + interruptPath);
  const recovered = await verifyCompletedMedia(session, interruptedId, "network-interruption-recovery");
  const injected = server.requests.filter((item) => item.pathname === interruptPath && item.faultInjected);
  assert.equal(injected.length, 1, "Exactly one actual download response must be interrupted");
  const rangeAfterFault = server.requests.slice(server.requests.indexOf(injected[0]) + 1).find((item) =>
    item.pathname === interruptPath && item.status === 206 && item.rangeStart > 0);
  assert.ok(rangeAfterFault, "Interrupted download did not issue a nonzero resume Range");
  assert.equal(recovered.decodedSHA256, source.decodedSHA256);
  recovered.recovery = { faultInjected: true, interruptedBytes: injected[0].bytesSent,
    rangeStart: rangeAfterFault.rangeStart, decodedMatchesSource: true };
  for (const original of completedBefore) assert.equal(sha256File(original.path), original.sha256);
  session.previousCompletedFilesUnchanged = true;
  return [retried, resumed, recovered];
}

export async function closeGateApp(session) {
  if (!session.app) return;
  const child = session.app.process();
  try {
    await session.app.close();
  } finally {
    await stopChildProcessTree(child);
    session.app = null;
  }
}

export async function finishWindowsDownloadSession(session, { error = null } = {}) {
  const cleanupErrors = [];
  if (error) fs.writeFileSync(path.join(session.root, "failure-error.txt"), String(error) + "\n");
  if (error && session.page && !session.page.isClosed()) {
    try {
      await session.page.screenshot({ path: path.join(session.root, "failure-desktop.png") });
      fs.writeFileSync(path.join(session.root, "failure-desktop.txt"), await session.page.locator("body").innerText());
      fs.writeFileSync(path.join(session.root, "failure-snapshot.json"), JSON.stringify(await snapshot(session), null, 2) + "\n");
      if (session.popup && !session.popup.isClosed()) {
        await session.popup.screenshot({ path: path.join(session.root, "failure-extension.png") });
      }
    } catch (failure) { cleanupErrors.push(`Failure evidence capture: ${String(failure)}`); }
  }
  try { await session.browser?.close(); } catch (failure) { cleanupErrors.push(String(failure)); }
  try { await closeGateApp(session); } catch (failure) { cleanupErrors.push(String(failure)); }
  try { await session.faultServer?.close(); } catch (failure) { cleanupErrors.push(String(failure)); }
  try { await assertBridgeUnused(); } catch (failure) { cleanupErrors.push(String(failure)); }
  const protectedAudit = captureAudit(protectedDataDigest);
  const installedAudit = captureAudit(() => installedIdentity(session.executable));
  const protectedAfter = protectedAudit.value;
  const installedAfter = installedAudit.value;
  const unchanged = !!protectedAfter && !!session.protectedBefore &&
    JSON.stringify(protectedAfter) === JSON.stringify(session.protectedBefore);
  const sameInstallation = !!installedAfter && !!session.installedBefore &&
    JSON.stringify(installedAfter) === JSON.stringify(session.installedBefore);
  let coverageError = null;
  try { assertGateCoverage(session.cases, session.expectedCases); } catch (failure) { coverageError = String(failure); }
  const report = {
    result: !error && !coverageError && !cleanupErrors.length && unchanged && sameInstallation && !session.pageErrors.length ? "passed" : "failed",
    expectedVersion: session.expectedVersion, recordedAt: new Date().toISOString(),
    suite: session.suite, expectedCases: session.expectedCases, coverageError,
    root: session.root, sample: PUBLIC_SAMPLE, cases: session.cases, launches: session.launches,
    extensionVersion: session.extensionVersion || null, rendererErrors: session.pageErrors,
    httpRequests: session.faultServer?.requests || [],
    previousCompletedFilesUnchanged: session.previousCompletedFilesUnchanged ?? null,
    protectedData: { before: session.protectedBefore, after: protectedAfter, unchanged },
    auditErrors: { before: session.baselineAuditErrors,
      after: { protectedData: protectedAudit.error, installedFiles: installedAudit.error } },
    installedFilesUnchanged: sameInstallation, installedBefore: session.installedBefore,
    cleanupErrors, error: error ? String(error) : null,
    boundaries: { auditsExistingFilesReadOnly: true, recoveryUsesDirectLoopback: !!session.recoveryUsesDirectLoopback,
      externalAccounts: false, telegramSend: false, installerChanged: false, physicalOSReboot: false,
      macOS: false, published: false, extensionToolbarPopup: false },
  };
  fs.writeFileSync(path.join(session.root, "result.json"), JSON.stringify(report, null, 2) + "\n");
  fs.writeFileSync(path.join(session.root, "electron-stderr.log"), session.stderr);
  assert.equal(report.result, "passed", `Gate failed; see ${session.root}`);
  return report;
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log("node scripts/test_windows_real_downloads.mjs --executable=<absolute Downany.exe> --playwright-module=<absolute playwright directory> --browser-executable=<test Chromium.exe> --extension-dir=<unpacked candidate extension> [--expected-version=0.3.0] [--suite=all|public-direct|public-extension|recovery]\nDefault all requires every external and recovery case; partial suites are diagnostic only.");
    return;
  }
  const options = parseGateArguments(process.argv.slice(2));
  const require = createRequire(path.join(options.playwrightModule, "package.json"));
  const session = await startWindowsDownloadSession({ ...options, playwright: require("playwright") });
  let failure = null;
  try {
    const source = await verifyPublicDirect(session);
    console.log(JSON.stringify(source));
    if (options.expectedCases.includes("public-extension")) {
      console.log(JSON.stringify(await verifyPublicExtension(session, {
        browserExecutable: options.browserExecutable, extensionDir: options.extensionDir,
      })));
    }
    if (options.expectedCases.includes("failed-task-retry")) {
      for (const item of await verifyFaultRecovery(session, source)) console.log(JSON.stringify(item));
    }
  } catch (error) { failure = error; }
  const result = await finishWindowsDownloadSession(session, { error: failure });
  console.log(`Windows real-download ${result.suite === "all" ? "gate" : "diagnostic suite"} ${result.result}; evidence: ${session.root}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
