import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import type { TelegramSegmentManifest, TelegramSegmentPart, TelegramVideoMetadata } from "./types";

export const CLOUD_VIDEO_UPLOAD_LIMIT_BYTES = 50_000_000;
export const CLOUD_VIDEO_PART_TARGET_BYTES = 45_000_000;
export const CLOUD_VIDEO_PART_MAX_BYTES = 49_000_000;

export interface VideoSegmentInput {
  deliveryId: string;
  sourcePath: string;
  sourceSize: number;
  sourceMtimeNs: string;
}

export interface SegmentProcessResult {
  exitCode: number;
  stderr: string;
}

export type SegmentProcessRunner = (
  executable: string,
  args: readonly string[],
  signal?: AbortSignal,
) => Promise<SegmentProcessResult>;

interface TelegramVideoSegmenterOptions {
  dataDir: string;
  ffmpegPath: string;
  runProcess?: SegmentProcessRunner;
  cloudUploadLimitBytes?: number;
  targetPartBytes?: number;
  maxPartBytes?: number;
}

const DELIVERY_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const PART_NAME_RE = /^part-[0-9]{4}\.mp4$/;
const TRANSCODE_INITIAL_SEGMENT_SECONDS_MAX = 135;

function parseDurationSeconds(stderr: string): number {
  const match = stderr.match(/Duration:\s*([0-9]+):([0-9]{2}):([0-9]{2}(?:\.[0-9]+)?)/);
  if (!match) throw new Error("FFMPEG_DURATION_UNAVAILABLE");
  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("FFMPEG_DURATION_INVALID");
  return seconds;
}

function parseVideoMetadata(stderr: string): TelegramVideoMetadata {
  const videoLine = stderr.match(/Stream[^\n]*Video:[^\n]*/i)?.[0] || "";
  const dimensions = videoLine.match(/(?:^|[\s,])(\d{2,5})x(\d{2,5})(?:[\s,\[]|$)/i);
  const width = Number(dimensions?.[1]);
  const height = Number(dimensions?.[2]);
  const durationSeconds = Math.ceil(parseDurationSeconds(stderr));
  if (
    !Number.isSafeInteger(width)
    || width < 1
    || !Number.isSafeInteger(height)
    || height < 1
    || !Number.isSafeInteger(durationSeconds)
    || durationSeconds < 1
  ) {
    throw new Error("FFMPEG_VIDEO_METADATA_INVALID");
  }
  return { width, height, durationSeconds };
}

function canCopyForTelegram(stderr: string): boolean {
  const videoCodec = stderr.match(/Stream[^\n]*Video:\s*([A-Za-z0-9_]+)/i)?.[1]?.toLowerCase();
  const dimensions = stderr.match(/Stream[^\n]*Video:[^\n]*?(\d{2,5})x(\d{2,5})(?:[\s,\[]|$)/i);
  const audioCodecs = [...stderr.matchAll(/Stream[^\n]*Audio:\s*([A-Za-z0-9_]+)/gi)]
    .map((match) => match[1].toLowerCase());
  const sampleAspectRatio = stderr.match(/Stream[^\n]*Video:[^\n]*?SAR\s+(\d+):(\d+)/i);
  const hasSquarePixels = !sampleAspectRatio || sampleAspectRatio[1] === sampleAspectRatio[2];
  const width = Number(dimensions?.[1]);
  const height = Number(dimensions?.[2]);
  const hasCompatibleCanvas = Number.isFinite(width)
    && Number.isFinite(height)
    && width > 0
    && height > 0
    && width <= 1920
    && height <= 1080;
  return videoCodec === "h264"
    && audioCodecs.every((codec) => codec === "aac")
    && hasCompatibleCanvas
    && hasSquarePixels;
}

async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.once("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("end", () => resolve(hash.digest("hex")));
  });
}

const defaultRunProcess: SegmentProcessRunner = async (executable, args, signal) => new Promise((resolve, reject) => {
  let stderr = "";
  const child = spawn(executable, [...args], {
    shell: false,
    windowsHide: true,
    signal,
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    if (stderr.length < 256 * 1024) stderr += String(chunk).slice(0, 256 * 1024 - stderr.length);
  });
  child.once("error", reject);
  child.once("close", (code) => resolve({ exitCode: code ?? -1, stderr }));
});

export class TelegramVideoSegmenter {
  private readonly dataDir: string;
  private readonly ffmpegPath: string;
  private readonly runProcess: SegmentProcessRunner;
  private readonly cloudUploadLimitBytes: number;
  private readonly targetPartBytes: number;
  private readonly maxPartBytes: number;

