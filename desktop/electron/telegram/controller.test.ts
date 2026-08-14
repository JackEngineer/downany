import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { TelegramController } from "./controller";
import { TelegramCredentialVault } from "./credentialVault";
import type { TelegramVideoSegmenter } from "./videoSegmenter";

let tempDir: string | undefined;
let server: http.Server | undefined;

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

function config(targetChatId: string | null = null, accountId = "42") {
  return {
    revision: "1",
    accountId,
    botUsername: "downany_bot",
    targetChatId,
    targetChatType: targetChatId ? "supergroup" : "",
    targetChatTitle: targetChatId ? `Target ${targetChatId}` : null,
    targetVerifiedAt: targetChatId ? "2026-08-12T00:00:00.000Z" : null,
    autoSendEnabled: false,
    enabledAt: null,
    discoveredTargets: [],
    nextUpdateOffset: null,
    deliveryRecoveryHold: null,
  };
}

describe("TelegramController mutation ordering", () => {
  it("keeps discovered chats and restores the verified target when an incremental refresh is empty", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "downany-telegram-discovery-"));
    const verifiedTargetId = "-1001234567890";
    const previousTarget = {
      id: "123456789",
      type: "private" as const,
      title: "之前读取的聊天",
      username: "previous_chat",
      lastSeenAt: "2026-08-11T00:00:00.000Z",
    };
    let current = {
      ...config(verifiedTargetId),
      discoveredTargets: [previousTarget],
      nextUpdateOffset: "88",
    };
    let configuredPayload: Record<string, unknown> | undefined;
    const request = async (method: string, payload?: Record<string, unknown>): Promise<unknown> => {
      if (method === "telegram.configure") {
        configuredPayload = payload;
        current = { ...current, ...payload } as typeof current;
      }
      return current;
    };
    const controller = new TelegramController(request, tempDir);
    (controller as unknown as { config: unknown }).config = current;
    (controller as unknown as { client: unknown }).client = {
      deleteWebhook: vi.fn(async () => true),
      getUpdates: vi.fn(async () => []),
    };

    const targets = await controller.discoverTargets();

    expect(targets).toEqual([
      previousTarget,
      {
        id: verifiedTargetId,
        type: "supergroup",
        title: `Target ${verifiedTargetId}`,
        lastSeenAt: "2026-08-12T00:00:00.000Z",
      },
    ]);
    expect(configuredPayload).toEqual({
      discoveredTargets: targets,
      nextUpdateOffset: "88",
    });
  });

  it("cleans confirmed sent segment directories when the app restarts after a lost final response", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "downany-telegram-cleanup-"));
    const cleanupDelivery = vi.fn(async () => undefined);
    const requests: string[] = [];
    const request = async (method: string, payload?: Record<string, unknown>): Promise<unknown> => {
      requests.push(method);
      if (method === "telegram.getConfig") return config(null, "");
      if (method === "telegram.listDeliveries") {
        expect(payload).toEqual({ offset: 0, limit: 100, status: "sent" });
        return {
          items: [{ id: "delivery-final-response-lost" }],
          total: 1,
          offset: 0,
          limit: 100,
        };
      }
      throw new Error(`unexpected method: ${method}`);
    };
    const segmenter = {
      prepare: vi.fn(),
      validatePersisted: vi.fn(),
      cleanupCompleted: vi.fn(),
      cleanupDelivery,
    } as unknown as TelegramVideoSegmenter;
    const controller = new TelegramController(
      request,
      tempDir,
      undefined,
      undefined,
      Promise.resolve(),
      undefined,
      undefined,
      segmenter,
    );

    await controller.start();
    await controller.stop();

    expect(requests).toContain("telegram.listDeliveries");
    expect(cleanupDelivery).toHaveBeenCalledTimes(1);
    expect(cleanupDelivery).toHaveBeenCalledWith("delivery-final-response-lost");
  });

  it("serializes concurrent target changes and does not let the old snapshot win", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "downany-telegram-controller-"));
    const configured: string[] = [];
    let firstRequestEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => { firstRequestEntered = resolve; });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const request = async (method: string, payload?: Record<string, unknown>): Promise<unknown> => {
      if (method !== "telegram.configure") return config();
      const targetId = String(payload?.targetChatId || "");
      configured.push(targetId);
      if (configured.length === 1) {
        firstRequestEntered();
        await firstGate;
      }
      return config(targetId);
    };
    const controller = new TelegramController(request, tempDir);
    (controller as unknown as { client: unknown }).client = {
      getChat: async (id: string) => ({ id, type: "supergroup", title: `Target ${id}` }),
    };

    const first = controller.selectTarget("-1001");
    await firstEntered;
    const second = controller.selectTarget("-1002");
    await Promise.resolve();
    expect(configured).toEqual(["-1001"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(configured).toEqual(["-1001", "-1002"]);
  });

  it("binds a Bot through the configured API and persists the encrypted token", async () => {
    server = http.createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        ok: true,
        result: _request.url?.endsWith("/getMe")
          ? { id: 42, is_bot: true, first_name: "Downany", username: "downany_bot" }
          : true,
      }));
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    const oldApiBase = process.env.DOWNANY_TELEGRAM_API_BASE;
    process.env.DOWNANY_TELEGRAM_API_BASE = `http://127.0.0.1:${address.port}`;

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "downany-telegram-bind-"));
    const backend = {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(`encrypted:${value}`, "utf8"),
      decryptString: (value: Buffer) => value.toString("utf8").replace(/^encrypted:/, ""),
    };
    const vault = new TelegramCredentialVault(tempDir, backend);
    let configuredPayload: Record<string, unknown> | undefined;
    const request = async (method: string, payload?: Record<string, unknown>): Promise<unknown> => {
      if (method !== "telegram.configure") return config();
      configuredPayload = payload;
      return config();
    };
    const controller = new TelegramController(request, tempDir, undefined, undefined, Promise.resolve(), vault, process.env.DOWNANY_TELEGRAM_API_BASE);
    const token = `12345:${"a".repeat(24)}`;

    try {
      await expect(controller.bind(token)).resolves.toMatchObject({ accountId: "42", botUsername: "downany_bot" });
      expect(configuredPayload).toMatchObject({
        accountId: "42",
        botUsername: "downany_bot",
        autoSendEnabled: false,
        deliveryRecoveryHold: null,
      });
      expect(vault.read()).toBe(token);
    } finally {
      if (oldApiBase === undefined) delete process.env.DOWNANY_TELEGRAM_API_BASE;
      else process.env.DOWNANY_TELEGRAM_API_BASE = oldApiBase;
    }
  });

  it("cancels only the old account queue when binding a different Bot", async () => {
    server = http.createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        ok: true,
        result: _request.url?.endsWith("/getMe")
          ? { id: 42, is_bot: true, first_name: "Downany", username: "downany_bot" }
          : true,
      }));
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    const oldApiBase = process.env.DOWNANY_TELEGRAM_API_BASE;
    process.env.DOWNANY_TELEGRAM_API_BASE = `http://127.0.0.1:${address.port}`;

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "downany-telegram-rebind-"));
    const vault = new TelegramCredentialVault(tempDir, {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(`encrypted:${value}`, "utf8"),
      decryptString: (value: Buffer) => value.toString("utf8").replace(/^encrypted:/, ""),
    });
    const calls: Array<{ method: string; payload?: Record<string, unknown> }> = [];
    let current = config(null, "7");
    const request = async (method: string, payload?: Record<string, unknown>): Promise<unknown> => {
      calls.push({ method, payload });
      if (method === "telegram.getConfig") return current;
      if (method === "telegram.cancelPending") return { cancelled: 2 };
      if (method === "telegram.configure") {
        current = { ...current, ...payload, accountId: "42", botUsername: "downany_bot", revision: "2" } as typeof current;
        return current;
      }
      return current;
    };
    const controller = new TelegramController(request, tempDir, undefined, undefined, Promise.resolve(), vault, process.env.DOWNANY_TELEGRAM_API_BASE);
    const token = `12345:${"b".repeat(24)}`;

    try {
      await controller.start();
      await controller.bind(token);
      expect(calls.map((entry) => entry.method)).toContain("telegram.cancelPending");
      expect(calls.find((entry) => entry.method === "telegram.cancelPending")?.payload).toEqual({ accountId: "7" });

      // Refreshing credentials for the same account must preserve its queue.
      await controller.bind(`12345:${"c".repeat(24)}`);
      expect(calls.filter((entry) => entry.method === "telegram.cancelPending")).toHaveLength(1);
    } finally {
      await controller.stop();
      if (oldApiBase === undefined) delete process.env.DOWNANY_TELEGRAM_API_BASE;
      else process.env.DOWNANY_TELEGRAM_API_BASE = oldApiBase;
    }
  });

  it("clears a stale in-memory client when the stored token belongs to another Bot", async () => {
    server = http.createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        ok: true,
        result: _request.url?.endsWith("/getMe")
          ? { id: 99, is_bot: true, first_name: "New", username: "new_bot" }
          : true,
      }));
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "downany-telegram-stale-client-"));
    const vault = new TelegramCredentialVault(tempDir, {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(`encrypted:${value}`, "utf8"),
      decryptString: (value: Buffer) => value.toString("utf8").replace(/^encrypted:/, ""),
    });
    vault.save(`12345:${"n".repeat(24)}`);
    const request = async (method: string): Promise<unknown> => {
      if (method === "telegram.getConfig") return config(null, "42");
      return config(null, "42");
    };
    const controller = new TelegramController(
      request,
      tempDir,
      undefined,
      undefined,
      Promise.resolve(),
      vault,
      `http://127.0.0.1:${address.port}`,
    );
    (controller as unknown as { client: unknown }).client = { getMe: async () => ({ id: 42, is_bot: true, first_name: "Old" }) };

    await controller.getConfig();

    expect((controller as unknown as { client: unknown }).client).toBeNull();
  });
});
