/** 验证 macOS 候选包对关键下载失败的解释与恢复入口。 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { copyInstalledApp } from "./run_v031_macos_upgrade.mjs";
import { closeGateApp, launchGateApp, snapshot } from "./test_windows_real_downloads.mjs";
import { createMediaFaultServer } from "./windows_media_fault_server.mjs";
import {
  buildDownloadGateEnvironment,
  prepareDownloadGateRoot,
  sha256File,
  waitForTask,
} from "./windows_real_download_helpers.mjs";

const EXPECTED = Object.freeze({
  network: {
    detail: "网络连接失败，请检查网络或代理后重试",
    recoveryActions: ["检查网络设置"],
    retryVisible: true,
  },
  need_login: {
    detail: "需要登录后才能下载，请选择浏览器登录状态后重试",
    recoveryActions: ["选择登录状态", "网页识别"],
    retryVisible: true,
  },
  unsupported: {
    detail: "暂不支持直接下载此页面，请改用网页识别",
    recoveryActions: ["网页识别"],
    retryVisible: true,
  },
  removed: {
    detail: "此内容已被删除或不可用",
    recoveryActions: [],
    retryVisible: false,
  },
});

export function parseArguments(rawArguments) {
  const allowed = new Set([
    "--package-executable", "--candidate-artifact", "--playwright-module", "--results",
    "--login-url", "--removed-url", "--expected-version",
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
    "--package-executable", "--candidate-artifact", "--playwright-module", "--results", "--login-url", "--removed-url",
  ];
  assert.ok(required.every((name) => args.has(name)), "Package, external samples, Playwright and results paths are required");
  for (const name of required.slice(0, 4)) assert.ok(path.isAbsolute(args.get(name)), `${name} must be absolute`);
  for (const name of ["--login-url", "--removed-url"]) {
    const url = new URL(args.get(name));
    assert.equal(url.protocol, "https:", `${name} must use https`);
  }
  const expectedVersion = args.get("--expected-version") || "0.3.1";
  assert.match(expectedVersion, /^\d+\.\d+\.\d+$/, "Expected version must be major.minor.patch");
  return {
    packageExecutable: args.get("--package-executable"),
    candidateArtifact: args.get("--candidate-artifact"),
    playwrightModule: args.get("--playwright-module"),
    resultsPath: args.get("--results"),
    loginUrl: args.get("--login-url"),
    removedUrl: args.get("--removed-url"),
    expectedVersion,
  };
}

async function createFailedTask(session, url, expectedCode) {
  const reply = await session.page.evaluate((sourceUrl) => window.api.request("download.createTasks", {
    urls: [sourceUrl],
    expandPlaylists: false,
  }), url);
  assert.equal(reply.taskIds?.length, 1, "Error case must create one task");
  const taskId = reply.taskIds[0];
  const task = await waitForTask(async () => (await snapshot(session)).tasks.find((item) => item.id === taskId),
    (item) => item?.status === "failed" && item.error_code === expectedCode,
    { timeoutMs: 180_000, pollIntervalMs: 500 });
  return task;
}

async function inspectFailurePresentation(session, task) {
  const expected = EXPECTED[task.error_code];
  assert.ok(expected, `Unexpected error code: ${task.error_code}`);
  const row = session.page.locator(`#task-${task.id}`);
  await row.waitFor({ state: "visible", timeout: 15_000 });
  await row.getByText(expected.detail, { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
  const recoveryActions = (await row.locator(".media-task-banner__recovery-action").allTextContents())
    .map((item) => item.trim()).filter(Boolean);
  const retryVisible = await row.getByRole("button", { name: "重试", exact: true }).count() > 0;
  assert.deepEqual(recoveryActions, expected.recoveryActions, `${task.error_code} recovery actions changed`);
  assert.equal(retryVisible, expected.retryVisible, `${task.error_code} retry visibility changed`);
  return {
    errorCode: task.error_code,
    detail: expected.detail,
    recoveryActions,
    retryVisible,
  };
}

export async function run(options) {
  assert.equal(process.platform, "darwin", "This gate targets macOS only");
  assert.equal(process.arch, "arm64", "This gate targets Apple Silicon only");
  for (const file of [options.packageExecutable, options.candidateArtifact]) {
    assert.ok(fs.statSync(file).isFile(), "Error UI package input is missing");
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "downany-v031-macos-error-ui-"));
  const directories = prepareDownloadGateRoot(root);
  const installRoot = path.join(root, "Applications");
  fs.mkdirSync(installRoot);
  const executable = copyInstalledApp(options.packageExecutable, path.join(installRoot, "Downany.app"), root);
  const mediaPath = path.join(root, "fault-source.mp4");
  fs.writeFileSync(mediaPath, Buffer.alloc(128 * 1024, 0x5a));
  const require = createRequire(path.join(options.playwrightModule, "package.json"));
  const session = {
    playwright: require("playwright"),
    executable,
    expectedVersion: options.expectedVersion,
    root,
    ...directories,
    environment: buildDownloadGateEnvironment(process.env, directories.dataDir),
    pageErrors: [], stderr: "", cases: [], launches: [], app: null, browser: null,
  };
  let passed = false;
  try {
    session.faultServer = await createMediaFaultServer(mediaPath);
    session.faultServer.setMode("/network.mp4", "service-unavailable");
    session.faultServer.setMode("/unsupported.mp4", "missing");
    await launchGateApp(session);
    const tasks = [];
    tasks.push(await createFailedTask(session, `${session.faultServer.baseUrl}/network.mp4`, "network"));
    tasks.push(await createFailedTask(session, options.loginUrl, "need_login"));
    tasks.push(await createFailedTask(session, `${session.faultServer.baseUrl}/unsupported.mp4`, "unsupported"));
    tasks.push(await createFailedTask(session, options.removedUrl, "removed"));
    await session.page.getByRole("button", { name: /^全部 \d+$/ }).click();
    const cases = [];
    for (const task of tasks) cases.push(await inspectFailurePresentation(session, task));
    assert.deepEqual(cases.map((item) => item.errorCode), ["network", "need_login", "unsupported", "removed"]);
    assert.deepEqual(session.pageErrors, [], "Renderer emitted page errors during error presentation");
    const report = {
      target: "macos-arm64",
      result: "passed",
      recordedAt: new Date().toISOString(),
      candidateVersion: options.expectedVersion,
      candidateArtifactSha256: sha256File(options.candidateArtifact),
      packageExecutableSha256: sha256File(options.packageExecutable),
      installedExecutableSha256: sha256File(executable),
      externalSamples: { loginRequired: true, removed: true },
      controlledSamples: { serviceUnavailable: true, unsupportedRoute: true },
      manualInspection: false,
      cases,
    };
    assert.equal(report.packageExecutableSha256, report.installedExecutableSha256);
    fs.mkdirSync(path.dirname(options.resultsPath), { recursive: true });
    fs.writeFileSync(options.resultsPath, `${JSON.stringify(report, null, 2)}\n`);
    passed = true;
    return report;
  } finally {
    try { await closeGateApp(session); } finally {
      await session.faultServer?.close();
      if (passed) fs.rmSync(root, { recursive: true, force: true });
      else console.error(`Error UI evidence retained for diagnosis: ${root}`);
    }
  }
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log("node scripts/run_v031_macos_error_ui.mjs --package-executable=<absolute executable from mounted DMG> --candidate-artifact=<absolute DMG> --playwright-module=<absolute Playwright directory> --results=<absolute results.json> --login-url=<authorized https sample> --removed-url=<removed https sample> [--expected-version=0.3.1]");
    return;
  }
  const report = await run(parseArguments(process.argv.slice(2)));
  console.log(`macOS error UI gate ${report.result}: ${report.cases.length} cases`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error?.message || "macOS error UI gate failed");
    process.exitCode = 1;
  });
}
