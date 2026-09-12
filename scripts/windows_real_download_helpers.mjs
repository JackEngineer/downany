/** Safety and evidence checks for the opt-in Windows download gate. */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

const CASES = Object.freeze({
  "public-direct": ["public-direct"],
  "public-extension": ["public-direct", "public-extension"],
  recovery: ["public-direct", "failed-task-retry", "pause-restart-resume", "network-interruption-recovery"],
  all: ["public-direct", "public-extension", "failed-task-retry", "pause-restart-resume", "network-interruption-recovery"],
});

export function parseGateArguments(rawArguments) {
  const allowed = new Set(["--executable", "--playwright-module", "--browser-executable",
    "--extension-dir", "--suite", "--expected-version"]);
  const args = new Map();
  for (const argument of rawArguments) {
    const separator = argument.indexOf("=");
    assert.ok(separator > 0, "Use --name=value arguments");
    const name = argument.slice(0, separator);
    const value = argument.slice(separator + 1);
    assert.ok(allowed.has(name) && !args.has(name) && value, `Unknown, duplicate or empty argument: ${name}`);
    args.set(name, value);
  }
  const suite = args.get("--suite") || "all";
  assert.ok(Object.hasOwn(CASES, suite), "Unknown gate suite");
  const expectedVersion = args.get("--expected-version") || "0.3.0";
  assert.match(expectedVersion, /^\d+\.\d+\.\d+$/, "Expected version must be major.minor.patch");
  assert.ok(args.has("--executable") && args.has("--playwright-module"), "Executable and Playwright module are required");
  if (CASES[suite].includes("public-extension")) {
    assert.ok(args.has("--browser-executable") && args.has("--extension-dir"), "Browser and extension paths are required for this suite");
  }
  for (const [name, value] of args) {
    if (!["--suite", "--expected-version"].includes(name)) assert.ok(path.isAbsolute(value), `${name} must be absolute`);
  }
  return { suite, expectedVersion, expectedCases: [...CASES[suite]],
    executable: args.get("--executable"), playwrightModule: args.get("--playwright-module"),
    browserExecutable: args.get("--browser-executable"), extensionDir: args.get("--extension-dir") };
}

export function assertGateCoverage(cases, expectedLabels) {
  const labels = cases.map((item) => item.label);
  assert.equal(new Set(labels).size, labels.length, "Duplicate gate evidence");
  assert.deepEqual([...labels].sort(), [...expectedLabels].sort(), "Gate did not cover the requested cases");
}

export function captureAudit(read) {
  try {
    return { value: read(), error: null };
  } catch (error) {
    // File-system messages can contain private names; the error class/code is
    // sufficient for a fail-closed report without copying those names into it.
    return { value: null, error: { name: error?.name || "Error", code: error?.code || "AUDIT_FAILED" } };
  }
}

export function prepareDownloadGateRoot(root) {
  assert.ok(path.isAbsolute(root), "Gate root must be absolute");
  assert.ok(!fs.lstatSync(root).isSymbolicLink(), "Gate root cannot be a junction or symlink");
  assert.deepEqual(fs.readdirSync(root), [], "Gate root must be empty");
  const dataDir = path.join(root, "downany-data");
  const outputDir = path.join(root, "output");
  const profileDir = path.join(root, "electron-profile");
  for (const directory of [dataDir, outputDir, profileDir]) fs.mkdirSync(directory);
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({
    download_dir: outputDir,
    concurrent_downloads: 1,
    auto_start_downloads: true,
    clipboard_monitor: false,
    telegram_auto_send_enabled: false,
    telemetry_enabled: false,
    cookies_from_browser: "",
    theme_mode: "light",
    embed_metadata: true,
  }, null, 2) + "\n", { flag: "wx" });
  // A gate must never import settings or history from the operator's real
  // profile. Mark both legacy migrations complete before Sidecar starts.
  for (const marker of [".migration_v1_done", ".migration_videodownloader_done"]) {
    fs.writeFileSync(path.join(dataDir, marker), "acceptance-isolation\n", { flag: "wx" });
  }
  return { dataDir, outputDir, profileDir };
}

