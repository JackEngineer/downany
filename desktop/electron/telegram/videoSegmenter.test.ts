import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  TelegramVideoSegmenter,
  type SegmentProcessRunner,
} from "./videoSegmenter";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

function createFixture(size: number): {
  dataDir: string;
  ffmpegPath: string;
  sourcePath: string;
  sourceMtimeNs: string;
} {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "downany-video-segmenter-"));
  const dataDir = path.join(tempDir, "百纳 数据");
  const binDir = path.join(tempDir, "resources", "bin");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  const ffmpegPath = path.join(binDir, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  fs.writeFileSync(ffmpegPath, "fixture");
  const sourcePath = path.join(tempDir, "下载 视频.mp4");
  fs.writeFileSync(sourcePath, Buffer.alloc(size, 7));
  const stat = fs.statSync(sourcePath, { bigint: true });
  return {
    dataDir,
    ffmpegPath,
    sourcePath,
    sourceMtimeNs: stat.mtimeNs.toString(),
  };
}

function outputPattern(args: readonly string[]): string {
  const result = args.at(-1);
  if (!result?.includes("%04d")) throw new Error("missing segment output pattern");
  return result;
}

describe("TelegramVideoSegmenter", () => {
  it("keeps a cloud-sized source as a single upload without starting ffmpeg", async () => {
    const fixture = createFixture(50);
    const runProcess = vi.fn<SegmentProcessRunner>();
    const segmenter = new TelegramVideoSegmenter({
      dataDir: fixture.dataDir,
      ffmpegPath: fixture.ffmpegPath,
      runProcess,
      cloudUploadLimitBytes: 50,
      targetPartBytes: 45,
      maxPartBytes: 49,
    });

    const result = await segmenter.prepare({
      deliveryId: "delivery-under-limit",
      sourcePath: fixture.sourcePath,
      sourceSize: 50,
      sourceMtimeNs: fixture.sourceMtimeNs,
    });

    expect(result).toBeNull();
    expect(runProcess).not.toHaveBeenCalled();
    expect(fs.readFileSync(fixture.sourcePath)).toEqual(Buffer.alloc(50, 7));
  });

  it("retries an oversized copy split and returns ordered verified parts", async () => {
    const fixture = createFixture(120);
    let splitAttempt = 0;
    const runProcess: SegmentProcessRunner = async (_executable, args) => {
      if (!args.includes("-f") || !args.includes("segment")) {
        return {
          exitCode: 1,
          stderr: [
            "Duration: 00:02:00.00, start: 0.000000, bitrate: 8 kb/s",
            "Stream #0:0: Video: h264 (High), yuv420p, 1920x1080",
            "Stream #0:1: Audio: aac (LC), 44100 Hz, stereo",
          ].join("\n"),
        };
      }
      splitAttempt += 1;
      const pattern = outputPattern(args);
      fs.mkdirSync(path.dirname(pattern), { recursive: true });
      if (splitAttempt === 1) {
        fs.writeFileSync(pattern.replace("%04d", "0000"), Buffer.alloc(49, 1));
        fs.writeFileSync(pattern.replace("%04d", "0001"), Buffer.alloc(12, 2));
      } else {
        fs.writeFileSync(pattern.replace("%04d", "0000"), Buffer.alloc(40, 3));
        fs.writeFileSync(pattern.replace("%04d", "0001"), Buffer.alloc(40, 4));
        fs.writeFileSync(pattern.replace("%04d", "0002"), Buffer.alloc(40, 5));
      }
      return { exitCode: 0, stderr: "" };
    };
    const segmenter = new TelegramVideoSegmenter({
      dataDir: fixture.dataDir,
      ffmpegPath: fixture.ffmpegPath,
      runProcess,
      cloudUploadLimitBytes: 50,
      targetPartBytes: 45,
      maxPartBytes: 49,
    });

    const before = fs.readFileSync(fixture.sourcePath);
    const manifest = await segmenter.prepare({
      deliveryId: "delivery-retry",
      sourcePath: fixture.sourcePath,
      sourceSize: 120,
      sourceMtimeNs: fixture.sourceMtimeNs,
    });

    expect(splitAttempt).toBe(2);
    expect(manifest).not.toBeNull();
    expect(manifest?.sourceFileSize).toBe(120);
    expect(manifest?.sourceFileMtimeNs).toBe(fixture.sourceMtimeNs);
    expect(manifest?.parts.map((part) => [part.index, part.fileName, part.fileSize])).toEqual([
      [0, "part-0000.mp4", 40],
      [1, "part-0001.mp4", 40],
      [2, "part-0002.mp4", 40],
    ]);
    expect(manifest?.parts.every((part) => /^[0-9a-f]{64}$/.test(part.sha256))).toBe(true);
    expect(path.basename(manifest?.segmentDir || "")).toBe("ready");
    expect(fs.readFileSync(fixture.sourcePath)).toEqual(before);
    if (!manifest) throw new Error("manifest missing");
    const input = {
      deliveryId: "delivery-retry",
      sourcePath: fixture.sourcePath,
      sourceSize: 120,
      sourceMtimeNs: fixture.sourceMtimeNs,
    };
    await expect(segmenter.validatePersisted(input, manifest)).resolves.toBe(manifest);
    fs.writeFileSync(path.join(manifest.segmentDir, manifest.parts[0].fileName), Buffer.alloc(40, 9));
    await expect(segmenter.validatePersisted(input, manifest)).rejects.toThrow("SEGMENT_OUTPUT_CHANGED");
  });

  it("transcodes AV1 sources to Telegram-compatible H.264 and AAC on the first split", async () => {
    const fixture = createFixture(120);
    const splitArgs: string[][] = [];
    const runProcess: SegmentProcessRunner = async (_executable, args) => {
      if (!args.includes("-f") || !args.includes("segment")) {
        return {
          exitCode: 1,
          stderr: [
            "Duration: 00:20:00.00, start: 0.000000, bitrate: 8 kb/s",
            "Stream #0:0: Video: av1 (Main), yuv420p, 1920x1080",
            "Stream #0:1: Audio: aac (LC), 44100 Hz, stereo",
          ].join("\n"),
        };
      }
      splitArgs.push([...args]);
      const pattern = outputPattern(args);
      fs.mkdirSync(path.dirname(pattern), { recursive: true });
      fs.writeFileSync(pattern.replace("%04d", "0000"), Buffer.alloc(40, 1));
      fs.writeFileSync(pattern.replace("%04d", "0001"), Buffer.alloc(40, 2));
      fs.writeFileSync(pattern.replace("%04d", "0002"), Buffer.alloc(40, 3));
      return { exitCode: 0, stderr: "" };
    };
    const segmenter = new TelegramVideoSegmenter({
      dataDir: fixture.dataDir,
      ffmpegPath: fixture.ffmpegPath,
      runProcess,
      cloudUploadLimitBytes: 50,
      targetPartBytes: 45,
      maxPartBytes: 49,
    });

    const manifest = await segmenter.prepare({
      deliveryId: "delivery-av1",
      sourcePath: fixture.sourcePath,
      sourceSize: 120,
      sourceMtimeNs: fixture.sourceMtimeNs,
    });

    expect(splitArgs).toHaveLength(1);
    expect(splitArgs[0]).toContain("libx264");
    expect(splitArgs[0]).toContain("aac");
    expect(splitArgs[0]).toContain("yuv420p");
    expect(splitArgs[0]).not.toContain("copy");
    const videoFilterIndex = splitArgs[0].indexOf("-vf");
    expect(videoFilterIndex).toBeGreaterThan(-1);
    expect(splitArgs[0][videoFilterIndex + 1]).toBe(
      "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1",
    );
    expect(splitArgs[0]).toContain("-profile:v");
    expect(splitArgs[0][splitArgs[0].indexOf("-profile:v") + 1]).toBe("high");
    expect(splitArgs[0]).toContain("-level:v");
    expect(splitArgs[0][splitArgs[0].indexOf("-level:v") + 1]).toBe("4.1");
    const segmentTimeIndex = splitArgs[0].indexOf("-segment_time");
    expect(splitArgs[0][segmentTimeIndex + 1]).toBe("135.000");
    expect(manifest?.parts.map((part) => ({
      width: part.videoWidth,
      height: part.videoHeight,
      durationSeconds: part.durationSeconds,
    }))).toEqual([
      { width: 1920, height: 1080, durationSeconds: 1200 },
      { width: 1920, height: 1080, durationSeconds: 1200 },
      { width: 1920, height: 1080, durationSeconds: 1200 },
    ]);
  });

  it("normalizes 4K H.264 sources instead of copying an oversized video canvas", async () => {
    const fixture = createFixture(120);
    const splitArgs: string[][] = [];
    const runProcess: SegmentProcessRunner = async (_executable, args) => {
      if (!args.includes("-f") || !args.includes("segment")) {
        return {
          exitCode: 1,
          stderr: [
            "Duration: 00:20:00.00, start: 0.000000, bitrate: 8 kb/s",
            "Stream #0:0: Video: h264 (High), yuv420p, 3840x2160",
            "Stream #0:1: Audio: aac (LC), 44100 Hz, stereo",
          ].join("\n"),
        };
      }
      splitArgs.push([...args]);
      const pattern = outputPattern(args);
      fs.mkdirSync(path.dirname(pattern), { recursive: true });
      fs.writeFileSync(pattern.replace("%04d", "0000"), Buffer.alloc(40, 1));
      fs.writeFileSync(pattern.replace("%04d", "0001"), Buffer.alloc(40, 2));
      fs.writeFileSync(pattern.replace("%04d", "0002"), Buffer.alloc(40, 3));
      return { exitCode: 0, stderr: "" };
    };
    const segmenter = new TelegramVideoSegmenter({
      dataDir: fixture.dataDir,
      ffmpegPath: fixture.ffmpegPath,
      runProcess,
      cloudUploadLimitBytes: 50,
      targetPartBytes: 45,
      maxPartBytes: 49,
    });

    await segmenter.prepare({
      deliveryId: "delivery-h264-4k",
      sourcePath: fixture.sourcePath,
      sourceSize: 120,
      sourceMtimeNs: fixture.sourceMtimeNs,
    });

    expect(splitArgs).toHaveLength(1);
    expect(splitArgs[0]).toContain("libx264");
    expect(splitArgs[0]).not.toContain("copy");
    const videoFilterIndex = splitArgs[0].indexOf("-vf");
    expect(splitArgs[0][videoFilterIndex + 1]).toContain("force_original_aspect_ratio=decrease");
  });

  it("cancels ffmpeg and removes an uncommitted build directory", async () => {
    const fixture = createFixture(120);
    const runProcess: SegmentProcessRunner = async (_executable, args, signal) => {
      if (!args.includes("segment")) {
        return { exitCode: 1, stderr: "Duration: 00:02:00.00" };
      }
      const pattern = outputPattern(args);
      fs.mkdirSync(path.dirname(pattern), { recursive: true });
      fs.writeFileSync(pattern.replace("%04d", "0000"), Buffer.alloc(20, 1));
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    };
    const controller = new AbortController();
    const segmenter = new TelegramVideoSegmenter({
      dataDir: fixture.dataDir,
      ffmpegPath: fixture.ffmpegPath,
      runProcess,
      cloudUploadLimitBytes: 50,
      targetPartBytes: 45,
      maxPartBytes: 49,
    });

    const pending = segmenter.prepare({
      deliveryId: "delivery-abort",
      sourcePath: fixture.sourcePath,
      sourceSize: 120,
      sourceMtimeNs: fixture.sourceMtimeNs,
    }, controller.signal);
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();

    await expect(pending).rejects.toThrow("aborted");
    expect(fs.existsSync(path.join(fixture.dataDir, "telegram", "segments", "delivery-abort"))).toBe(false);
    expect(fs.readFileSync(fixture.sourcePath)).toEqual(Buffer.alloc(120, 7));
  });
});