  constructor(options: TelegramVideoSegmenterOptions) {
    this.dataDir = path.resolve(options.dataDir);
    this.ffmpegPath = path.resolve(options.ffmpegPath);
    this.runProcess = options.runProcess || defaultRunProcess;
    this.cloudUploadLimitBytes = options.cloudUploadLimitBytes ?? CLOUD_VIDEO_UPLOAD_LIMIT_BYTES;
    this.targetPartBytes = options.targetPartBytes ?? CLOUD_VIDEO_PART_TARGET_BYTES;
    this.maxPartBytes = options.maxPartBytes ?? CLOUD_VIDEO_PART_MAX_BYTES;
    if (
      this.targetPartBytes < 1
      || this.maxPartBytes <= this.targetPartBytes
      || this.cloudUploadLimitBytes <= this.maxPartBytes
    ) {
      throw new Error("INVALID_SEGMENT_LIMITS");
    }
  }

  async prepare(input: VideoSegmentInput, signal?: AbortSignal): Promise<TelegramSegmentManifest | null> {
    if (!DELIVERY_ID_RE.test(input.deliveryId)) throw new Error("INVALID_DELIVERY_ID");
    const sourcePath = path.resolve(input.sourcePath);
    const sourceStat = await this.assertSourceFile(sourcePath, "SOURCE_FILE_INVALID");
    this.assertSourceSnapshot(sourceStat, input);
    if (input.sourceSize <= this.cloudUploadLimitBytes) return null;
    await this.assertRegularFile(this.ffmpegPath, "FFMPEG_INVALID");
    if (signal?.aborted) throw new Error("aborted");

    const segmentsRoot = path.join(this.dataDir, "telegram", "segments");
    await this.ensureDirectoryChain(segmentsRoot);
    const deliveryRoot = path.join(segmentsRoot, input.deliveryId);
    await this.prepareDeliveryRoot(deliveryRoot);
    const buildingDir = path.join(deliveryRoot, `.building-${randomUUID()}`);
    const readyDir = path.join(deliveryRoot, "ready");
    await fs.promises.mkdir(buildingDir, { recursive: false });

    try {
      const probe = await this.runProcess(
        this.ffmpegPath,
        ["-hide_banner", "-nostdin", "-i", sourcePath],
        signal,
      );
      const durationSeconds = parseDurationSeconds(probe.stderr);
      const sourceNeedsTranscode = !canCopyForTelegram(probe.stderr);
      const estimatedSegmentSeconds = Math.max(
        1,
        durationSeconds * this.targetPartBytes / input.sourceSize,
      );
      let segmentSeconds = sourceNeedsTranscode
        ? Math.min(estimatedSegmentSeconds, TRANSCODE_INITIAL_SEGMENT_SECONDS_MAX)
        : estimatedSegmentSeconds;
      let parts: TelegramSegmentPart[] | null = null;

      for (let attempt = 0; attempt < 4; attempt += 1) {
        if (signal?.aborted) throw new Error("aborted");
        await this.clearDirectory(buildingDir);
        const output = path.join(buildingDir, "part-%04d.mp4");
        const transcode = sourceNeedsTranscode || attempt === 3;
        const args = this.splitArgs(sourcePath, output, segmentSeconds, transcode);
        const result = await this.runProcess(this.ffmpegPath, args, signal);
        if (result.exitCode !== 0) {
          if (transcode) throw new Error(`FFMPEG_SEGMENT_FAILED: ${result.stderr.slice(-500)}`);
          segmentSeconds = Math.max(0.25, segmentSeconds * 0.65);
          continue;
        }
        const candidate = await this.inspectParts(buildingDir, signal);
        if (candidate.length > 0 && candidate.every((part) => part.fileSize < this.maxPartBytes)) {
          parts = candidate;
          break;
        }
        segmentSeconds = Math.max(0.25, segmentSeconds * 0.65);
      }
      if (!parts?.length) throw new Error("FFMPEG_SEGMENTS_EXCEED_CLOUD_LIMIT");
      const after = await this.assertSourceFile(sourcePath, "SOURCE_FILE_INVALID");
      this.assertSourceSnapshot(after, input);
      await fs.promises.rename(buildingDir, readyDir);
      return {
        sourceFileSize: input.sourceSize,
        sourceFileMtimeNs: input.sourceMtimeNs,
        segmentDir: readyDir,
        parts,
      };
    } catch (error) {
      await fs.promises.rm(buildingDir, { recursive: true, force: true }).catch(() => undefined);
      await this.removeDeliveryRootIfEmpty(deliveryRoot);
      throw error;
    }
  }

