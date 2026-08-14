import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { getProxyForUrl } from "proxy-from-env";

import type {
  TelegramChat,
  TelegramMessageResult,
  TelegramUpdate,
  TelegramUser,
  TelegramVideoMetadata,
} from "./types";

export const MAX_UPLOAD_BYTES = 2_000_000_000;
export const CLOUD_MAX_UPLOAD_BYTES = 50_000_000;

export class TelegramApiError extends Error {
  readonly errorCode: number;
  readonly description: string;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | null;

  constructor(errorCode: number, description: string, retryAfterSeconds: number | null = null) {
    super(description);
    this.name = "TelegramApiError";
    this.errorCode = errorCode;
    this.description = description;
    this.retryable = errorCode >= 500 || errorCode === 429;
    this.retryAfterSeconds = Number.isFinite(retryAfterSeconds) && retryAfterSeconds !== null && retryAfterSeconds >= 0
      ? Math.min(3600, Math.trunc(retryAfterSeconds))
      : null;
  }
}

export interface TelegramClientOptions {
  token: string;
  apiBase?: string;
  timeoutMs?: number;
  useLocalFileUris?: boolean;
  requestJson?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
}

interface TelegramEnvelope<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

class TelegramJsonParser {
  private index = 0;
  private members = 0;

  constructor(private readonly text: string) {
    if (Buffer.byteLength(text, "utf8") > 16 * 1024 * 1024) throw new Error("Telegram response too large");
  }

  parse(): unknown {
    const value = this.value(undefined, 0);
    this.ws();
    if (this.index !== this.text.length) throw new Error("Telegram response has trailing data");
    return value;
  }

  private ws(): void {
    while (this.index < this.text.length && /\s/.test(this.text[this.index])) this.index += 1;
  }

  private value(property: string | undefined, depth: number): unknown {
    if (depth > 64) throw new Error("Telegram response nesting limit exceeded");
    this.ws();
    const char = this.text[this.index];
    if (char === "{") return this.object(depth + 1);
    if (char === "[") return this.array(depth + 1);
    if (char === '"') return this.string();
    if (this.text.startsWith("true", this.index)) { this.index += 4; return true; }
    if (this.text.startsWith("false", this.index)) { this.index += 5; return false; }
    if (this.text.startsWith("null", this.index)) { this.index += 4; return null; }
    return this.number(property);
  }

  private object(depth: number): Record<string, unknown> {
    this.index += 1;
    const result: Record<string, unknown> = {};
    const keys = new Set<string>();
    this.ws();
    if (this.text[this.index] === "}") { this.index += 1; return result; }
    while (this.index < this.text.length) {
      this.ws();
      if (this.text[this.index] !== '"') throw new Error("Telegram response object key invalid");
      const key = this.string();
      if (keys.has(key)) throw new Error("Telegram response contains duplicate object key");
      keys.add(key);
      this.ws();
      if (this.text[this.index] !== ":") throw new Error("Telegram response object missing colon");
      this.index += 1;
      result[key] = this.value(key, depth);
      this.members += 1;
      if (this.members > 100_000) throw new Error("Telegram response member limit exceeded");
      this.ws();
      if (this.text[this.index] === "}") { this.index += 1; return result; }
      if (this.text[this.index] !== ",") throw new Error("Telegram response object missing comma");
      this.index += 1;
    }
    throw new Error("Telegram response object is incomplete");
  }

  private array(depth: number): unknown[] {
    this.index += 1;
    const result: unknown[] = [];
    this.ws();
    if (this.text[this.index] === "]") { this.index += 1; return result; }
    while (this.index < this.text.length) {
      result.push(this.value(undefined, depth));
      this.members += 1;
      if (this.members > 100_000) throw new Error("Telegram response member limit exceeded");
      this.ws();
      if (this.text[this.index] === "]") { this.index += 1; return result; }
      if (this.text[this.index] !== ",") throw new Error("Telegram response array missing comma");
      this.index += 1;
    }
    throw new Error("Telegram response array is incomplete");
  }

  private string(): string {
    if (this.text[this.index] !== '"') throw new Error("Telegram response string invalid");
    this.index += 1;
    let result = "";
    while (this.index < this.text.length) {
      const char = this.text[this.index++];
      if (char === '"') return result;
      if (char < " ") throw new Error("Telegram response string contains control character");
      if (char !== "\\") { result += char; continue; }
      const escaped = this.text[this.index++];
      const simple: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
      if (escaped in simple) { result += simple[escaped]; continue; }
      if (escaped !== "u") throw new Error("Telegram response escape invalid");
      const hex = this.text.slice(this.index, this.index + 4);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error("Telegram response unicode escape invalid");
      result += String.fromCharCode(Number.parseInt(hex, 16));
      this.index += 4;
    }
    throw new Error("Telegram response string is incomplete");
  }

