/** 本机 HTTP 桥：供 Chrome 扩展可靠入队（仅绑定 127.0.0.1）。 */

import * as http from "node:http";
import { createHash } from "node:crypto";

const DEFAULT_BRIDGE_PORT = 17888;

export function resolveBridgePort(
  env: Record<string, string | undefined>,
): number {
  const raw = (env.DOWNANY_BRIDGE_PORT || "").trim();
  if (!raw) return DEFAULT_BRIDGE_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("DOWNANY_BRIDGE_PORT must be an integer from 0 to 65535");
  }
  return port;
}

export const BRIDGE_PORT = resolveBridgePort(process.env);
export const BRIDGE_HOST = "127.0.0.1";

/** 单次 /tasks 查询最多接受的 ids 数量。 */
export const BRIDGE_TASKS_MAX_IDS = 50;

export type BridgeEnqueueResult = {
  ok: boolean;
  error?: string;
  count?: number;
  taskIds?: string[];
};

export type BridgeEnqueueItem = {
  url: string;
  route?: "media" | "page";
  title?: string;
  media_title_verified?: boolean;
  headers?: Record<string, string>;
  quality?: string;
  audio_only?: boolean;
  download_subtitles?: boolean;
  pageUrl?: string;
  thumbnail_url?: string;
};

export type BridgeTaskStatus = {
  id: string;
  status: string;
  progress: number;
  title: string;
  error: string;
};

export type BridgeHandlers = {
  enqueue: (items: BridgeEnqueueItem[]) => Promise<BridgeEnqueueResult>;
  /** 可选：健康检查附带 Sidecar 是否可入队 */
  getStatus?: () => { sidecarReady: boolean };
  /** 可选：按 taskId 批量查询状态（扩展轮询） */
  getTasks?: (ids: string[]) => BridgeTaskStatus[];
  retryTask?: (id: string) => Promise<BridgeEnqueueResult>;
  focusTask?: (id: string) => Promise<BridgeEnqueueResult>;
};

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(raw),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(raw);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function normalizeHeaders(
  value: unknown,
): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof k === "string" && k && typeof v === "string" && v) {
      out[k] = v;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function pushItem(
  items: BridgeEnqueueItem[],
  seen: Set<string>,
  url: string,
  title?: string,
  headers?: Record<string, string>,
  extras?: { pageUrl?: string; thumbnail_url?: string; route?: "media" | "page"; media_title_verified?: boolean; quality?: string; audio_only?: boolean },
): void {
  const trimmed = url.trim();
  const key = JSON.stringify([trimmed,extras?.route,extras?.quality || "best",extras?.audio_only === true]);
  if (!trimmed || seen.has(key)) return;
  seen.add(key);
  const item: BridgeEnqueueItem = { url: trimmed };
  if (extras?.route) item.route = extras.route;
  if (extras?.quality) item.quality = extras.quality;
  if (extras?.audio_only !== undefined) item.audio_only = extras.audio_only;
  if (extras?.media_title_verified === true) item.media_title_verified = true;
  if (title && title.trim()) item.title = title.trim();
  if (headers) item.headers = headers;
  if (extras?.pageUrl && extras.pageUrl.trim()) {
    item.pageUrl = extras.pageUrl.trim();
  }
  if (extras?.thumbnail_url && extras.thumbnail_url.trim()) {
    item.thumbnail_url = extras.thumbnail_url.trim();
  }
  items.push(item);
}

/** 从 POST JSON 解析入队 items（兼容旧 url / urls）。 */
export function parseEnqueueBody(raw: string): BridgeEnqueueItem[] {
  let data: unknown;
  try {
    data = JSON.parse(raw || "{}");
  } catch {
    return [];
  }
  if (!data || typeof data !== "object") return [];
  const obj = data as Record<string, unknown>;
  const items: BridgeEnqueueItem[] = [];
  const seen = new Set<string>();

  if (Array.isArray(obj.items)) {
    for (const entry of obj.items) {
      if (typeof entry === "string") {
        pushItem(items, seen, entry);
        continue;
      }
      if (!entry || typeof entry !== "object") continue;
      const rec = entry as Record<string, unknown>;
      if (typeof rec.url !== "string") continue;
      pushItem(
        items,
        seen,
        rec.url,
        typeof rec.title === "string" ? rec.title : undefined,
        normalizeHeaders(rec.headers),
        {
          route: rec.route === "media" || rec.route === "page" ? rec.route : undefined,
          media_title_verified: rec.media_title_verified === true,
          quality: ["best","1080p","720p"].includes(String(rec.quality)) ? String(rec.quality) : undefined,
          audio_only: typeof rec.audio_only === "boolean" ? rec.audio_only : undefined,
          pageUrl:
            typeof rec.pageUrl === "string"
              ? rec.pageUrl
              : typeof rec.page_url === "string"
                ? rec.page_url
                : undefined,
          thumbnail_url:
            typeof rec.thumbnail_url === "string"
              ? rec.thumbnail_url
              : typeof rec.thumbnailUrl === "string"
                ? rec.thumbnailUrl
                : undefined,
        },
      );
    }
  }

  if (typeof obj.url === "string" && obj.url.trim()) {
    pushItem(items, seen, obj.url);
  }
  if (Array.isArray(obj.urls)) {
    for (const entry of obj.urls) {
      if (typeof entry === "string") pushItem(items, seen, entry);
    }
  }

  return items;
}

/** 从 query `ids=a,b,c` 解析去重后的 id 列表（上限 BRIDGE_TASKS_MAX_IDS）。 */
export function parseTaskIdsQuery(raw: string | null): string[] {
  if (!raw || !raw.trim()) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const id = part.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= BRIDGE_TASKS_MAX_IDS) break;
  }
  return out;
}