export function buildDownloadGateEnvironment(inherited, dataDir) {
  const env = { ...inherited };
  for (const key of Object.keys(env)) {
    if (/^(DOWNANY_|VIDEODL_|VITE_)/i.test(key) ||
        /^(NODE_OPTIONS|ELECTRON_RUN_AS_NODE)$/i.test(key)) delete env[key];
  }
  env.DOWNANY_DATA_DIR = dataDir;
  env.DOWNANY_UPDATE_DISABLED = "1";
  env.DOWNANY_SKIP_PROTOCOL_REGISTRATION = "1";
  env.DOWNANY_BRIDGE_PORT = "0";
  env.PYTHONUNBUFFERED = "1";
  env.NO_PROXY = [...new Set([
    ...(env.NO_PROXY || env.no_proxy || "").split(",").filter(Boolean),
    "localhost", "127.0.0.1",
  ])].join(",");
  env.no_proxy = env.NO_PROXY;
  return env;
}

export function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function packagedMediaBin(executable, platform = process.platform) {
  if (platform === "win32") return path.join(path.dirname(executable), "resources", "bin");
  if (platform === "darwin") return path.resolve(path.dirname(executable), "../Resources/bin");
  throw new Error(`Unsupported packaged media platform: ${platform}`);
}

export function assertCompletedDownload(task, outputDir) {
  assert.equal(task?.status, "completed", "Task is not completed");
  assert.equal(task.progress, 100, "Task progress is not complete");
  assert.ok(typeof task.file_path === "string" && path.isAbsolute(task.file_path), "Output path must be absolute");
  // The legacy JavaScript implementation can preserve an 8.3 segment such as
  // RUNNER~1 for the directory while the downloaded file is reported with the
  // corresponding long segment. The native resolver returns one canonical
  // Windows spelling for both and keeps the containment check fail-closed.
  const realpath = fs.realpathSync.native || fs.realpathSync;
  const file = realpath(task.file_path);
  const relative = path.relative(realpath(outputDir), file);
  assert.ok(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    "Completed file is outside the isolated output directory");
  const stat = fs.statSync(file);
  assert.ok(stat.isFile() && stat.size > 0, "Completed output must be a nonempty file");
  assert.equal(task.downloaded_bytes, stat.size, "Downloaded byte count does not match output");
  assert.equal(task.total_bytes, stat.size, "Total byte count does not match output");
  return { taskId: task.id, path: file, bytes: stat.size, sha256: sha256File(file) };
}

export function validateMediaProbe(probe) {
  const streams = Array.isArray(probe?.streams) ? probe.streams : [];
  const video = streams.find((stream) => stream.codec_type === "video" &&
    !stream.disposition?.attached_pic && stream.width > 0 && stream.height > 0);
  assert.ok(video, "No playable video stream");
  const audio = streams.find((stream) => stream.codec_type === "audio" && stream.channels > 0);
  assert.ok(audio, "No playable audio stream");
  const durationSeconds = Number(probe.format?.duration);
  assert.ok(Number.isFinite(durationSeconds) && durationSeconds > 0, "Invalid media duration");
  return {
    durationSeconds, container: probe.format?.format_name,
    video: { codec: video.codec_name, width: video.width, height: video.height },
    audio: { codec: audio.codec_name, channels: audio.channels, sampleRate: audio.sample_rate },
  };
}

export async function waitForTask(read, predicate, {
  timeoutMs = 180_000, pollIntervalMs = 200,
} = {}) {
  const deadline = performance.now() + timeoutMs;
  let last = null;
  while (performance.now() < deadline) {
    let timer;
    try {
      last = await Promise.race([
        read(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Task read timed out")), Math.max(1, deadline - performance.now()));
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (predicate(last)) return last;
    if (last && ["failed", "cancelled"].includes(last.status)) {
      throw new Error(`Task ${last.id || "unknown"} became ${last.status} (${last.error_code || "no code"})`);
    }
    await delay(Math.min(pollIntervalMs, Math.max(0, deadline - performance.now())));
  }
  throw new Error(`Task state timed out (${last?.id || "missing"}: ${last?.status || "missing"})`);
}
