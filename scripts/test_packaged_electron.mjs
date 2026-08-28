#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

import {
  assertBridgeUnused,
  assertSmokeTaskVisible,
  buildPackagedSmokeEnvironment,
  enqueueSmokeTask,
  prepareSmokeData,
  stopChildProcessTree,
  waitForBridgeReady,
} from "./package_smoke_helpers.mjs";

function requiredArgument(name) {
  const prefix = `--${name}=`;
  const value = process.argv
    .slice(2)
    .find((arg) => arg.startsWith(prefix))
    ?.slice(prefix.length);
  if (!value) {
    throw new Error(
      "usage: node scripts/test_packaged_electron.mjs " +
        "--executable=<absolute-path> [--user-data-dir=<absolute-path>]",
    );
  }
  return path.resolve(value);
}

function optionalArgument(name) {
  const prefix = `--${name}=`;
  const value = process.argv
    .slice(2)
    .find((arg) => arg.startsWith(prefix))
    ?.slice(prefix.length);
  return value ? path.resolve(value) : null;
}

function removeOwnedDataRoot(dataRoot) {
  const resolvedTemp = fs.realpathSync(os.tmpdir());
  const resolvedRoot = fs.realpathSync(dataRoot);
  const relative = path.relative(resolvedTemp, resolvedRoot);
  if (
    !relative ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    !path.basename(resolvedRoot).startsWith("downany-packaged-electron-")
  ) {
    throw new Error(`refusing to remove unexpected smoke directory: ${resolvedRoot}`);
  }
  fs.rmSync(resolvedRoot, { recursive: true, force: true });
}

const executable = requiredArgument("executable");
if (!path.isAbsolute(executable) || !fs.existsSync(executable) || !fs.statSync(executable).isFile()) {
  throw new Error(`packaged Electron executable does not exist: ${executable}`);
}

const suppliedDataRoot = optionalArgument("user-data-dir");
const dataRoot = suppliedDataRoot
  ? suppliedDataRoot
  : fs.mkdtempSync(path.join(os.tmpdir(), "downany-packaged-electron-"));
const ownsDataRoot = suppliedDataRoot === null;
const electronUserDataDir = path.join(dataRoot, "electron-user-data");
const { dataDir: downanyDataDir } = prepareSmokeData(dataRoot);
fs.mkdirSync(electronUserDataDir, { recursive: true });

let child = null;
let stdout = "";
let stderr = "";
try {
  await assertBridgeUnused();
  child = spawn(
    executable,
    [
      "--no-sandbox",
      "--disable-gpu",
      `--user-data-dir=${electronUserDataDir}`,
    ],
    {
      cwd: path.dirname(executable),
      env: buildPackagedSmokeEnvironment(process.env, downanyDataDir),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    },
  );
  child.stdout?.on("data", (chunk) => {
    stdout = `${stdout}${String(chunk)}`.slice(-4_000);
  });
  child.stderr?.on("data", (chunk) => {
    stderr = `${stderr}${String(chunk)}`.slice(-8_000);
  });

  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  await waitForBridgeReady({
    child,
    getStderr: () => `${stderr}${stdout ? `; stdout=${stdout}` : ""}`,
  });
  const taskId = await enqueueSmokeTask();
  const task = await assertSmokeTaskVisible({ taskId });
  console.log(
    `Packaged Electron first-use smoke passed ` +
      `(pid=${child.pid}, taskId=${taskId}, status=${task.status})`,
  );
} finally {
  if (child) await stopChildProcessTree(child);
  if (ownsDataRoot) removeOwnedDataRoot(dataRoot);
}
