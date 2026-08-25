import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { assertDiagnosticZipMembers } from "./package_smoke_helpers.mjs";

const args = new Map(
  process.argv.slice(2).map((value) => {
    const index = value.indexOf("=");
    return index < 0 ? [value, ""] : [value.slice(0, index), value.slice(index + 1)];
  }),
);
const executable = args.get("--executable");
const dataDir = args.get("--data-dir");
if (!executable || !path.isAbsolute(executable) || !dataDir || !path.isAbsolute(dataDir)) {
  throw new Error("usage: node test_packaged_sidecar.mjs --executable=<absolute> --data-dir=<absolute>");
}
fs.mkdirSync(dataDir, { recursive: true });

const child = spawn(executable, [], {
  cwd: path.dirname(executable),
  env: { ...process.env, DOWNANY_DATA_DIR: dataDir, PYTHONUNBUFFERED: "1" },
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");

let output = "";
let errors = "";
let buffer = "";
const messages = [];
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    try {
      messages.push(JSON.parse(line));
    } catch {
      output += `${line}\n`;
    }
  }
});
child.stderr.on("data", (chunk) => { errors += chunk; });

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function waitFor(predicate, timeoutMs) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const found = messages.find(predicate);
      if (found) return resolve(found);
      if (Date.now() - startedAt >= timeoutMs) {
        return reject(new Error(`Sidecar protocol timeout; output=${output}; stderr=${errors}`));
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}

try {
  await waitFor((message) => message.type === "hello", 20_000);
  send({ protocolVersion: 1, type: "hello", payload: { app: "Downany", appVersion: "smoke" }, timestamp: new Date().toISOString() });
  send({ protocolVersion: 1, type: "request", id: "packaged-sidecar-ping", method: "app.ping", payload: {}, timestamp: new Date().toISOString() });
  const response = await waitFor((message) => message.type === "response" && message.correlationId === "packaged-sidecar-ping", 10_000);
  if (response.error) throw new Error(`app.ping returned an error: ${JSON.stringify(response.error)}`);
  const expectedOffset = "9007199254740993";
  send({
    protocolVersion: 1,
    type: "request",
    id: "packaged-sidecar-telegram-configure",
    method: "telegram.configure",
    payload: { discoveredTargets: [], nextUpdateOffset: expectedOffset },
    timestamp: new Date().toISOString(),
  });
  const telegramConfig = await waitFor(
    (message) => message.type === "response" && message.correlationId === "packaged-sidecar-telegram-configure",
    10_000,
  );
  if (telegramConfig.error) {
    throw new Error(`telegram.configure returned an error: ${JSON.stringify(telegramConfig.error)}`);
  }
  if (telegramConfig.payload?.nextUpdateOffset !== expectedOffset) {
    throw new Error(`telegram.configure lost the exact update offset: ${JSON.stringify(telegramConfig.payload)}`);
  }
  send({
    protocolVersion: 1,
    type: "request",
    id: "packaged-sidecar-export-diagnostics",
    method: "app.exportDiagnostics",
    payload: {},
    timestamp: new Date().toISOString(),
  });
  const diagnostics = await waitFor(
    (message) => message.type === "response" && message.correlationId === "packaged-sidecar-export-diagnostics",
    30_000,
  );
  if (diagnostics.error) {
    throw new Error(`app.exportDiagnostics returned an error: ${JSON.stringify(diagnostics.error)}`);
  }
  const diagnosticsPath = diagnostics.payload?.path;
  if (diagnostics.payload?.ok !== true || typeof diagnosticsPath !== "string" || !path.isAbsolute(diagnosticsPath)) {
    throw new Error(`app.exportDiagnostics returned an invalid payload: ${JSON.stringify(diagnostics.payload)}`);
  }
  const diagnosticsRoot = fs.realpathSync(path.join(dataDir, "diagnostics"));
  const archivePath = fs.realpathSync(diagnosticsPath);
  const relativeArchive = path.relative(diagnosticsRoot, archivePath);
  if (!relativeArchive || relativeArchive.startsWith("..") || path.isAbsolute(relativeArchive)) {
    throw new Error(`diagnostic ZIP escaped the data directory: ${archivePath}`);
  }
  const archiveStat = fs.statSync(archivePath);
  if (!archiveStat.isFile() || archiveStat.size <= 0) {
    throw new Error(`diagnostic ZIP is not a non-empty regular file: ${archivePath}`);
  }
  assertDiagnosticZipMembers(fs.readFileSync(archivePath));
  send({ protocolVersion: 1, type: "request", id: "packaged-sidecar-shutdown", method: "app.shutdown", payload: {}, timestamp: new Date().toISOString() });
  await waitFor((message) => message.type === "response" && message.correlationId === "packaged-sidecar-shutdown", 10_000);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Sidecar did not exit after shutdown; stderr=${errors}`)), 10_000);
    child.once("exit", (code) => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(`Sidecar exited with ${code}; stderr=${errors}`)); });
  });
  console.log("Packaged Sidecar protocol and diagnostics smoke passed");
} catch (error) {
  child.kill();
  throw error;
}