  private number(property: string | undefined): number | string {
    const match = this.text.slice(this.index).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
    if (!match) throw new Error("Telegram response number invalid");
    const raw = match[0];
    this.index += raw.length;
    if (property === "update_id" || property === "id" || property === "message_id") {
      if (!/^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/.test(raw)) throw new Error("Telegram ID number invalid");
      const parsed = Number(raw);
      return Number.isSafeInteger(parsed) ? parsed : raw;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || !Number.isSafeInteger(parsed) && !raw.includes(".")) throw new Error("Telegram numeric field out of range");
    return parsed;
  }
}

function parseTelegramJson(raw: string): unknown {
  return new TelegramJsonParser(raw).parse();
}

function encodeValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export class TelegramClient {
  readonly maxUploadBytes: number;
  private readonly token: string;
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly injected?: TelegramClientOptions["requestJson"];
  private readonly useLocalFileUris: boolean;

  constructor(options: TelegramClientOptions) {
    this.token = options.token;
    this.base = (options.apiBase || "https://api.telegram.org").replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.injected = options.requestJson;
    this.useLocalFileUris = options.useLocalFileUris ?? false;
    this.maxUploadBytes = this.useLocalFileUris ? MAX_UPLOAD_BYTES : CLOUD_MAX_UPLOAD_BYTES;
  }

  private requestAgent(endpoint: URL): http.Agent | undefined {
    const proxyUrl = getProxyForUrl(endpoint.href);
    if (!proxyUrl) return undefined;
    if (endpoint.protocol === "http:") {
      return new HttpProxyAgent(proxyUrl);
    }
    if (endpoint.protocol === "https:") {
      return new HttpsProxyAgent(proxyUrl);
    }
    return undefined;
  }

  private async request<T>(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    if (this.injected) {
      return (await this.injected(method, params)) as T;
    }
    const envelope = await this.requestHttp(method, params, undefined, signal);
    return this.unwrap<T>(method, envelope);
  }

  private unwrap<T>(method: string, envelope: unknown): T {
    const body = envelope as TelegramEnvelope<T>;
    if (!body || body.ok !== true) {
      throw new TelegramApiError(
        Number(body?.error_code || 500),
        String(body?.description || `${method} failed`),
        body?.parameters?.retry_after ?? null,
      );
    }
    return body.result as T;
  }

  private requestHttp(
    method: string,
    params: Record<string, unknown>,
    file?: { field: string; path: string; contentType: string },
    signal?: AbortSignal,
  ): Promise<unknown> {
    const endpoint = new URL(`${this.base}/bot${this.token}/${method}`);
    if (!file) {
      return new Promise((resolve, reject) => {
        const body = JSON.stringify(params);
        const transport = endpoint.protocol === "http:" ? http : https;
        const request = transport.request(endpoint, {
          method: "POST",
          agent: this.requestAgent(endpoint),
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          },
          signal,
        }, (response) => this.collectResponse(response, resolve, reject));
        request.setTimeout(this.timeoutMs, () => request.destroy(new Error("Telegram request timed out")));
        request.once("error", reject);
        request.end(body);
      });
    }
    return new Promise((resolve, reject) => {
      const boundary = `----DownanyTelegram${randomBytes(12).toString("hex")}`;
      const prefix: Buffer[] = [];
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) continue;
        prefix.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${encodeValue(value)}\r\n`, "utf8"));
      }
      const fileName = path.basename(file.path);
      prefix.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${fileName.replace(/[\r\n\"]+/g, "_")}\"\r\nContent-Type: ${file.contentType}\r\n\r\n`, "utf8"));
      const suffix = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
      let stat: fs.Stats;
      try {
        stat = fs.statSync(file.path);
      } catch (error) {
        reject(error);
        return;
      }
      const contentLength = prefix.reduce((sum, part) => sum + part.byteLength, 0) + stat.size + suffix.byteLength;
      const transport = endpoint.protocol === "http:" ? http : https;
      const request = transport.request(endpoint, {
        method: "POST",
        agent: this.requestAgent(endpoint),
        headers: {
          "content-type": `multipart/form-data; boundary=${boundary}`,
          "content-length": contentLength,
        },
        signal,
      }, (response) => this.collectResponse(response, resolve, reject));
      // 文件上传不能沿用普通 JSON 请求的 30 秒总时限：慢速网络会在
      // 请求仍有进度时被误判为失败，随后队列只能进入 uncertain。按文件
      // 大小给出有界但足够宽松的 watchdog；本地 file: URI 仍只发送小 JSON。
      const uploadTimeoutMs = Math.max(
        this.timeoutMs,
        this.timeoutMs + Math.ceil(stat.size / (5 * 1024 * 1024)) * 1_000,
      );
      request.setTimeout(uploadTimeoutMs, () => request.destroy(new Error("Telegram upload timed out")));
      request.once("error", reject);
      try {
        for (const part of prefix) request.write(part);
        const stream = fs.createReadStream(file.path);
        stream.once("error", (error) => request.destroy(error));
        stream.once("end", () => request.end(suffix));
        stream.pipe(request, { end: false });
      } catch (error) {
        request.destroy(error as Error);
      }
    });
  }

  private collectResponse(response: import("node:http").IncomingMessage, resolve: (value: unknown) => void, reject: (reason?: unknown) => void): void {
    let raw = "";
    response.setEncoding?.("utf8");
    response.on("data", (chunk: string) => {
      raw += chunk;
      if (raw.length > 8 * 1024 * 1024) response.destroy(new Error("Telegram response too large"));
    });
    response.once("error", reject);
    response.once("end", () => {
      try {
        resolve(parseTelegramJson(raw));
      } catch (error) {
        reject(error);
      }
    });
  }

  async getMe(): Promise<TelegramUser> {
    return this.request<TelegramUser>("getMe");
  }

  async deleteWebhook(): Promise<void> {
    await this.request("deleteWebhook", { drop_pending_updates: false });
  }

  async logOut(): Promise<void> {
    await this.request("logOut");
  }

  async getUpdates(offset?: string): Promise<TelegramUpdate[]> {
    const updates = await this.request<TelegramUpdate[]>("getUpdates", {
      offset,
      timeout: 0,
      allowed_updates: ["message", "channel_post", "my_chat_member"],
    });
    if (!Array.isArray(updates)) throw new Error("Telegram 返回的 updates 不是数组");
    return updates.map((update) => {
      const value = String((update as { update_id?: unknown }).update_id ?? "");
      if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error("Telegram update_id 无效");
      return { ...update, update_id: value };
    });
  }

  async getChat(chatId: string): Promise<TelegramChat> {
    return this.request<TelegramChat>("getChat", { chat_id: chatId });
  }

  async sendMessage(chatId: string, text: string, signal?: AbortSignal): Promise<TelegramMessageResult> {
    return this.request<TelegramMessageResult>("sendMessage", { chat_id: chatId, text }, signal);
  }

  async sendFile(
    chatId: string,
    filePath: string,
    mediaKind: "video" | "audio" | "document",
    caption: string,
    signal?: AbortSignal,
    videoMetadata?: TelegramVideoMetadata,
  ): Promise<TelegramMessageResult> {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error("文件不是普通文件");
    if (stat.size > this.maxUploadBytes) {
      const limit = this.useLocalFileUris ? "2 GB" : "Telegram 云端接口 50 MB";
      throw new TelegramApiError(413, `文件超过 ${limit} 上限`);
    }
    const field = mediaKind === "video" ? "video" : mediaKind === "audio" ? "audio" : "document";
    const method = mediaKind === "video" ? "sendVideo" : mediaKind === "audio" ? "sendAudio" : "sendDocument";
    const contentType = mediaKind === "video" ? "video/mp4" : mediaKind === "audio" ? "audio/mpeg" : "application/octet-stream";
    const safeCaption = String(caption || "").slice(0, 900);
    const params: Record<string, unknown> = { chat_id: chatId, caption: safeCaption };
    if (mediaKind === "video") {
      params.supports_streaming = true;
      if (videoMetadata) {
        const { width, height, durationSeconds } = videoMetadata;
        if (
          !Number.isSafeInteger(width)
          || width < 1
          || !Number.isSafeInteger(height)
          || height < 1
          || !Number.isSafeInteger(durationSeconds)
          || durationSeconds < 1
        ) {
          throw new Error("视频尺寸或时长无效");
        }
        params.width = width;
        params.height = height;
        params.duration = durationSeconds;
      }
    }
    if (this.useLocalFileUris) {
      const fileUri = pathToFileURL(path.resolve(filePath)).href;
      return this.request<TelegramMessageResult>(method, { ...params, [field]: fileUri }, signal);
    }
    const envelope = await this.requestHttp(method, params, { field, path: filePath, contentType }, signal);
    return this.unwrap<TelegramMessageResult>(method, envelope);
  }
}
