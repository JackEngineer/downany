/** 验证 macOS 候选包对关键下载失败的解释与恢复入口。 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
  private: {
    detail: "此内容为私密内容，请登录有访问权限的账号后重试",
    recoveryActions: ["选择登录状态", "网页识别"],
    retryVisible: true,
  },
  geo_blocked: {
    detail: "此内容在当前地区不可用，请检查网络设置后重试",
    recoveryActions: ["检查网络设置"],
    retryVisible: true,
  },
  ytdlp_outdated: {
    detail: "下载工具需要更新，更新后即可重试",
    recoveryActions: ["更新下载工具"],
    retryVisible: true,
  },
  need_po_token: {
    detail: "页面需要额外验证，请改用网页识别",
    recoveryActions: ["网页识别"],
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
  output_path_invalid: {
    detail: "下载位置或文件名不可用，请检查下载位置和命名设置",
    recoveryActions: ["检查下载设置"],
    retryVisible: true,
  },
});

const SEEDED_CODES = Object.freeze([
  "private", "geo_blocked", "ytdlp_outdated", "need_po_token", "output_path_invalid",
]);

export function buildSeededFailureSql(assignments) {
  assert.equal(assignments.length, SEEDED_CODES.length, "Seeded presentation cases are incomplete");
  const ids = new Set();
  const codes = new Set();
  const statements = assignments.map(({ id, errorCode }) => {
    assert.match(id || "", /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i,
      "Seeded task id is invalid");
    assert.ok(SEEDED_CODES.includes(errorCode), "Seeded error code is invalid");
    assert.ok(!ids.has(id), "Seeded task id is duplicated");
    assert.ok(!codes.has(errorCode), "Seeded error code is duplicated");
    ids.add(id);
    codes.add(errorCode);
    return `UPDATE task_queue SET error_code='${errorCode}', error_message='Seeded acceptance failure' WHERE id='${id}';`;
  });
  assert.ok(SEEDED_CODES.every((code) => codes.has(code)), "Seeded presentation cases are incomplete");
  return ["BEGIN IMMEDIATE;", ...statements, "COMMIT;"].join("\n");
}

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

async function inspectFailurePresentation(session, task, evidenceKind) {
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
    evidenceKind,
    detail: expected.detail,
    recoveryActions,
    retryVisible,
  };
}

function seedFailureCodes(databasePath, assignments) {
  execFileSync("sqlite3", [databasePath, buildSeededFailureSql(assignments)], {
    encoding: "utf8", timeout: 15_000,
  });
}

async function verifySettingsNavigation(session, task, actionName, control) {
  const row = session.page.locator(`#task-${task.id}`);
  await row.getByRole("button", { name: actionName, exact: true }).click();
  const located = await waitForTask(
    async () => {
      for (const page of session.app.windows()) {
        if (page.isClosed() || !page.url().includes("settings.html")) continue;
        try {
          const focused = await page.evaluate((selector) => {
            const element = document.querySelector(selector);
            return Boolean(element && document.activeElement === element);
          }, control.selector);
          if (focused) return page;
        } catch {
          // Electron may replace the settings page while the main window is
          // dispatching the next focus target; retry against the live pages.
        }
      }
      return null;
    },
    (page) => !!page,
    { timeoutMs: 15_000, pollIntervalMs: 100 },
  );
  const settingsPage = located;
  if (!session.observedSettingsPages.has(settingsPage)) {
    session.observedSettingsPages.add(settingsPage);
    settingsPage.on("pageerror", (error) => session.pageErrors.push(error.message));
  }
  return { errorCode: task.error_code, action: actionName, focusedControl: control.name };
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
    observedSettingsPages: new Set(),
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
    const seededAssignments = [];
    for (const [index, errorCode] of SEEDED_CODES.entries()) {
      const placeholder = await createFailedTask(
        session,
        `${session.faultServer.baseUrl}/unsupported.mp4?seeded=${index + 1}`,
        "unsupported",
      );
      seededAssignments.push({ id: placeholder.id, errorCode });
    }
    await closeGateApp(session);
    seedFailureCodes(path.join(directories.dataDir, "history.db"), seededAssignments);
    await launchGateApp(session);
    const seededSnapshot = await snapshot(session);
    for (const assignment of seededAssignments) {
      const task = seededSnapshot.tasks.find((item) => item.id === assignment.id);
      assert.equal(task?.error_code, assignment.errorCode, `Seeded ${assignment.errorCode} task was not restored`);
      tasks.push(task);
    }
    await session.page.getByRole("button", { name: /^全部 \d+$/ }).click();
    const cases = [];
    for (const task of tasks) {
      const evidenceKind = SEEDED_CODES.includes(task.error_code)
        ? "seeded-package-presentation"
        : task.error_code === "need_login" || task.error_code === "removed"
          ? "external-classification"
          : "controlled-classification";
      cases.push(await inspectFailurePresentation(session, task, evidenceKind));
    }
    assert.deepEqual(cases.map((item) => item.errorCode), [
      "network", "need_login", "unsupported", "removed", ...SEEDED_CODES,
    ]);
    const byCode = new Map(tasks.map((task) => [task.error_code, task]));
    const navigation = [];
    for (const [errorCode, action, control] of [
      ["network", "检查网络设置", { name: "启用代理", selector: "#settings-focus-network" }],
      ["need_login", "选择登录状态", { name: "从浏览器导入 Cookie", selector: "#settings-focus-cookies" }],
      ["ytdlp_outdated", "更新下载工具", { name: "检查更新", selector: "#settings-focus-download-tool" }],
      ["output_path_invalid", "检查下载设置", { name: "下载目录", selector: "#settings-focus-download" }],
    ]) {
      navigation.push(await verifySettingsNavigation(session, byCode.get(errorCode), action, control));
    }
    for (const page of session.app.windows()) {
      if (!page.isClosed() && page.url().includes("settings.html")) await page.close();
    }
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
      seededPresentationOnly: [...SEEDED_CODES],
      settingsNavigation: navigation,
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
