import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const COMMAND_TIMEOUT_MS = 15_000;
const COMMAND_MAX_BUFFER = 1024 * 1024;
const RECOGNIZED_CONTAINERS = new Set([
  "3g2",
  "3gp",
  "aac",
  "flac",
  "m4a",
  "matroska",
  "mj2",
  "mov",
  "mp3",
  "mp4",
  "mpeg",
  "mpegts",
  "ogg",
  "wav",
  "webm",
]);

export function executableNames(platform) {
  if (platform === "win32") {
    return { ffmpeg: "ffmpeg.exe", ffprobe: "ffprobe.exe" };
  }
  return { ffmpeg: "ffmpeg", ffprobe: "ffprobe" };
}

export function inspectProbePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, reason: "ffprobe JSON 顶层结构无效" };
  }
  const streams = Array.isArray(payload.streams) ? payload.streams : [];
  const hasVideo = streams.some((stream) => stream?.codec_type === "video");
  const hasAudio = streams.some((stream) => stream?.codec_type === "audio");
  const formatName =
    typeof payload.format?.format_name === "string"
      ? payload.format.format_name.trim()
      : "";
  const containers = formatName
    .toLowerCase()
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const hasRecognizedContainer = containers.some((value) =>
    RECOGNIZED_CONTAINERS.has(value),
  );
  if (!hasVideo) return { ok: false, reason: "样本缺少视频流" };
  if (!hasAudio) return { ok: false, reason: "样本缺少音频流" };
  if (!hasRecognizedContainer) {
    return { ok: false, reason: "样本容器无法识别" };
  }
  return { ok: true, hasVideo, hasAudio, formatName };
}

function failed(productMessage) {
  return { ok: false, productMessage };
}

function runCommand(run, executable, args, label) {
  let result;
  try {
    result = run(executable, args, {
      encoding: "utf8",
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: COMMAND_MAX_BUFFER,
      windowsHide: true,
      shell: false,
    });
  } catch {
    return { ok: false, productMessage: `${label} 无法运行` };
  }
  if (result?.error) {
    return { ok: false, productMessage: `${label} 无法运行` };
  }
  if (result?.status !== 0) {
    return { ok: false, productMessage: `${label} 检查失败` };
  }
  return {
    ok: true,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
  };
}

function isExecutableFile(filePath, platform) {
  try {
    if (!fs.statSync(filePath).isFile()) return false;
    if (platform !== "win32") fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function smokeMediaTools({
  binDir,
  platform = process.platform,
  run = spawnSync,
}) {
  if (!binDir || !path.isAbsolute(binDir)) {
    throw new TypeError("binDir must be an absolute directory");
  }
  const names = executableNames(platform);
  const ffmpeg = path.join(binDir, names.ffmpeg);
  const ffprobe = path.join(binDir, names.ffprobe);
  if (!isExecutableFile(ffmpeg, platform)) {
    return failed(`未找到可执行的 ${names.ffmpeg}`);
  }
  if (!isExecutableFile(ffprobe, platform)) {
    return failed(`未找到可执行的 ${names.ffprobe}`);
  }

  const ffmpegVersion = runCommand(
    run,
    ffmpeg,
    ["-version"],
    `${names.ffmpeg} version`,
  );
  if (!ffmpegVersion.ok) return ffmpegVersion;
  const ffprobeVersion = runCommand(
    run,
    ffprobe,
    ["-version"],
    `${names.ffprobe} version`,
  );
  if (!ffprobeVersion.ok) return ffprobeVersion;

  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "downany-media-tools-"),
  );
  const coverPath = path.join(temporaryDirectory, "cover.png");
  const samplePath = path.join(temporaryDirectory, "sample.mp4");
  try {
    const coverGeneration = runCommand(
      run,
      ffmpeg,
      [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=size=160x90:duration=0.1",
        "-frames:v",
        "1",
        "-c:v",
        "png",
        coverPath,
      ],
      "ffmpeg PNG 封面生成",
    );
    if (!coverGeneration.ok) return coverGeneration;
    try {
      if (!fs.statSync(coverPath).isFile() || fs.statSync(coverPath).size <= 0) {
        return failed("ffmpeg 未生成有效 PNG 封面");
      }
    } catch {
      return failed("ffmpeg 未生成有效 PNG 封面");
    }

    const generation = runCommand(
      run,
      ffmpeg,
      [
        "-v",
        "error",
        "-y",
        "-loop",
        "1",
        "-framerate",
        "10",
        "-i",
        coverPath,
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=880:duration=0.5",
        "-c:v",
        "mpeg4",
        "-c:a",
        "aac",
        "-t",
        "0.5",
        "-shortest",
        samplePath,
      ],
      "ffmpeg 样本生成",
    );
    if (!generation.ok) return generation;
    try {
      if (!fs.statSync(samplePath).isFile() || fs.statSync(samplePath).size <= 0) {
        return failed("ffmpeg 未生成有效样本");
      }
    } catch {
      return failed("ffmpeg 未生成有效样本");
    }

    const probe = runCommand(
      run,
      ffprobe,
      [
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        "-show_chapters",
        samplePath,
      ],
      "ffprobe 样本探测",
    );
    if (!probe.ok) return probe;

    let payload;
    try {
      payload = JSON.parse(probe.stdout);
    } catch {
      return failed("ffprobe JSON 输出无法读取");
    }
    const inspected = inspectProbePayload(payload);
    if (!inspected.ok) return failed(inspected.reason);
    return {
      ok: true,
      productMessage: "ffmpeg 与 ffprobe 媒体工具检查通过",
      formatName: inspected.formatName,
    };
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function readBinDir(argv) {
  const prefix = "--bin-dir=";
  const value = argv.find((argument) => argument.startsWith(prefix));
  return value ? value.slice(prefix.length) : "";
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptPath)) {
  const binDir = readBinDir(process.argv.slice(2));
  if (!binDir || !path.isAbsolute(binDir)) {
    throw new Error(
      "usage: node scripts/test_packaged_media_tools.mjs --bin-dir=<absolute-directory>",
    );
  }
  const result = smokeMediaTools({
    binDir,
    platform: process.platform,
    run: spawnSync,
  });
  if (!result.ok) throw new Error(result.productMessage);
  console.log(result.productMessage);
}
