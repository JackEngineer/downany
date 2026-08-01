/** 本机 HTTP 桥：供 Chrome 扩展可靠入队（仅绑定 127.0.0.1）。 */

import * as http from "node:http";

export const BRIDGE_PORT = 17888;
export const BRIDGE_HOST = "127.0.0.1";

export type BridgeEnqueueResult = {
  ok: boolean;
  error?: string;
  count?: number;
};

export type BridgeEnqueueItem = {
  url: string;
  title?: string;
  headers?: Record<string, string>;
  quality?: string;
  audio_only?: boolean;
  download_subtitles?: boolean;
};

export type BridgeHandlers = {
  enqueue: (items: BridgeEnqueueItem[]) => Promise<BridgeEnqueueResult>;
  /** 可选：健康检查附带 Sidecar 是否可入队 */
  getStatus?: () => { sidecarReady: boolean };
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
): void {
  const trimmed = url.trim();
  if (!trimmed || seen.has(trimmed)) return;
  seen.add(trimmed);
  const item: BridgeEnqueueItem = { url: trimmed };
  if (title && title.trim()) item.title = title.trim();
  if (headers) item.headers = headers;
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

export function startBridgeServer(handlers: BridgeHandlers): http.Server {
  const server = http.createServer((req, res) => {
    void (async () => {
      const method = req.method || "GET";
      const url = new URL(req.url || "/", `http://${BRIDGE_HOST}:${BRIDGE_PORT}`);

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
        });
        return;
      }

      if (method === "POST" && url.pathname === "/enqueue") {
        const raw = await readBody(req);
        const items = parseEnqueueBody(raw);
        if (items.length === 0) {
          sendJson(res, 400, { ok: false, error: "缺少 url / urls / items" });
          return;
        }
        const result = await handlers.enqueue(items);
        sendJson(res, result.ok ? 200 : 502, result as unknown as Record<string, unknown>);
        return;
      }

      sendJson(res, 404, { ok: false, error: "not found" });
    })().catch((err) => {
      sendJson(res, 500, { ok: false, error: String(err) });
    });
  });

  server.listen(BRIDGE_PORT, BRIDGE_HOST);
  return server;
}