  async cleanupCompleted(deliveryId: string, manifest: TelegramSegmentManifest): Promise<void> {
    if (!DELIVERY_ID_RE.test(deliveryId)) throw new Error("INVALID_DELIVERY_ID");
    const deliveryRoot = path.join(this.dataDir, "telegram", "segments", deliveryId);
    const expectedReady = path.join(deliveryRoot, "ready");
    if (path.resolve(manifest.segmentDir) !== path.resolve(expectedReady)) {
      throw new Error("SEGMENT_CLEANUP_PATH_MISMATCH");
    }
    await this.cleanupDelivery(deliveryId);
  }

  async cleanupDelivery(deliveryId: string): Promise<void> {
    if (!DELIVERY_ID_RE.test(deliveryId)) throw new Error("INVALID_DELIVERY_ID");
    const deliveryRoot = path.join(this.dataDir, "telegram", "segments", deliveryId);
    const deliveryStat = await fs.promises.lstat(deliveryRoot).catch(() => null);
    if (deliveryStat === null) return;
    if (!deliveryStat.isDirectory() || deliveryStat.isSymbolicLink()) {
      throw new Error("SEGMENT_CLEANUP_ROOT_INVALID");
    }
    const expectedReady = path.join(deliveryRoot, "ready");
    const readyStat = await fs.promises.lstat(expectedReady).catch(() => null);
    if (readyStat !== null) {
      if (!readyStat.isDirectory() || readyStat.isSymbolicLink()) throw new Error("SEGMENT_CLEANUP_PATH_INVALID");
      await fs.promises.rm(expectedReady, { recursive: true, force: false });
    }
    await this.removeDeliveryRootIfEmpty(deliveryRoot);
  }

  async validatePersisted(
    input: VideoSegmentInput,
    manifest: TelegramSegmentManifest,
  ): Promise<TelegramSegmentManifest> {
    const sourcePath = path.resolve(input.sourcePath);
    const sourceStat = await this.assertSourceFile(sourcePath, "SOURCE_FILE_INVALID");
    this.assertSourceSnapshot(sourceStat, input);
    if (
      manifest.sourceFileSize !== input.sourceSize
      || manifest.sourceFileMtimeNs !== String(input.sourceMtimeNs)
    ) {
      throw new Error("SEGMENT_MANIFEST_SOURCE_MISMATCH");
    }
    const deliveryRoot = path.join(this.dataDir, "telegram", "segments", input.deliveryId);
    const expectedReady = path.join(deliveryRoot, "ready");
    if (path.resolve(manifest.segmentDir) !== path.resolve(expectedReady)) {
      throw new Error("SEGMENT_MANIFEST_PATH_MISMATCH");
    }
    if (!Array.isArray(manifest.parts) || manifest.parts.length < 1) {
      throw new Error("SEGMENT_MANIFEST_PARTS_INVALID");
    }
    const validatedParts: TelegramSegmentPart[] = [];
    for (const [index, part] of manifest.parts.entries()) {
      if (
        part.index !== index
        || !PART_NAME_RE.test(part.fileName)
        || part.fileSize < 1
        || part.fileSize >= this.maxPartBytes
        || !/^[0-9a-f]{64}$/.test(part.sha256)
      ) {
        throw new Error("SEGMENT_MANIFEST_PART_INVALID");
      }
      const filePath = path.join(expectedReady, part.fileName);
      const stat = await this.assertRegularFile(filePath, "SEGMENT_OUTPUT_INVALID");
      if (stat.size !== part.fileSize || await sha256File(filePath) !== part.sha256) {
        throw new Error("SEGMENT_OUTPUT_CHANGED");
      }
      const metadataValues = [part.videoWidth, part.videoHeight, part.durationSeconds];
      const hasNoMetadata = metadataValues.every((value) => value === undefined);
      const hasValidMetadata = metadataValues.every((value) => Number.isSafeInteger(value) && Number(value) > 0);
      if (!hasNoMetadata && !hasValidMetadata) throw new Error("SEGMENT_VIDEO_METADATA_INVALID");
      if (hasNoMetadata) {
        await this.assertRegularFile(this.ffmpegPath, "FFMPEG_INVALID");
        const metadata = await this.probeVideo(filePath);
        validatedParts.push({
          ...part,
          videoWidth: metadata.width,
          videoHeight: metadata.height,
          durationSeconds: metadata.durationSeconds,
        });
      } else {
        validatedParts.push(part);
      }
    }
    return validatedParts.every((part, index) => part === manifest.parts[index])
      ? manifest
      : { ...manifest, parts: validatedParts };
  }

