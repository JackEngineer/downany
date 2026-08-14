import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { MAX_UPLOAD_BYTES, type TelegramClient } from "./client";
import type { TelegramClaim, TelegramSegmentManifest, TelegramSegmentPart, TelegramVideoMetadata } from "./types";
import type { TelegramVideoSegmenter, VideoSegmentInput } from "./videoSegmenter";

type SidecarRequest = (method: string, payload?: Record<string, unknown>) => Promise<unknown>;

function isoIn(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function nowIso(): string {
  return new Date().toISOString();
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "errorCode" in error) {
    return String((error as { errorCode?: unknown }).errorCode || "TELEGRAM_ERROR");
  }
  return "NETWORK_ERROR";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 500);
  return String(error).slice(0, 500);
}

function isOversizeError(error: unknown): boolean {
  const code = errorCode(error);
  if (code === "413") return true;
  const message = errorMessage(error).toLowerCase();
  return message.includes("file is too big")
    || message.includes("file too large")
    || message.includes("request entity too large")
    || message.includes("exceeds the maximum");
}

function isMediaInvalidError(error: unknown): boolean {
  const code = errorCode(error);
  if (code !== "400") return false;
  const message = errorMessage(error).toLowerCase();
  return message.includes("media") || message.includes("video") || message.includes("audio")
    || message.includes("document") || message.includes("unsupported") || message.includes("wrong file");
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(2)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(2)} KB`;
  return `${bytes} B`;
}

function buildCaption(title: string, fileSize: number): string {
  const sizeLine = `大小：${formatBytes(fileSize)}`;
  const fixed = sizeLine;
  const room = Math.max(0, 1024 - (fixed ? fixed.length + 1 : 0));
  return [title.slice(0, room), fixed].filter(Boolean).join("\n").slice(0, 1024);
}

function buildSegmentCaption(
  title: string,
  fileSize: number,
  index: number,
  total: number,
): string {
  return buildCaption(`${title}\n第 ${index + 1}/${total} 段`, fileSize);
}

function videoMetadataForPart(part: TelegramSegmentPart): TelegramVideoMetadata | undefined {
  if (
    !Number.isSafeInteger(part.videoWidth)
    || Number(part.videoWidth) < 1
    || !Number.isSafeInteger(part.videoHeight)
    || Number(part.videoHeight) < 1
    || !Number.isSafeInteger(part.durationSeconds)
    || Number(part.durationSeconds) < 1
  ) return undefined;
  return {
    width: Number(part.videoWidth),
    height: Number(part.videoHeight),
    durationSeconds: Number(part.durationSeconds),
  };
}

type VideoSegmenter = Pick<
  TelegramVideoSegmenter,
  "prepare" | "validatePersisted" | "cleanupCompleted" | "cleanupDelivery"
>;

async function sendOversizeNotice(
  client: TelegramClient,
  delivery: TelegramClaim["delivery"],
  fileSize: number,
  maxUploadBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const limit = maxUploadBytes === 50_000_000
      ? "Telegram 云端接口单文件上限为 50 MB"
      : `Telegram 本地接口单文件上限为 ${formatBytes(maxUploadBytes)}`;
    const notice = await client.sendMessage(
      delivery.targetChatId,
      `百纳已保留本地文件，但 ${limit}，未上传：${formatBytes(fileSize)}。\n${buildCaption(delivery.title, fileSize)}`,
      signal,
    );
    return String(notice.message_id || "");
  } catch {
    return "";
  }
}

function retryDelaySeconds(error: unknown, attemptCount: number): number {
  if (error && typeof error === "object" && "retryAfterSeconds" in error) {
    const retryAfter = Number((error as { retryAfterSeconds?: unknown }).retryAfterSeconds);
    if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(3600, Math.trunc(retryAfter));
  }
  const schedule = [10, 30, 120, 600, 3600];
  return schedule[Math.min(schedule.length - 1, Math.max(0, attemptCount - 1))];
}

export class TelegramDeliveryWorker {
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private active: Promise<void> | null = null;
  private activeAbort: AbortController | null = null;
  private generation = 0;

  constructor(
    private readonly request: SidecarRequest,
    private readonly getClient: () => TelegramClient | null,
    private readonly getAccountId: () => string | null,
    private readonly onError: (error: Error) => void = () => undefined,
    private readonly videoSegmenter?: VideoSegmenter,
  ) {}

  start(): void {
    if (this.running) return;
    this.generation += 1;
    const generation = this.generation;
    this.running = true;
    this.loopPromise = this.runLoop(generation);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.generation += 1;
    this.activeAbort?.abort();
    const active = this.active;
    const loop = this.loopPromise;
    const deadline = Date.now() + 8_000;
    const waitBounded = async (promise: Promise<void> | null): Promise<void> => {
      if (!promise) return;
      const remaining = Math.max(0, deadline - Date.now());
      await Promise.race([
        promise.catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, remaining)),
      ]);
    };
    await waitBounded(active);
    await waitBounded(loop);
    this.loopPromise = null;
  }

  private async runLoop(generation: number): Promise<void> {
    while (this.running && this.generation === generation) {
      try {
        const accountId = this.getAccountId();
        const client = this.getClient();
        if (!accountId || !client) {
          await this.delay(1000);
          continue;
        }
        const leaseId = randomUUID();
        const claimResult = (await this.request("telegram.claimNext", {
          accountId,
          leaseId,
          now: nowIso(),
          leaseExpiresAt: isoIn(120),
        })) as { claim?: TelegramClaim | null };
        if (!claimResult.claim) {
          await this.delay(1200);
          continue;
        }
        const claim = claimResult.claim;
        this.active = this.processClaim(client, claim, generation);
        await this.active;
        if (this.generation === generation) this.active = null;
      } catch (error) {
        if (this.generation === generation) {
          this.active = null;
          if (this.running) this.onError(error instanceof Error ? error : new Error(String(error)));
          await this.delay(1200);
        }
      }
    }
  }

  private async processClaim(client: TelegramClient, claim: TelegramClaim, generation = this.generation): Promise<void> {
    const delivery = claim.delivery;
    const leaseId = claim.leaseId;
    const abortController = new AbortController();
    this.activeAbort = abortController;
    const current = (): boolean => this.running && this.generation === generation && !abortController.signal.aborted;
    const renew = setInterval(() => {
      if (!current()) return;
      void this.request("telegram.renewLease", {
        deliveryId: delivery.id,
        leaseId,
        leaseExpiresAt: isoIn(120),
      }).catch(() => undefined);
    }, 30_000);
    try {
      if (!current()) {
        await this.request("telegram.releaseClaim", { deliveryId: delivery.id, leaseId, releasedAt: nowIso() });
        return;
      }
      let stableSize: number;
      try {
        stableSize = this.assertStableFile(delivery.filePath, delivery.fileSize, delivery.fileMtimeNs, true);
      } catch (error) {
        await this.request("telegram.markFailed", {
          deliveryId: delivery.id,
          leaseId,
          code: "FILE_CHANGED",
          message: error instanceof Error && error.message === "FILE_MISSING" ? "下载文件已不存在" : "下载文件在发送前发生变化",
          failedAt: nowIso(),
        });
        return;
      }
      if (
        stableSize > client.maxUploadBytes
        && client.maxUploadBytes < MAX_UPLOAD_BYTES
        && delivery.mediaKind === "video"
        && this.videoSegmenter
      ) {
        await this.processSegmentedClaim(
          client,
          claim,
          stableSize,
          abortController,
          current,
        );
        return;
      }
      if (!await this.markSendingOrUncertain(
        delivery.id,
        leaseId,
        delivery.mediaKind,
        delivery.fallbackUsed,
        true,
      )) return;
      if (!current()) {
        await this.markResultUnknown(delivery.id, leaseId);
        return;
      }
      try {
        const currentSize = this.assertStableFile(delivery.filePath, delivery.fileSize, delivery.fileMtimeNs, true);
        if (currentSize > client.maxUploadBytes) {
          const messageId = await sendOversizeNotice(client, delivery, currentSize, client.maxUploadBytes, abortController.signal);
          if (!current()) {
            await this.markResultUnknown(delivery.id, leaseId);
            return;
          }
          await this.request("telegram.markSkippedOversize", {
            deliveryId: delivery.id,
            leaseId,
            messageId,
            sentAt: nowIso(),
          });
          return;
        }
        const result = await client.sendFile(
          delivery.targetChatId,
          delivery.filePath,
          delivery.mediaKind === "video" || delivery.mediaKind === "audio" ? delivery.mediaKind : "document",
          buildCaption(delivery.title, currentSize),
          abortController.signal,
        );
        if (!current()) {
          await this.markResultUnknown(delivery.id, leaseId);
          return;
        }
        const messageId = String(result.message_id || "");
        if (!messageId) throw new Error("Telegram 未返回消息编号");
        await this.request("telegram.markSent", {
          deliveryId: delivery.id,
          leaseId,
          messageId,
          sentAt: nowIso(),
        });
      } catch (error) {
        if (!current()) {
          await this.markResultUnknown(delivery.id, leaseId);
          return;
        }
        let finalError = error;
        if (!delivery.fallbackUsed && (delivery.mediaKind === "video" || delivery.mediaKind === "audio") && isMediaInvalidError(error)) {
          try {
            await this.request("telegram.markFallbackUsed", { deliveryId: delivery.id, leaseId });
            const fallback = await client.sendFile(
              delivery.targetChatId,
              delivery.filePath,
              "document",
              buildCaption(delivery.title, delivery.fileSize),
              abortController.signal,
            );
            if (!current()) {
              await this.markResultUnknown(delivery.id, leaseId);
              return;
            }
            const fallbackMessageId = String(fallback.message_id || "");
            if (!fallbackMessageId) throw new Error("Telegram 未返回文档消息编号");
            await this.request("telegram.markSent", { deliveryId: delivery.id, leaseId, messageId: fallbackMessageId, sentAt: nowIso() });
            return;
          } catch (fallbackError) {
            finalError = fallbackError;
          }
        }
        if (!current()) {
          await this.markResultUnknown(delivery.id, leaseId);
          return;
        }
        const code = errorCode(finalError);
        const message = errorMessage(finalError);
        if (isOversizeError(finalError)) {
          const messageId = await sendOversizeNotice(client, delivery, delivery.fileSize, client.maxUploadBytes, abortController.signal);
          if (!current()) {
            await this.markResultUnknown(delivery.id, leaseId);
            return;
          }
          await this.request("telegram.markSkippedOversize", {
            deliveryId: delivery.id,
            leaseId,
            messageId,
            sentAt: nowIso(),
          });
          return;
        }
        const retryable = Boolean(error && typeof error === "object" && "retryable" in error && (error as { retryable?: unknown }).retryable)
          || code === "NETWORK_ERROR" || code === "ETIMEDOUT" || code === "ECONNRESET" || code === "500" || code === "502" || code === "503" || code === "504";
        if (retryable) {
          await this.request("telegram.markRetry", {
            deliveryId: delivery.id,
            leaseId,
            code,
            message,
            nextAttemptAt: isoIn(retryDelaySeconds(finalError, delivery.attemptCount)),
          });
        } else if (code === "400" || code === "403") {
          await this.request("telegram.markTargetFailed", {
            deliveryId: delivery.id,
            leaseId,
            accountId: delivery.accountId,
            targetChatId: delivery.targetChatId,
            code: `TELEGRAM_${code}`,
            message,
            failedAt: nowIso(),
          });
        } else {
          await this.request("telegram.markFailed", {
            deliveryId: delivery.id,
            leaseId,
            code: code === "413" ? "FILE_TOO_LARGE" : code,
            message,
            failedAt: nowIso(),
          });
        }
      }
    } finally {
      clearInterval(renew);
      if (this.activeAbort === abortController) this.activeAbort = null;
    }
  }

  private async processSegmentedClaim(
    client: TelegramClient,
    claim: TelegramClaim,
    stableSize: number,
    abortController: AbortController,
    current: () => boolean,
  ): Promise<void> {
    const segmenter = this.videoSegmenter;
    if (!segmenter) throw new Error("SEGMENTER_UNAVAILABLE");
    const delivery = claim.delivery;
    const leaseId = claim.leaseId;
    const input: VideoSegmentInput = {
      deliveryId: delivery.id,
      sourcePath: delivery.filePath,
      sourceSize: stableSize,
      sourceMtimeNs: delivery.fileMtimeNs,
    };
    let manifest: TelegramSegmentManifest | null = delivery.segmentManifest || null;
    try {
      if (manifest) {
        manifest = await segmenter.validatePersisted(input, manifest);
      } else {
        manifest = await segmenter.prepare(input, abortController.signal);
        if (!manifest) throw new Error("SEGMENT_MANIFEST_NOT_CREATED");
        if (!current()) {
          await this.request("telegram.releaseClaim", {
            deliveryId: delivery.id,
            leaseId,
            releasedAt: nowIso(),
          }).catch(() => undefined);
          return;
        }
        await this.request("telegram.setSegmentManifest", {
          deliveryId: delivery.id,
          leaseId,
          manifest,
          preparedAt: nowIso(),
        });
      }
    } catch (error) {
      if (!current()) {
        await this.request("telegram.releaseClaim", {
          deliveryId: delivery.id,
          leaseId,
          releasedAt: nowIso(),
        }).catch(() => undefined);
        return;
      }
      await this.request("telegram.markFailed", {
        deliveryId: delivery.id,
        leaseId,
        code: "SEGMENT_PREPARATION_FAILED",
        message: errorMessage(error),
        failedAt: nowIso(),
      });
      return;
    }
    if (!manifest || delivery.segmentNextIndex < 0 || delivery.segmentNextIndex > manifest.parts.length) {
      await this.request("telegram.markFailed", {
        deliveryId: delivery.id,
        leaseId,
        code: "SEGMENT_PROGRESS_INVALID",
        message: "视频分段进度无效",
        failedAt: nowIso(),
      });
      return;
    }

    let fallbackUsed = delivery.fallbackUsed;
    let chargeAttempt = true;
    for (let index = delivery.segmentNextIndex; index < manifest.parts.length; index += 1) {
      const part = manifest.parts[index];
      const videoMetadata = videoMetadataForPart(part);
      if (!current()) {
        await this.request("telegram.releaseClaim", {
          deliveryId: delivery.id,
          leaseId,
          releasedAt: nowIso(),
        }).catch(() => undefined);
        return;
      }
      if (!await this.markSendingOrUncertain(
        delivery.id,
        leaseId,
        fallbackUsed ? "document" : "video",
        fallbackUsed,
        chargeAttempt,
      )) return;
      chargeAttempt = false;
      if (!current()) {
        await this.markResultUnknown(delivery.id, leaseId);
        return;
      }
      const partPath = path.join(manifest.segmentDir, part.fileName);
      let result;
      try {
        try {
          result = await client.sendFile(
            delivery.targetChatId,
            partPath,
            fallbackUsed ? "document" : "video",
            buildSegmentCaption(delivery.title, part.fileSize, index, manifest.parts.length),
            abortController.signal,
            fallbackUsed ? undefined : videoMetadata,
          );
        } catch (error) {
          if (fallbackUsed || !isMediaInvalidError(error)) throw error;
          await this.request("telegram.markFallbackUsed", { deliveryId: delivery.id, leaseId });
          fallbackUsed = true;
          result = await client.sendFile(
            delivery.targetChatId,
            partPath,
            "document",
            buildSegmentCaption(delivery.title, part.fileSize, index, manifest.parts.length),
            abortController.signal,
            undefined,
          );
        }
      } catch (error) {
        if (!current()) {
          await this.markResultUnknown(delivery.id, leaseId);
          return;
        }
        await this.settleSegmentSendError(delivery, leaseId, error);
        return;
      }
      if (!current()) {
        await this.markResultUnknown(delivery.id, leaseId);
        return;
      }
      const messageId = String(result?.message_id || "");
      if (!messageId) {
        await this.markResultUnknown(delivery.id, leaseId);
        return;
      }
      let settled: { status?: string };
      try {
        settled = (await this.request("telegram.markSegmentSent", {
          deliveryId: delivery.id,
          leaseId,
          segmentIndex: index,
          messageId,
          sentAt: nowIso(),
        })) as { status?: string };
      } catch {
        await this.markResultUnknown(delivery.id, leaseId);
        return;
      }
      const expectedStatus = index === manifest.parts.length - 1 ? "sent" : "preparing";
      if (settled.status !== expectedStatus) {
        await this.markResultUnknown(delivery.id, leaseId);
        return;
      }
      if (expectedStatus === "sent") {
        await segmenter.cleanupCompleted(delivery.id, manifest).catch((error) => {
          this.onError(error instanceof Error ? error : new Error(String(error)));
        });
      }
    }
  }

  private async settleSegmentSendError(
    delivery: TelegramClaim["delivery"],
    leaseId: string,
    error: unknown,
  ): Promise<void> {
    const code = errorCode(error);
    const message = errorMessage(error);
    if (isOversizeError(error)) {
      await this.request("telegram.markFailed", {
        deliveryId: delivery.id,
        leaseId,
        code: "SEGMENT_EXCEEDS_CLOUD_LIMIT",
        message,
        failedAt: nowIso(),
      });
      return;
    }
    const retryable = Boolean(error && typeof error === "object" && "retryable" in error && (error as { retryable?: unknown }).retryable)
      || code === "NETWORK_ERROR" || code === "ETIMEDOUT" || code === "ECONNRESET" || code === "500" || code === "502" || code === "503" || code === "504";
    if (retryable) {
      await this.request("telegram.markRetry", {
        deliveryId: delivery.id,
        leaseId,
        code,
        message,
        nextAttemptAt: isoIn(retryDelaySeconds(error, delivery.attemptCount)),
      });
    } else if (code === "400" || code === "403") {
      await this.request("telegram.markTargetFailed", {
        deliveryId: delivery.id,
        leaseId,
        accountId: delivery.accountId,
        targetChatId: delivery.targetChatId,
        code: `TELEGRAM_${code}`,
        message,
        failedAt: nowIso(),
      });
    } else {
      await this.request("telegram.markFailed", {
        deliveryId: delivery.id,
        leaseId,
        code,
        message,
        failedAt: nowIso(),
      });
    }
  }

  private async markSendingOrUncertain(
    deliveryId: string,
    leaseId: string,
    mediaKind: string,
    fallbackUsed: boolean,
    chargeAttempt: boolean,
  ): Promise<boolean> {
    try {
      await this.request("telegram.markSending", {
        deliveryId,
        leaseId,
        requestStartedAt: nowIso(),
        mediaKind,
        fallbackUsed,
        chargeAttempt,
      });
      return true;
    } catch {
      // The Sidecar may have committed the sending transition before the
      // response was lost. Never submit a Telegram request unless the durable
      // pre-send boundary returned a definite success.
      await this.markResultUnknown(deliveryId, leaseId);
      return false;
    }
  }

  private async markResultUnknown(deliveryId: string, leaseId: string): Promise<void> {
    await this.request("telegram.markUncertain", {
      deliveryId,
      leaseId,
      code: "DELIVERY_STOPPED_RESULT_UNKNOWN",
      message: "发送在应用停止或账号切换时被中断，Telegram 可能已经收到文件。",
      failedAt: nowIso(),
    }).catch(() => undefined);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private assertStableFile(filePath: string, expectedSize: number, expectedMtimeNs: string, allowOversize = false): number {
    let stat: fs.BigIntStats;
    try {
      stat = fs.statSync(filePath, { bigint: true });
    } catch {
      throw new Error("FILE_MISSING");
    }
    if (!stat.isFile()) throw new Error("FILE_MISSING");
    const size = Number(stat.size);
    if (!Number.isSafeInteger(size)) throw new Error("FILE_TOO_LARGE");
    if (!allowOversize && size > 2_000_000_000) throw new Error("FILE_TOO_LARGE");
    if (size !== expectedSize || stat.mtimeNs.toString() !== String(expectedMtimeNs)) throw new Error("FILE_CHANGED");
    return size;
  }
}
