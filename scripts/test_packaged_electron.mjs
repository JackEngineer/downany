#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function requiredArgument(name) {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  if (!value) throw new Error(`usage: node scripts/test_packaged_electron.mjs --executable=<absolute-path> [--user-data-dir=<absolute-path>]`);
  return path.resolve(value);
}

const executable = requiredArgument("executable");
if (!fs.existsSync(executable) || !fs.statSync(executable).isFile()) {
  throw new Error(`packaged Electron executable does not exist: ${executable}`);
}

const suppliedDataDir = process.argv.slice(2).find((arg) => arg.startsWith("--user-data-dir="));
const dataDir = suppliedDataDir
  ? path.resolve(suppliedDataDir.slice("--user-data-dir=".length))
  : fs.mkdtempSync(path.join(os.tmpdir(), "downany-packaged-electron-"));
const ownsDataDir = !suppliedDataDir;
fs.mkdirSync(dataDir, { recursive: true });

const child = spawn(executable, [
  "--no-sandbox",
  "--disable-gpu",
  `--user-data-dir=${dataDir}`,
], {
  cwd: path.dirname(executable),
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let stderr = "";
child.stderr?.on("data", (chunk) => {
  stderr = `${stderr}${String(chunk)}`.slice(-4000);
});

function waitForExit(timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

try {
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  const exitedEarly = await waitForExit(8_000);
  if (exitedEarly) {
    throw new Error(`packaged Electron exited before startup smoke completed (code=${child.exitCode}, signal=${child.signalCode})${stderr ? `: ${stderr}` : ""}`);
  }
  console.log(`Packaged Electron startup smoke passed (pid=${child.pid})`);
} finally {
  if (child.exitCode === null) {
    child.kill();
    const stopped = await waitForExit(3_000);
    if (!stopped && process.platform === "win32" && child.pid) {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      await new Promise((resolve) => killer.once("exit", resolve));
    } else if (!stopped && child.pid) {
      try { process.kill(child.pid, "SIGKILL"); } catch { /* already exited */ }
    }
  }
  if (ownsDataDir) fs.rmSync(dataDir, { recursive: true, force: true });
}