  private assertSourceSnapshot(stat: fs.BigIntStats, input: VideoSegmentInput): void {
    const size = Number(stat.size);
    if (!Number.isSafeInteger(size) || size !== input.sourceSize || stat.mtimeNs.toString() !== String(input.sourceMtimeNs)) {
      throw new Error("SOURCE_FILE_CHANGED");
    }
  }

  private async assertSourceFile(filePath: string, code: string): Promise<fs.BigIntStats> {
    const stat = await fs.promises.lstat(filePath, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(code);
    return stat;
  }

  private async assertRegularFile(filePath: string, code: string): Promise<fs.Stats> {
    const stat = await fs.promises.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(code);
    return stat;
  }

  private async ensureDirectoryChain(target: string): Promise<void> {
    await fs.promises.mkdir(target, { recursive: true });
    const relative = path.relative(this.dataDir, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("SEGMENT_ROOT_OUTSIDE_DATA_DIR");
    let cursor = this.dataDir;
    for (const component of relative.split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, component);
      const stat = await fs.promises.lstat(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("SEGMENT_ROOT_INVALID");
    }
  }

  private async prepareDeliveryRoot(deliveryRoot: string): Promise<void> {
    const existing = await fs.promises.lstat(deliveryRoot).catch(() => null);
    if (existing === null) {
      await fs.promises.mkdir(deliveryRoot, { recursive: false });
      return;
    }
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error("SEGMENT_DELIVERY_ROOT_INVALID");
    const entries = await fs.promises.readdir(deliveryRoot, { withFileTypes: true });
    for (const entry of entries) {
      if ((entry.name === "ready" || entry.name.startsWith(".building-")) && entry.isDirectory() && !entry.isSymbolicLink()) {
        await fs.promises.rm(path.join(deliveryRoot, entry.name), { recursive: true, force: false });
        continue;
      }
      throw new Error("SEGMENT_DELIVERY_ROOT_NOT_OWNED");
    }
  }

  private async clearDirectory(directory: string): Promise<void> {
    for (const entry of await fs.promises.readdir(directory)) {
      await fs.promises.rm(path.join(directory, entry), { recursive: true, force: true });
    }
  }

  private splitArgs(sourcePath: string, output: string, segmentSeconds: number, transcode: boolean): string[] {
    const common = ["-hide_banner", "-nostdin", "-y", "-i", sourcePath, "-map", "0:v:0", "-map", "0:a?"];
    const codec = transcode
      ? [
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
          "-vf", "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1",
          "-pix_fmt", "yuv420p", "-tag:v", "avc1",
          "-profile:v", "high", "-level:v", "4.1",
          "-force_key_frames", `expr:gte(t,n_forced*${segmentSeconds.toFixed(3)})`,
          "-c:a", "aac", "-b:a", "128k",
        ]
      : ["-c", "copy"];
    return [
      ...common,
      ...codec,
      "-f", "segment",
      "-segment_time", segmentSeconds.toFixed(3),
      "-reset_timestamps", "1",
      "-avoid_negative_ts", "make_zero",
      "-segment_format", "mp4",
      "-segment_format_options", "movflags=+faststart",
      output,
    ];
  }

  private async inspectParts(directory: string, signal?: AbortSignal): Promise<TelegramSegmentPart[]> {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    const names = entries.map((entry) => entry.name).sort();
    if (names.some((name) => !PART_NAME_RE.test(name))) throw new Error("SEGMENT_OUTPUT_NAME_INVALID");
    const parts: TelegramSegmentPart[] = [];
    for (const [index, name] of names.entries()) {
      const filePath = path.join(directory, name);
      const stat = await this.assertRegularFile(filePath, "SEGMENT_OUTPUT_INVALID");
      const metadata = await this.probeVideo(filePath, signal);
      parts.push({
        index,
        fileName: name,
        fileSize: stat.size,
        sha256: await sha256File(filePath),
        videoWidth: metadata.width,
        videoHeight: metadata.height,
        durationSeconds: metadata.durationSeconds,
      });
    }
    return parts;
  }

  private async probeVideo(filePath: string, signal?: AbortSignal): Promise<TelegramVideoMetadata> {
    const probe = await this.runProcess(
      this.ffmpegPath,
      ["-hide_banner", "-nostdin", "-i", filePath],
      signal,
    );
    return parseVideoMetadata(probe.stderr);
  }

  private async removeDeliveryRootIfEmpty(deliveryRoot: string): Promise<void> {
    const entries = await fs.promises.readdir(deliveryRoot).catch(() => null);
    if (entries?.length === 0) await fs.promises.rmdir(deliveryRoot).catch(() => undefined);
  }
}
