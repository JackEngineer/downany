import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { inflateRawSync } from "node:zlib";

export const BRIDGE_BASE = "http://127.0.0.1:17888";
export const DIAGNOSTIC_ZIP_MEMBERS = Object.freeze([
  "environment.json",
  "failed_tasks.json",
  "logs/summary.json",
  "privacy.json",
]);

const MAX_RESPONSE_BYTES = 64 * 1024;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_END_SIGNATURE = 0x06054b50;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_ENCRYPTED_FLAG = 0x0001;
const ZIP_STORED_METHOD = 0;
const ZIP_DEFLATE_METHOD = 8;
const MAX_DIAGNOSTIC_MEMBER_BYTES = 1024 * 1024;

export function buildPackagedSmokeEnvironment(inherited, dataDir) {
  return {
    ...inherited,
    DOWNANY_DATA_DIR: dataDir,
    DOWNANY_UPDATE_DISABLED: "1",
    DOWNANY_SKIP_PROTOCOL_REGISTRATION: "1",
  };
}

function assertInsideSmokeRoot(root, target) {
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Smoke paths must stay inside the isolated data root");
  }
  // Resolve the nearest existing ancestor before mkdir/write, including junctions.
  let ancestor = target;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const realRelative = path.relative(fs.realpathSync(root), fs.realpathSync(ancestor));
  if (realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
    throw new Error("Smoke paths must stay inside the isolated data root");
  }
}

export function prepareSmokeData(dataRoot) {
  if (!path.isAbsolute(dataRoot)) throw new Error("Smoke data root must be absolute");
  const root = path.resolve(dataRoot);
  fs.mkdirSync(root, { recursive: true });
  assertInsideSmokeRoot(root, path.join(root, "electron-user-data"));
  const dataDir = path.join(root, "downany-data");
  assertInsideSmokeRoot(root, dataDir);
  fs.mkdirSync(dataDir, { recursive: true });
  for (const markerName of [
    ".migration_v1_done",
    ".migration_videodownloader_done",
  ]) {
    const markerPath = path.join(dataDir, markerName);
    assertInsideSmokeRoot(root, markerPath);
    if (fs.existsSync(markerPath)) {
      if (!fs.lstatSync(markerPath).isFile()) {
        throw new Error("Smoke migration marker must be a regular file");
      }
    } else {
      fs.writeFileSync(markerPath, "ok\n", { flag: "wx" });
    }
  }
  const configPath = path.join(dataDir, "config.json");
  assertInsideSmokeRoot(root, configPath);
  let outputDir = path.join(root, "output");
  const exists = fs.existsSync(configPath);
  if (exists) {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (!config || typeof config.download_dir !== "string" || !path.isAbsolute(config.download_dir)) {
      throw new Error("Existing smoke configuration needs an absolute isolated download directory");
    }
    outputDir = path.resolve(config.download_dir);
  }
  assertInsideSmokeRoot(root, outputDir);
  fs.mkdirSync(outputDir, { recursive: true });
  if (!exists) {
    fs.writeFileSync(configPath, JSON.stringify({ download_dir: outputDir }, null, 2) + "\n", { flag: "wx" });
  }
  return { dataDir, outputDir };
}

function waitForProcessExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const onExit = () => {
      cleanup();
      resolve(true);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

export async function stopChildProcessTree(
  child,
  {
    platform = process.platform,
    spawnProcess = spawn,
    timeoutMs = 5_000,
  } = {},
) {
  const pid = child?.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) return;

  if (platform === "win32") {
    let killer;
    let taskkillResult = "unavailable";
    try {
      killer = spawnProcess("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      const taskkillExited = await waitForProcessExit(killer, timeoutMs);
      if (!taskkillExited) {
        try {
          killer.kill();
        } catch {
          // The command may have exited between the timeout and cleanup.
        }
      }
      taskkillResult = taskkillExited
        ? String(killer.exitCode ?? killer.signalCode ?? "unknown")
        : "timeout";
      if (taskkillExited && killer.exitCode === 0) {
        if (await waitForProcessExit(child, timeoutMs)) return;
      }
    } catch {
      // Keep the owned handle available when taskkill is unavailable or denied.
    }
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill();
    } catch {
      // The final wait reports a failure if the owned handle cannot terminate it.
    }
    if (await waitForProcessExit(child, timeoutMs)) return;
    throw new Error(
      `taskkill exited with ${taskkillResult}; packaged Electron is still running`,
    );
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      return;
    }
  }
  if (await waitForProcessExit(child, timeoutMs)) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // The process may already have exited.
    }
  }
  if (!(await waitForProcessExit(child, timeoutMs))) {
    throw new Error("packaged Electron process tree did not exit");
  }
}

function errorText(error) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\s+/g, " ").trim().slice(0, 500);
}

function isConnectionRefused(error) {
  let current = error;
  for (let depth = 0; current && depth < 4; depth += 1) {
    if (current.code === "ECONNREFUSED") return true;
    if (/ECONNREFUSED/i.test(String(current.message || ""))) return true;
    current = current.cause;
  }
  return false;
}

