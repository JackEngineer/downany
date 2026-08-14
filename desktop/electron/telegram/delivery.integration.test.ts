import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { TelegramClient } from "./client";
import { TelegramDeliveryWorker } from "./deliveryWorker";
import type { TelegramClaim } from "./types";

let server: http.Server | undefined;
let tempDir: string | undefined;

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

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  expect(predicate()).toBe(true);
}

describe("Telegram delivery integration", () => {
  it("claims a completed output and sends it through the real HTTP client", async () => {
    const requests: Array<{ url: string; body: Buffer }> = [];
    server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        requests.push({ url: request.url || "", body: Buffer.concat(chunks) });
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ ok: true, result: { message_id: 77 } }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "downany-telegram-delivery-"));
    const filePath = path.join(tempDir, "completed video.mp4");
    fs.writeFileSync(filePath, Buffer.from("completed-download"));
    const stat = fs.statSync(filePath, { bigint: true });
    const claim: TelegramClaim = {
      delivery: {
        id: "delivery-integration",
        taskId: "task-integration",
        accountId: "42",
        targetChatId: "-1001234567890",
        targetChatType: "supergroup",
        targetChatTitle: "Integration target",
        sourceUrl: "https://example.com/video",
        title: "Completed video",
        filePath,
        fileSize: Number(stat.size),
        fileMtimeNs: stat.mtimeNs.toString(),
        mediaKind: "document",
        attemptCount: 1,
        retrySequenceCount: 0,
        fallbackUsed: false,
        segmentManifest: null,
        segmentNextIndex: 0,
        segmentMessageIds: [],
      },
      leaseId: "lease-integration",
    };

    let claimReturned = false;
    let sent: Record<string, unknown> | undefined;
    const calls: string[] = [];
    const request = async (method: string, payload?: Record<string, unknown>): Promise<unknown> => {
      calls.push(method);
      if (method === "telegram.claimNext") {
        if (claimReturned) return { claim: null };
        claimReturned = true;
        return { claim };
      }
      if (method === "telegram.markSent") {
        sent = payload;
        return {};
      }
      return {};
    };

    const client = new TelegramClient({
      token: "42:test-token",
      apiBase: `http://127.0.0.1:${address.port}`,
      timeoutMs: 2_000,
    });
    const worker = new TelegramDeliveryWorker(request, () => client, () => "42");
    worker.start();
    await waitFor(() => Boolean(sent));
    await worker.stop();

    expect(sent).toMatchObject({
      deliveryId: "delivery-integration",
      leaseId: "lease-integration",
      messageId: "77",
    });
    expect(calls.slice(0, 3)).toEqual([
      "telegram.claimNext",
      "telegram.markSending",
      "telegram.markSent",
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toContain("/bot42:test-token/sendDocument");
    expect(requests[0].body.toString("utf8")).toContain("completed video.mp4");
    expect(requests[0].body.toString("utf8")).toContain("completed-download");
  });
});
