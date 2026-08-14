import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { TelegramController } from "./controller";
import { TelegramCredentialVault } from "./credentialVault";
import type { TelegramClaim, TelegramConfig } from "./types";

let server: http.Server | undefined;
let tempDir: string | undefined;

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  expect(predicate()).toBe(true);
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("Telegram bind-to-delivery flow", () => {
  it("binds a Bot, selects a chat, enables auto-send, and uploads a completed file", async () => {
    const sentRequests: string[] = [];
    server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const url = request.url || "";
        sentRequests.push(url);
        response.setHeader("content-type", "application/json");
        let result: unknown = true;
        if (url.endsWith("/getMe")) {
          result = { id: 42, is_bot: true, first_name: "Downany", username: "downany_bot" };
        } else if (url.endsWith("/getChat")) {
          result = { id: "-100123", type: "supergroup", title: "Delivery target" };
        } else if (url.endsWith("/sendDocument")) {
          result = { message_id: 99 };
        }
        response.end(JSON.stringify({ ok: true, result }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    const oldApiBase = process.env.DOWNANY_TELEGRAM_API_BASE;
    process.env.DOWNANY_TELEGRAM_API_BASE = `http://127.0.0.1:${address.port}`;

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "downany-telegram-e2e-"));
    const filePath = path.join(tempDir, "completed.mp4");
    fs.writeFileSync(filePath, Buffer.from("completed output"));
    const fileStat = fs.statSync(filePath, { bigint: true });
    const claim: TelegramClaim = {
      delivery: {
        id: "delivery-e2e",
        taskId: "task-e2e",
        accountId: "42",
        targetChatId: "-100123",
        targetChatType: "supergroup",
        targetChatTitle: "Delivery target",
        sourceUrl: "https://example.com/completed.mp4",
        title: "Completed output",
        filePath,
        fileSize: Number(fileStat.size),
        fileMtimeNs: fileStat.mtimeNs.toString(),
        mediaKind: "document",
        attemptCount: 1,
        retrySequenceCount: 0,
        fallbackUsed: false,
        segmentManifest: null,
        segmentNextIndex: 0,
        segmentMessageIds: [],
      },
      leaseId: "lease-e2e",
    };
    let config: TelegramConfig = {
      revision: "initial",
      accountId: null,
      botUsername: null,
      targetChatId: null,
      targetChatType: "",
      targetChatTitle: null,
      targetVerifiedAt: null,
      autoSendEnabled: false,
      enabledAt: null,
      discoveredTargets: [],
      nextUpdateOffset: null,
      deliveryRecoveryHold: null,
    };
    let claimReturned = false;
    let sentPayload: Record<string, unknown> | undefined;
    const calls: string[] = [];
    const request = async (method: string, payload?: Record<string, unknown>): Promise<unknown> => {
      calls.push(method);
      if (method === "telegram.getConfig") return config;
      if (method === "telegram.configure") {
        const patch = payload || {};
        const enabling = patch.autoSendEnabled === true && !config.autoSendEnabled;
        config = {
          ...config,
          ...patch,
          enabledAt: enabling ? "2026-08-12T00:00:00.000Z" : (patch.enabledAt as string | null | undefined) ?? config.enabledAt,
          revision: `revision-${calls.length}`,
        } as TelegramConfig;
        return config;
      }
      if (method === "telegram.claimNext") {
        if (claimReturned) return { claim: null };
        claimReturned = true;
        return { claim };
      }
      if (method === "telegram.markSent") {
        sentPayload = payload;
        return { ...config, status: "sent", telegramMessageId: "99" };
      }
      if (method === "telegram.markSending" || method === "telegram.renewLease") {
        return { ok: true };
      }
      throw new Error(`unexpected Sidecar method: ${method}`);
    };
    const vault = new TelegramCredentialVault(tempDir, {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(`encrypted:${value}`, "utf8"),
      decryptString: (value: Buffer) => value.toString("utf8").replace(/^encrypted:/, ""),
    });
    const controller = new TelegramController(request, tempDir, undefined, undefined, Promise.resolve(), vault, process.env.DOWNANY_TELEGRAM_API_BASE);
    const token = `12345:${"a".repeat(24)}`;

    try {
      await controller.bind(token);
      await controller.selectTarget("-100123");
      await controller.setAutoSend(true);
      try {
        await waitFor(() => sentPayload !== undefined);
      } catch (error) {
        throw new Error(`${String(error)} calls=${JSON.stringify(calls)} requests=${JSON.stringify(sentRequests)} config=${JSON.stringify(config)}`);
      }

      expect(calls).toContain("telegram.claimNext");
      expect(calls).toContain("telegram.markSending");
      expect(calls).toContain("telegram.markSent");
      expect(sentPayload).toMatchObject({ deliveryId: "delivery-e2e", leaseId: "lease-e2e", messageId: "99" });
      expect(sentRequests.some((url) => url.endsWith("/sendDocument"))).toBe(true);
      expect(config.autoSendEnabled).toBe(true);
      expect(config.targetChatId).toBe("-100123");
    } finally {
      await controller.stop();
      if (oldApiBase === undefined) delete process.env.DOWNANY_TELEGRAM_API_BASE;
      else process.env.DOWNANY_TELEGRAM_API_BASE = oldApiBase;
    }
  });
});