async function fetchWithTimeout(fetchImpl, url, options = {}, timeoutMs = 2_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function requestJson(fetchImpl, url, options = {}, timeoutMs = 2_000) {
  const response = await fetchWithTimeout(fetchImpl, url, options, timeoutMs);
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error(`bridge response exceeds ${MAX_RESPONSE_BYTES} bytes`);
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`bridge returned invalid JSON (HTTP ${response.status})`);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`bridge returned a non-object payload (HTTP ${response.status})`);
  }
  return { response, payload };
}

export async function assertBridgeUnused(fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchWithTimeout(
      fetchImpl,
      `${BRIDGE_BASE}/health`,
      { method: "GET" },
      1_000,
    );
    throw new Error(
      `Downany bridge is already responding before smoke start (HTTP ${response.status})`,
    );
  } catch (error) {
    if (isConnectionRefused(error)) return;
    if (/already responding/i.test(errorText(error))) throw error;
    throw new Error(
      `Could not prove the Downany bridge is unused: ${errorText(error) || "unknown error"}`,
    );
  }
}

export async function waitForBridgeReady({
  fetchImpl = globalThis.fetch,
  child,
  timeoutMs = 90_000,
  pollIntervalMs = 250,
  sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  getStderr = () => "",
}) {
  const startedAt = Date.now();
  let lastState = "bridge has not responded";
  while (Date.now() - startedAt <= timeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Packaged Electron exited before bridge readiness ` +
          `(code=${child.exitCode}, signal=${child.signalCode}); stderr=${errorText(getStderr())}`,
      );
    }
    try {
      const { response, payload } = await requestJson(
        fetchImpl,
        `${BRIDGE_BASE}/health`,
        { method: "GET" },
        2_000,
      );
      if (response.ok) {
        if (payload.service !== "downany-bridge") {
          throw new Error(`unexpected bridge service: ${String(payload.service || "missing")}`);
        }
        if (payload.ok === true && payload.sidecarReady === true) return payload;
        lastState = `sidecarReady=${String(payload.sidecarReady)}`;
      } else {
        lastState = `HTTP ${response.status}`;
      }
    } catch (error) {
      if (!isConnectionRefused(error)) {
        lastState = errorText(error) || "bridge request failed";
      }
    }
    if (Date.now() - startedAt >= timeoutMs) break;
    await sleep(pollIntervalMs);
  }
  throw new Error(
    `Timed out waiting for packaged Downany bridge readiness after ${timeoutMs}ms: ${lastState}; ` +
      `stderr=${errorText(getStderr())}`,
  );
}

export async function enqueueSmokeTask({
  fetchImpl = globalThis.fetch,
  url = "http://127.0.0.1:17888/downany-package-smoke",
} = {}) {
  const { response, payload } = await requestJson(
    fetchImpl,
    `${BRIDGE_BASE}/enqueue`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [{ url, title: "Downany 首次使用验收" }],
      }),
    },
    15_000,
  );
  const taskIds = Array.isArray(payload.taskIds)
    ? payload.taskIds.filter((value) => typeof value === "string" && value.trim())
    : [];
  if (
    !response.ok ||
    payload.ok !== true ||
    payload.count !== 1 ||
    taskIds.length !== 1
  ) {
    throw new Error(
      `Packaged bridge enqueue failed (HTTP ${response.status}, ok=${String(payload.ok)}, ` +
        `count=${String(payload.count)}, taskIds=${taskIds.length})`,
    );
  }
  return taskIds[0].trim();
}

export async function assertSmokeTaskVisible({
  taskId,
  fetchImpl = globalThis.fetch,
}) {
  const expectedId = String(taskId || "").trim();
  if (!expectedId) throw new Error("Smoke task id is empty");
  const { response, payload } = await requestJson(
    fetchImpl,
    `${BRIDGE_BASE}/tasks?ids=${encodeURIComponent(expectedId)}`,
    { method: "GET" },
    5_000,
  );
  const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
  const task = tasks.find((item) => item && item.id === expectedId);
  if (!response.ok || payload.ok !== true || !task) {
    throw new Error(
      `Packaged bridge did not return smoke task ${expectedId} (HTTP ${response.status})`,
    );
  }
  const status = typeof task.status === "string" ? task.status.trim() : "";
  if (!status || status === "unknown") {
    throw new Error(`Packaged bridge returned unknown status for smoke task ${expectedId}`);
  }
  return task;
}

function findZipEndRecord(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    throw new Error("ZIP end record is missing");
  }
  const minimum = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== ZIP_END_SIGNATURE) continue;
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === buffer.length) return offset;
  }
  throw new Error("ZIP end record is missing or truncated");
}

function decodeZipName(nameBytes, flags) {
  if ((flags & ZIP_UTF8_FLAG) !== 0) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(nameBytes);
    } catch {
      throw new Error("ZIP member name is not valid UTF-8");
    }
  }
  if ([...nameBytes].some((value) => value > 0x7f)) {
    throw new Error("ZIP member name requires UTF-8 encoding");
  }
  return nameBytes.toString("ascii");
}

export function listZipEntries(buffer) {
  const endOffset = findZipEndRecord(buffer);
  const diskNumber = buffer.readUInt16LE(endOffset + 4);
  const centralDisk = buffer.readUInt16LE(endOffset + 6);
  const entriesOnDisk = buffer.readUInt16LE(endOffset + 8);
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  const centralSize = buffer.readUInt32LE(endOffset + 12);
  const centralOffset = buffer.readUInt32LE(endOffset + 16);
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new Error("Multi-disk ZIP archives are not supported");
  }
  if (
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw new Error("ZIP64 diagnostic archives are not supported");
  }
  const centralEnd = centralOffset + centralSize;
  if (
    centralOffset < 0 ||
    centralEnd < centralOffset ||
    centralEnd !== endOffset ||
    centralEnd > buffer.length
  ) {
    throw new Error("ZIP central directory is outside archive bounds");
  }

  const names = [];
  const seen = new Set();
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > centralEnd || buffer.readUInt32LE(cursor) !== ZIP_CENTRAL_SIGNATURE) {
      throw new Error("ZIP central directory entry is truncated or invalid");
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    if ((flags & ZIP_ENCRYPTED_FLAG) !== 0) {
      throw new Error("Encrypted ZIP members are not allowed in diagnostics");
    }
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const entryEnd = cursor + 46 + nameLength + extraLength + commentLength;
    if (entryEnd > centralEnd) {
      throw new Error("ZIP central directory member exceeds archive bounds");
    }
    if (
      localOffset + 30 > centralOffset ||
      buffer.readUInt32LE(localOffset) !== ZIP_LOCAL_SIGNATURE
    ) {
      throw new Error("ZIP member local header is outside archive bounds");
    }
    const name = decodeZipName(buffer.subarray(cursor + 46, cursor + 46 + nameLength), flags);
    const localFlags = buffer.readUInt16LE(localOffset + 6);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const localHeaderEnd = localOffset + 30 + localNameLength + localExtraLength;
    if (localHeaderEnd > centralOffset) {
      throw new Error("ZIP member local name exceeds archive bounds");
    }
    if (localFlags !== flags) {
      throw new Error("ZIP member local flags do not match the central directory");
    }
    const localName = decodeZipName(
      buffer.subarray(localOffset + 30, localOffset + 30 + localNameLength),
      localFlags,
    );
    if (localName !== name) {
      throw new Error("ZIP member local name does not match the central directory");
    }
    if (!name || name.includes("\0")) throw new Error("ZIP member name is empty or invalid");
    if (seen.has(name)) throw new Error(`ZIP contains duplicate member: ${name}`);
    seen.add(name);
    names.push(name);
    cursor = entryEnd;
  }
  if (cursor !== centralEnd) {
    throw new Error("ZIP central directory size does not match its entries");
  }
  return names;
}

export function readZipEntry(
  buffer,
  expectedName,
  { maxBytes = MAX_DIAGNOSTIC_MEMBER_BYTES } = {},
) {
  listZipEntries(buffer);
  const endOffset = findZipEndRecord(buffer);
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  let cursor = buffer.readUInt32LE(endOffset + 16);
  for (let index = 0; index < entryCount; index += 1) {
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = decodeZipName(
      buffer.subarray(cursor + 46, cursor + 46 + nameLength),
      flags,
    );
    if (name === expectedName) {
      if (uncompressedSize > maxBytes || compressedSize > maxBytes) {
        throw new Error(`ZIP member exceeds the ${maxBytes} byte limit: ${name}`);
      }
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataOffset + compressedSize;
      if (dataEnd > buffer.length || dataEnd < dataOffset) {
        throw new Error(`ZIP member data is outside archive bounds: ${name}`);
      }
      const compressed = buffer.subarray(dataOffset, dataEnd);
      let content;
      if (method === ZIP_STORED_METHOD) {
        content = Buffer.from(compressed);
      } else if (method === ZIP_DEFLATE_METHOD) {
        content = inflateRawSync(compressed, { maxOutputLength: maxBytes });
      } else {
        throw new Error(`ZIP member uses unsupported compression method ${method}: ${name}`);
      }
      if (content.length !== uncompressedSize) {
        throw new Error(`ZIP member size does not match metadata: ${name}`);
      }
      return content;
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`ZIP member is missing: ${expectedName}`);
}

export function assertDiagnosticZipMembers(buffer) {
  const names = listZipEntries(buffer).slice().sort();
  const expected = [...DIAGNOSTIC_ZIP_MEMBERS];
  const missing = expected.filter((name) => !names.includes(name));
  const unexpected = names.filter((name) => !expected.includes(name));
  if (missing.length > 0 || unexpected.length > 0 || names.length !== expected.length) {
    throw new Error(
      `Diagnostic ZIP members do not match the privacy-safe contract; ` +
        `missing=${missing.join(",") || "none"}; ` +
        `unexpected=${unexpected.join(",") || "none"}`,
    );
  }
  return names;
}
