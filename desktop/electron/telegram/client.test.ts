import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TelegramClient } from "./client";

let server: http.Server | undefined;
let proxyServer: http.Server | undefined;
let tempDir: string | undefined;
const proxyEnvironmentKeys = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"] as const;
let originalProxyEnvironment: Partial<Record<(typeof proxyEnvironmentKeys)[number], string>>;

beforeEach(() => {
  originalProxyEnvironment = {};
  for (const key of proxyEnvironmentKeys) {
    originalProxyEnvironment[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
  if (proxyServer) {
    await new Promise<void>((resolve) => proxyServer!.close(() => resolve()));
    proxyServer = undefined;
  }
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
  for (const key of proxyEnvironmentKeys) {
    const value = originalProxyEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("TelegramClient", () => {
  it("routes a remote HTTP Bot API request through HTTP_PROXY", async () => {
    const proxiedUrls: string[] = [];
    proxyServer = http.createServer((request, response) => {
      proxiedUrls.push(request.url || "");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, result: { id: 42, is_bot: true, first_name: "Downany", username: "downany_bot" } }));
    });
    await new Promise<void>((resolve, reject) => {
      proxyServer!.once("error", reject);
      proxyServer!.listen(0, "127.0.0.1", () => resolve());
    });
    const proxyAddress = proxyServer.address() as AddressInfo;
    process.env.HTTP_PROXY = `http://127.0.0.1:${proxyAddress.port}`;

    const client = new TelegramClient({
      token: "42:test-token",
      apiBase: "http://telegram.invalid",
      timeoutMs: 1_000,
    });

    await expect(client.getMe()).resolves.toMatchObject({ id: 42, username: "downany_bot" });
    expect(proxiedUrls).toEqual(["http://telegram.invalid/bot42:test-token/getMe"]);
  });

  it("opens a remote HTTPS Bot API tunnel through HTTPS_PROXY", async () => {
    const connectTargets: string[] = [];
    proxyServer = http.createServer();
    proxyServer.on("connect", (request, socket) => {
      connectTargets.push(request.url || "");
      socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    });
    await new Promise<void>((resolve, reject) => {
      proxyServer!.once("error", reject);
      proxyServer!.listen(0, "127.0.0.1", () => resolve());
    });
    const proxyAddress = proxyServer.address() as AddressInfo;
    process.env.HTTPS_PROXY = `http://127.0.0.1:${proxyAddress.port}`;

    const client = new TelegramClient({
      token: "42:test-token",
      apiBase: "https://telegram.invalid",
      timeoutMs: 1_000,
    });

    await expect(client.getMe()).rejects.toBeDefined();
    expect(connectTargets).toEqual(["telegram.invalid:443"]);
  });

  it("connects directly when NO_PROXY matches the Bot API host", async () => {
    let proxyRequests = 0;
    proxyServer = http.createServer((_request, response) => {
      proxyRequests += 1;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, result: { id: 99, is_bot: true, first_name: "Proxy" } }));
    });
    server = http.createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, result: { id: 42, is_bot: true, first_name: "Direct" } }));
    });
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        proxyServer!.once("error", reject);
        proxyServer!.listen(0, "127.0.0.1", () => resolve());
      }),
      new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(0, "127.0.0.1", () => resolve());
      }),
    ]);
    const proxyAddress = proxyServer.address() as AddressInfo;
    const apiAddress = server.address() as AddressInfo;
    process.env.HTTP_PROXY = `http://127.0.0.1:${proxyAddress.port}`;
    process.env.NO_PROXY = "localhost,127.0.0.1";

    const client = new TelegramClient({
      token: "42:test-token",
      apiBase: `http://127.0.0.1:${apiAddress.port}`,
      timeoutMs: 1_000,
    });

    await expect(client.getMe()).resolves.toMatchObject({ id: 42, first_name: "Direct" });
    expect(proxyRequests).toBe(0);
  });

  it("supports a local HTTP Bot API and streaming multipart uploads", async () => {
    const requests: Array<{ url: string; body: Buffer }> = [];
    server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const body = Buffer.concat(chunks);
        requests.push({ url: request.url || "", body });
        response.setHeader("content-type", "application/json");
        if (request.url?.endsWith("/getMe")) {
          response.end(JSON.stringify({ ok: true, result: { id: 42, is_bot: true, first_name: "Downany", username: "downany_bot" } }));
          return;
        }
        response.end(JSON.stringify({ ok: true, result: { message_id: 7 } }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "downany-telegram-client-"));
    const filePath = path.join(tempDir, "sample video.mp4");
    fs.writeFileSync(filePath, Buffer.from("telegram-file"));

    const client = new TelegramClient({
      token: "42:test-token",
      apiBase: `http://127.0.0.1:${address.port}`,
      timeoutMs: 2_000,
    });
    await expect(client.getMe()).resolves.toMatchObject({ id: 42, username: "downany_bot" });
    await expect(client.sendFile("-1001234567890", filePath, "video", "sample")).resolves.toMatchObject({ message_id: 7 });

    expect(requests).toHaveLength(2);
    expect(requests[0].url).toContain("/bot42:test-token/getMe");
    expect(requests[1].url).toContain("/bot42:test-token/sendVideo");
    const multipart = requests[1].body.toString("utf8");
    expect(multipart).toContain("sample video.mp4");
    expect(multipart).toContain("telegram-file");
    expect(multipart).toContain('name="supports_streaming"\r\n\r\ntrue\r\n');
  });

  it("uses a local file URI without buffering the file", async () => {
    const requests: Array<{ url: string; body: string }> = [];
    server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        requests.push({ url: request.url || "", body: Buffer.concat(chunks).toString("utf8") });
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ ok: true, result: { message_id: 8 } }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "downany-telegram-local-uri-"));
    const filePath = path.join(tempDir, "下载 文件.mp4");
    fs.writeFileSync(filePath, "small");
    const client = new TelegramClient({ token: "42:test-token", apiBase: `http://127.0.0.1:${address.port}`, useLocalFileUris: true });
    await expect((client.sendFile as unknown as (...args: unknown[]) => Promise<unknown>)(
      "-100123",
      filePath,
      "video",
      "caption",
      undefined,
      { width: 1920, height: 1080, durationSeconds: 135 },
    )).resolves.toMatchObject({ message_id: 8 });
    expect(requests[0].body).toContain("file:");
    expect(requests[0].body).toContain("%E4%B8%8B%E8%BD%BD%20%E6%96%87%E4%BB%B6.mp4");
    expect(requests[0].body).not.toContain("small");
    expect(JSON.parse(requests[0].body)).toMatchObject({
      width: 1920,
      height: 1080,
      duration: 135,
      supports_streaming: true,
    });
  });

  it("enforces the cloud 50 MB ceiling while allowing the same file through the local API", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "downany-telegram-upload-ceiling-"));
    const filePath = path.join(tempDir, "large-video.mp4");
    const fd = fs.openSync(filePath, "w");
    fs.ftruncateSync(fd, 50_000_001);
    fs.closeSync(fd);

    const cloud = new TelegramClient({
      token: "42:test-token",
      apiBase: "http://127.0.0.1:9",
      timeoutMs: 100,
    });
    await expect(cloud.sendFile("-100123", filePath, "video", "caption")).rejects.toMatchObject({
      errorCode: 413,
      description: "文件超过 Telegram 云端接口 50 MB 上限",
    });

    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const local = new TelegramClient({
      token: "42:test-token",
      useLocalFileUris: true,
      requestJson: async (method, params) => {
        calls.push({ method, params });
        return { message_id: 9 };
      },
    });
    await expect(local.sendFile("-100123", filePath, "video", "caption")).resolves.toMatchObject({ message_id: 9 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "sendVideo" });
    expect(String(calls[0].params.video)).toMatch(/^file:/);
  });

  it("keeps unsafe update offsets as exact decimal strings", async () => {
    server = http.createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url?.endsWith("/getUpdates")) {
        response.end('{"ok":true,"result":[{"update_id":9007199254740992,"message":{"chat":{"id":-100123,"type":"supergroup"}}},{"update_id":9007199254740993,"channel_post":{"chat":{"id":-100124,"type":"channel"}}}]}');
        return;
      }
      response.end(JSON.stringify({ ok: true, result: [] }));
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    const client = new TelegramClient({ token: "42:test-token", apiBase: `http://127.0.0.1:${address.port}` });
    const updates = await client.getUpdates("9007199254740992");
    expect(updates.map((item) => String(item.update_id))).toEqual(["9007199254740992", "9007199254740993"]);
  });
});