export function startBridgeServer(
  handlers: BridgeHandlers,
  port = BRIDGE_PORT,
): http.Server {
  const receipts = new Map<string, { fingerprint: string; result: Promise<BridgeEnqueueResult> }>();
  const server = http.createServer((req, res) => {
    void (async () => {
      const method = req.method || "GET";
      const url = new URL(req.url || "/", `http://${BRIDGE_HOST}:${port}`);

      if (method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        });
        res.end();
        return;
      }

      if (method === "GET" && url.pathname === "/health") {
        const status = handlers.getStatus?.();
        sendJson(res, 200, {
          ok: true,
          service: "downany-bridge",
          sidecarReady: status ? status.sidecarReady : true,
          capabilities: ["explicit-routes", "enqueue-receipts", "task-retry", "task-focus"],
        });
        return;
      }

      if (method === "GET" && url.pathname === "/tasks") {
        const ids = parseTaskIdsQuery(url.searchParams.get("ids"));
        if (ids.length === 0) {
          sendJson(res, 400, { ok: false, error: "缺少 ids" });
          return;
        }
        if (!handlers.getTasks) {
          sendJson(res, 501, { ok: false, error: "任务查询未启用" });
          return;
        }
        const tasks = handlers.getTasks(ids);
        sendJson(res, 200, { ok: true, tasks });
        return;
      }

      if (method === "POST" && url.pathname === "/enqueue") {
        const raw = await readBody(req);
        const items = parseEnqueueBody(raw);
        if (items.length === 0) {
          sendJson(res, 400, { ok: false, error: "缺少 url / urls / items" });
          return;
        }
        const input = JSON.parse(raw) as { requestId?: unknown };
        const requestId = typeof input.requestId === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(input.requestId) ? input.requestId : "";
        const fingerprint = createHash("sha256").update(JSON.stringify(items.map(item => [item.url, item.route]))).digest("hex");
        const existing = requestId ? receipts.get(requestId) : undefined;
        if (existing && existing.fingerprint !== fingerprint) {
          sendJson(res, 409, { ok: false, error: "发送标识与媒体不一致" }); return;
        }
        if (!existing && requestId && receipts.size >= 500) {
          sendJson(res, 429, { ok: false, error: "发送回执已满，请稍后重试" }); return;
        }
        const operation = existing?.result || handlers.enqueue(items);
        if (requestId && !existing) receipts.set(requestId, { fingerprint, result: operation });
        let result: BridgeEnqueueResult;
        try { result = await operation; } catch (error) { if(requestId) receipts.delete(requestId); throw error; }
        if (!result.ok && requestId) receipts.delete(requestId);
        sendJson(res, result.ok ? 200 : 502, result as unknown as Record<string, unknown>);
        return;
      }

      if (method === "POST" && ["/task/retry", "/task/focus"].includes(url.pathname)) {
        const origin = String(req.headers.origin || "");
        if (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) {
          sendJson(res, 403, { ok: false, error: "仅允许本机扩展操作任务" }); return;
        }
        const input = JSON.parse(await readBody(req)) as { taskId?: unknown };
        const taskId = typeof input.taskId === "string" ? input.taskId : "";
        if (!/^[a-zA-Z0-9_-]{1,100}$/.test(taskId)) { sendJson(res, 400, { ok: false, error: "无效任务标识" }); return; }
        const handler = url.pathname === "/task/retry" ? handlers.retryTask : handlers.focusTask;
        if (!handler) { sendJson(res, 501, { ok: false, error: "请更新百纳桌面端" }); return; }
        const result = await handler(taskId);
        sendJson(res, result.ok ? 200 : 409, result as unknown as Record<string, unknown>); return;
      }
      sendJson(res, 404, { ok: false, error: "not found" });
    })().catch((err) => {
      sendJson(res, 500, { ok: false, error: String(err) });
    });
  });

  server.listen(port, BRIDGE_HOST);
  return server;
}
