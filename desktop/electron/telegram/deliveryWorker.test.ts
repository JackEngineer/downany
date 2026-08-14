import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { TelegramDeliveryWorker } from "./deliveryWorker";

let tempDir: string | undefined;

function createPrecisionSensitiveFile(directory: string): {
  filePath: string;
  fileSize: number;
  fileMtimeNs: string;
} {
  for (let index = 0; index < 256; index += 1) {
    const filePath = path.join(directory, `precision-${index}.mp4`);
    fs.writeFileSync(filePath, Buffer.alloc(index + 1, 7));
    const normal = fs.statSync(filePath);
    const precise = fs.statSync(filePath, { bigint: true });
    const legacyMtimeNs = String(Math.trunc(normal.mtimeMs * 1_000_000));
    if (legacyMtimeNs !== precise.mtimeNs.toString()) {
      return {
        filePath,
        fileSize: normal.size,
        fileMtimeNs: precise.mtimeNs.toString(),
      };
    }
  }
  throw new Error("测试文件系统没有生成可复现的高精度修改时间");
}

function fileMtimeNs(filePath: string): string {
  return fs.statSync(filePath, { bigint: true }).mtimeNs.toString();
}

afterEach(() => {
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("TelegramDeliveryWorker", () => {
  it("uploads an unchanged file whose nanosecond timestamp is not exactly representable as milliseconds", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "downany-telegram-worker-mtime-"));
    const file = createPrecisionSensitiveFile(tempDir);
    const methods: string[] = [];
    const request = async (method: string): Promise<unknown> => {
      methods.push(method);
      return {};
    };
    let uploaded = false;
    let sentCaption = "";
    const client = {
      maxUploadBytes: 2_000_000_000,
      sendFile: async (_chatId: string, _path: string, _kind: string, caption: string) => {
        uploaded = true;
        sentCaption = caption;
        return { message_id: 501 };
      },
    };
    const worker = new TelegramDeliveryWorker(request, () => client as never, () => "42");
    const claim = {
      delivery: {
        id: "precision-mtime", taskId: "task-precision-mtime", accountId: "42", targetChatId: "-100123", targetChatType: "supergroup" as const,
        targetChatTitle: "Test", sourceUrl: "https://example.com/video", title: "Video", filePath: file.filePath,
        fileSize: file.fileSize, fileMtimeNs: file.fileMtimeNs, mediaKind: "video" as const,
        attemptCount: 0, retrySequenceCount: 0, fallbackUsed: false,
      },
      leaseId: "lease-precision-mtime",
    };

    (worker as unknown as { running: boolean }).running = true;
    await (worker as unknown as { processClaim: (client: unknown, claim: unknown) => Promise<void> }).processClaim(client, claim);

    expect(uploaded).toBe(true);
    expect(sentCaption).toContain("Video");
    expect(sentCaption).toContain("大小：");
    expect(sentCaption).not.toContain("来源：");
    expect(sentCaption).not.toContain("https://example.com/video");
    expect(methods).toEqual(["telegram.markSending", "telegram.markSent"]);
  });

  it("sends an oversized cloud video as ordered playable parts", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "downany-telegram-worker-segments-"));
    const filePath = path.join(tempDir, "large video.mp4");
    fs.writeFileSync(filePath, Buffer.alloc(120, 7));
    const stat = fs.statSync(filePath);
    const mtimeNs = fileMtimeNs(filePath);
    const segmentDir = path.join(tempDir, "segments", "ready");
    fs.mkdirSync(segmentDir, { recursive: true });
    const parts = [0, 1, 2].map((index) => {
      const fileName = `part-${index.toString().padStart(4, "0")}.mp4`;
      fs.writeFileSync(path.join(segmentDir, fileName), Buffer.alloc(40, index + 1));
      return {
        index,
        fileName,
        fileSize: 40,
        sha256: String(index + 1).repeat(64),
        videoWidth: 1920,
        videoHeight: 1080,
        durationSeconds: 135 - index,
      };
    });
    const manifest = {
      sourceFileSize: 120,
      sourceFileMtimeNs: mtimeNs,
      segmentDir,
      parts,
    };
    const segmenter = {
      prepare: async () => manifest,
      validatePersisted: async () => manifest,
      cleanupCompleted: async () => undefined,
    };
    const calls: Array<{ method: string; payload?: Record<string, unknown> }> = [];
    const request = async (method: string, payload?: Record<string, unknown>): Promise<unknown> => {
      calls.push({ method, payload });
      if (method === "telegram.markSegmentSent") {
        return { status: payload?.segmentIndex === 2 ? "sent" : "preparing" };
      }
      return {};
    };
    const sent: Array<{
      filePath: string;
      caption: string;
      videoMetadata?: { width: number; height: number; durationSeconds: number };
    }> = [];
    const client = {
      maxUploadBytes: 50,
      sendFile: async (
        _chatId: string,
        partPath: string,
        kind: string,
        caption: string,
        _signal?: AbortSignal,
        videoMetadata?: { width: number; height: number; durationSeconds: number },
      ) => {
        expect(kind).toBe("video");
        sent.push({ filePath: partPath, caption, videoMetadata });
        return { message_id: 101 + sent.length - 1 };
      },
      sendMessage: async () => { throw new Error("oversize notice must not replace video parts"); },
    };
    const worker = new TelegramDeliveryWorker(
      request,
      () => client as never,
      () => "42",
      () => undefined,
      segmenter as never,
    );
    const claim = {
      delivery: {
        id: "segmented-1", taskId: "task-segmented", accountId: "42", targetChatId: "-100123", targetChatType: "supergroup" as const,
        targetChatTitle: "Test", sourceUrl: "https://example.com/video", title: "Large video", filePath,
        fileSize: stat.size, fileMtimeNs: mtimeNs, mediaKind: "video" as const,
        attemptCount: 0, retrySequenceCount: 0, fallbackUsed: false,
        segmentManifest: null, segmentNextIndex: 0, segmentMessageIds: [],
      },
      leaseId: "lease-segmented",
    };

    (worker as unknown as { running: boolean }).running = true;
    await (worker as unknown as { processClaim: (client: unknown, claim: unknown) => Promise<void> }).processClaim(client, claim);

    expect(sent.map((item) => path.basename(item.filePath))).toEqual([
      "part-0000.mp4",
      "part-0001.mp4",
      "part-0002.mp4",
    ]);
    expect(sent.map((item) => item.caption.includes("第 1/3 段"))).toEqual([true, false, false]);
    expect(sent[1].caption).toContain("第 2/3 段");
    expect(sent[2].caption).toContain("第 3/3 段");
    for (const item of sent) {
      expect(item.caption).not.toContain("来源：");
      expect(item.caption).not.toContain("https://example.com/video");
    }
    expect(sent.map((item) => item.videoMetadata)).toEqual([
      { width: 1920, height: 1080, durationSeconds: 135 },
      { width: 1920, height: 1080, durationSeconds: 134 },
      { width: 1920, height: 1080, durationSeconds: 133 },
    ]);
    expect(calls.map((call) => call.method)).toEqual([
      "telegram.setSegmentManifest",
      "telegram.markSending", "telegram.markSegmentSent",
      "telegram.markSending", "telegram.markSegmentSent",
      "telegram.markSending", "telegram.markSegmentSent",
    ]);
    expect(calls.filter((call) => call.method === "telegram.markSegmentSent").map((call) => call.payload?.messageId)).toEqual(["101", "102", "103"]);
    expect(fs.readFileSync(filePath)).toEqual(Buffer.alloc(120, 7));
  });

  it("resumes from the first uncommitted segment after a restart", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "downany-telegram-worker-segment-resume-"));
    const filePath = path.join(tempDir, "large.mp4");
    fs.writeFileSync(filePath, Buffer.alloc(120, 8));
    const stat = fs.statSync(filePath);
    const mtimeNs = fileMtimeNs(filePath);
    const segmentDir = path.join(tempDir, "segments", "ready");
    fs.mkdirSync(segmentDir, { recursive: true });
    const parts = [0, 1, 2].map((index) => {
      const fileName = `part-${index.toString().padStart(4, "0")}.mp4`;
      fs.writeFileSync(path.join(segmentDir, fileName), Buffer.alloc(40, index + 1));
      return { index, fileName, fileSize: 40, sha256: String(index + 1).repeat(64) };
    });
    const manifest = { sourceFileSize: 120, sourceFileMtimeNs: mtimeNs, segmentDir, parts };
    let prepareCalled = false;
    let cleaned = false;
    const segmenter = {
      prepare: async () => { prepareCalled = true; return manifest; },
      validatePersisted: async () => manifest,
      cleanupCompleted: async () => { cleaned = true; },
    };
    const calls: string[] = [];
    const request = async (method: string): Promise<unknown> => {
      calls.push(method);
      return method === "telegram.markSegmentSent" ? { status: "sent" } : {};
    };
    const sentPaths: string[] = [];
    const client = {
      maxUploadBytes: 50,
      sendFile: async (_chatId: string, partPath: string) => {
        sentPaths.push(partPath);
        return { message_id: 103 };
      },
    };
    const worker = new TelegramDeliveryWorker(request, () => client as never, () => "42", () => undefined, segmenter as never);
    const claim = {
      delivery: {
        id: "segmented-resume", taskId: "task-resume", accountId: "42", targetChatId: "-100123", targetChatType: "supergroup" as const,
        targetChatTitle: "Test", sourceUrl: "https://example.com/video", title: "Large video", filePath,
        fileSize: stat.size, fileMtimeNs: mtimeNs, mediaKind: "video" as const,
        attemptCount: 1, retrySequenceCount: 0, fallbackUsed: false,
        segmentManifest: manifest, segmentNextIndex: 2, segmentMessageIds: ["101", "102"],
      },
      leaseId: "lease-resume",
    };

    (worker as unknown as { running: boolean }).running = true;
    await (worker as unknown as { processClaim: (client: unknown, claim: unknown) => Promise<void> }).processClaim(client, claim);

    expect(prepareCalled).toBe(false);
    expect(sentPaths.map((item) => path.basename(item))).toEqual(["part-0002.mp4"]);
    expect(calls).toEqual(["telegram.markSending", "telegram.markSegmentSent"]);
    expect(cleaned).toBe(true);
  });

  it("never uploads a segment when the mark-sending result is unknown", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "downany-telegram-worker-segment-mark-"));
    const filePath = path.join(tempDir, "large.mp4");
    fs.writeFileSync(filePath, Buffer.alloc(120, 8));
    const stat = fs.statSync(filePath);
    const mtimeNs = fileMtimeNs(filePath);
    const segmentDir = path.join(tempDir, "segments", "ready");
    fs.mkdirSync(segmentDir, { recursive: true });
    const partPath = path.join(segmentDir, "part-0000.mp4");
    fs.writeFileSync(partPath, Buffer.alloc(40, 1));
    const manifest = {
      sourceFileSize: 120,
      sourceFileMtimeNs: mtimeNs,
      segmentDir,
      parts: [{ index: 0, fileName: "part-0000.mp4", fileSize: 40, sha256: "1".repeat(64) }],
    };
    const segmenter = {
      prepare: async () => manifest,
      validatePersisted: async () => manifest,
      cleanupCompleted: async () => undefined,
      cleanupDelivery: async () => undefined,
    };
    const calls: string[] = [];
    const request = async (method: string): Promise<unknown> => {
      calls.push(method);
      if (method === "telegram.markSending") throw new Error("response lost");
      return {};
    };
    let uploadCount = 0;
    const client = {
      maxUploadBytes: 50,
      sendFile: async () => {
        uploadCount += 1;
        return { message_id: 101 };
      },
    };
    const worker = new TelegramDeliveryWorker(request, () => client as never, () => "42", () => undefined, segmenter as never);
    const claim = {
      delivery: {
        id: "segmented-mark-unknown", taskId: "task-mark-unknown", accountId: "42", targetChatId: "-100123", targetChatType: "supergroup" as const,
        targetChatTitle: "Test", sourceUrl: "https://example.com/video", title: "Large video", filePath,
        fileSize: stat.size, fileMtimeNs: mtimeNs, mediaKind: "video" as const,
        attemptCount: 1, retrySequenceCount: 0, fallbackUsed: false,
        segmentManifest: manifest, segmentNextIndex: 0, segmentMessageIds: [],
      },
      leaseId: "lease-mark-unknown",
    };

    (worker as unknown as { running: boolean }).running = true;
    await (worker as unknown as { processClaim: (client: unknown, claim: unknown) => Promise<void> }).processClaim(client, claim);

    expect(uploadCount).toBe(0);
    expect(calls).toEqual(["telegram.markSending", "telegram.markUncertain"]);
  });

  it("records a cloud file-size rejection without blocking the target chat", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "downany-telegram-worker-"));
    const filePath = path.join(tempDir, "large-video.mp4");
    fs.writeFileSync(filePath, "video");
    const stat = fs.statSync(filePath);
    const mtimeNs = fileMtimeNs(filePath);
    const calls: string[] = [];
    const request = async (method: string, payload?: Record<string, unknown>): Promise<unknown> => {
      calls.push(`${method}:${JSON.stringify(payload || {})}`);
      return {};
    };
    let noticeText = "";
    const client = {
      maxUploadBytes: 50_000_000,
      sendFile: async () => {
        const error = new Error("Bad Request: file is too big") as Error & { errorCode: number; retryable: boolean };
        error.errorCode = 400;
        error.retryable = false;
        throw error;
      },
      sendMessage: async (_chatId: string, text: string) => {
        noticeText = text;
        return { message_id: 88 };
      },
    };
    const worker = new TelegramDeliveryWorker(request, () => client as never, () => "42");
    const claim = {
      delivery: {
        id: "delivery-1",
        taskId: "task-1",
        accountId: "42",
        targetChatId: "-100123",
        targetChatType: "supergroup" as const,
        targetChatTitle: "Test",
        sourceUrl: "https://example.com/video",
        title: "Large video",
        filePath,
        fileSize: stat.size,
        fileMtimeNs: mtimeNs.toString(),
        mediaKind: "video" as const,
        attemptCount: 1,
        retrySequenceCount: 0,
        fallbackUsed: false,
      },
      leaseId: "lease-1",
    };

    (worker as unknown as { running: boolean }).running = true;
    await (worker as unknown as { processClaim: (client: unknown, claim: unknown) => Promise<void> }).processClaim(client, claim);

    expect(calls.map((call) => call.split(":", 2)[0])).toEqual(["telegram.markSending", "telegram.markSkippedOversize"]);
    expect(calls.join("\n")).toContain('"messageId":"88"');
    expect(calls.join("\n")).not.toContain("telegram.markTargetFailed");
    expect(noticeText).toContain("Telegram 云端接口单文件上限为 50 MB");
    expect(noticeText).not.toContain("2 GB");
    expect(noticeText).not.toContain("来源：");
    expect(noticeText).not.toContain("https://example.com/video");
  });

  it("sends an oversize notice and keeps the local file", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "downany-telegram-worker-oversize-"));
    const filePath = path.join(tempDir, "large.mp4");
    const fd = fs.openSync(filePath, "w");
    fs.ftruncateSync(fd, 2_000_000_001);
    fs.closeSync(fd);
    const stat = fs.statSync(filePath);
    const calls: Array<{ method: string; payload?: Record<string, unknown> }> = [];
    const request = async (method: string, payload?: Record<string, unknown>): Promise<unknown> => {
      calls.push({ method, payload });
      return {};
    };
    const client = {
      maxUploadBytes: 2_000_000_000,
      sendFile: async () => { throw new Error("sendFile must not be called"); },
      sendMessage: async (_chatId: string, text: string) => {
        expect(text).toContain("2.00 GB");
        expect(text).toContain("保留");
        expect(text).not.toContain("来源：");
        expect(text).not.toContain("https://example.com/oversize");
        return { message_id: 99 };
      },
    };
    const worker = new TelegramDeliveryWorker(request, () => client as never, () => "42");
    const claim = {
      delivery: {
        id: "oversize-1", taskId: "task-oversize", accountId: "42", targetChatId: "-100123", targetChatType: "supergroup" as const,
        targetChatTitle: "Test", sourceUrl: "https://example.com/oversize", title: "Large video", filePath,
        fileSize: stat.size, fileMtimeNs: fileMtimeNs(filePath), mediaKind: "video" as const,
        attemptCount: 1, retrySequenceCount: 0, fallbackUsed: false,
      },
      leaseId: "lease-oversize",
    };
    (worker as unknown as { running: boolean }).running = true;
    await (worker as unknown as { processClaim: (client: unknown, claim: unknown) => Promise<void> }).processClaim(client, claim);
    expect(calls.map((call) => call.method)).toEqual(["telegram.markSending", "telegram.markSkippedOversize"]);
    expect(fs.statSync(filePath).size).toBe(2_000_000_001);
  });

  it("falls back once from an invalid media upload to a document", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "downany-telegram-worker-fallback-"));
    const filePath = path.join(tempDir, "video.mp4");
    fs.writeFileSync(filePath, "video");
    const stat = fs.statSync(filePath);
    const calls: Array<{ method: string; payload?: Record<string, unknown> }> = [];
    const request = async (method: string, payload?: Record<string, unknown>): Promise<unknown> => {
      calls.push({ method, payload });
      return {};
    };
    let sendCount = 0;
    const client = {
      sendFile: async (_chatId: string, _path: string, kind: string) => {
        sendCount += 1;
        if (sendCount === 1) {
          const error = new Error("Bad Request: unsupported video content") as Error & { errorCode: number; retryable: boolean };
          error.errorCode = 400;
          error.retryable = false;
          throw error;
        }
        expect(kind).toBe("document");
        return { message_id: 101 };
      },
    };
    const worker = new TelegramDeliveryWorker(request, () => client as never, () => "42");
    const claim = {
      delivery: {
        id: "fallback-1", taskId: "task-fallback", accountId: "42", targetChatId: "-100123", targetChatType: "supergroup" as const,
        targetChatTitle: "Test", sourceUrl: "https://example.com/video", title: "Video", filePath,
        fileSize: stat.size, fileMtimeNs: fileMtimeNs(filePath), mediaKind: "video" as const,
        attemptCount: 1, retrySequenceCount: 0, fallbackUsed: false,
      },
      leaseId: "lease-fallback",
    };
    (worker as unknown as { running: boolean }).running = true;
    await (worker as unknown as { processClaim: (client: unknown, claim: unknown) => Promise<void> }).processClaim(client, claim);
    expect(calls.map((call) => call.method)).toEqual(["telegram.markSending", "telegram.markFallbackUsed", "telegram.markSent"]);
    expect(sendCount).toBe(2);
  });

  it("aborts an in-flight upload on stop and records an uncertain result", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "downany-telegram-worker-stop-"));
    const filePath = path.join(tempDir, "video.mp4");
    fs.writeFileSync(filePath, "video");
    const stat = fs.statSync(filePath);
    const calls: string[] = [];
    const request = async (method: string): Promise<unknown> => {
      calls.push(method);
      return {};
    };
    let aborted = false;
    const client = {
      sendFile: async (...args: unknown[]) => new Promise<never>((_resolve, reject) => {
        const signal = args[4] as AbortSignal | undefined;
        if (signal?.aborted) {
          aborted = true;
          reject(new Error("aborted"));
          return;
        }
        signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        }, { once: true });
      }),
    };
    const worker = new TelegramDeliveryWorker(request, () => client as never, () => "42");
    const claim = {
      delivery: {
        id: "stop-1", taskId: "task-stop", accountId: "42", targetChatId: "-100123", targetChatType: "supergroup" as const,
        targetChatTitle: "Test", sourceUrl: "https://example.com/video", title: "Video", filePath,
        fileSize: stat.size, fileMtimeNs: fileMtimeNs(filePath), mediaKind: "video" as const,
        attemptCount: 1, retrySequenceCount: 0, fallbackUsed: false,
      },
      leaseId: "lease-stop",
    };
    (worker as unknown as { running: boolean; active: Promise<void> }).running = true;
    const active = (worker as unknown as { processClaim: (client: unknown, claim: unknown, generation?: number) => Promise<void> }).processClaim(client, claim, 0);
    (worker as unknown as { active: Promise<void> }).active = active;
    await new Promise<void>((resolve) => setImmediate(resolve));
    await worker.stop();
    await active;

    expect(aborted).toBe(true);
    expect(calls).toContain("telegram.markSending");
    expect(calls).toContain("telegram.markUncertain");
    expect(calls).not.toContain("telegram.markSent");
  });
});
