import * as fs from "node:fs/promises";

export interface TelegramAppCredentials {
  apiId: string;
  apiHash: string;
}

const API_ID = /^[1-9][0-9]*$/;
const API_HASH = /^[0-9a-f]{32}$/i;

function invalid(message: string): Error {
  return new Error(`Telegram 应用凭据无效：${message}`);
}

function parseCredentials(value: unknown): TelegramAppCredentials {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("配置必须是对象");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) throw invalid("schemaVersion 必须为 1");
  if (typeof record.apiId !== "string" || !API_ID.test(record.apiId)) {
    throw invalid("缺少有效的 apiId");
  }
  if (typeof record.apiHash !== "string" || !API_HASH.test(record.apiHash)) {
    throw invalid("缺少有效的 apiHash");
  }
  if (Object.keys(record).some((key) => !["schemaVersion", "apiId", "apiHash"].includes(key))) {
    throw invalid("包含未知字段");
  }
  return { apiId: record.apiId, apiHash: record.apiHash };
}

export async function loadTelegramAppCredentials(input: {
  isPackaged: boolean;
  appCredentialsFile: string;
  env: NodeJS.ProcessEnv;
}): Promise<TelegramAppCredentials> {
  if (!input.isPackaged) {
    const apiId = (input.env.DOWNANY_TELEGRAM_API_ID || "").trim();
    const apiHash = (input.env.DOWNANY_TELEGRAM_API_HASH || "").trim();
    if (!apiId) throw invalid("缺少 apiId");
    if (!apiHash) throw invalid("缺少 apiHash");
    if (!API_ID.test(apiId)) throw invalid("开发环境 apiId 无效");
    if (!API_HASH.test(apiHash)) throw invalid("开发环境 apiHash 无效");
    return { apiId, apiHash };
  }

  let raw: string;
  try {
    raw = await fs.readFile(input.appCredentialsFile, "utf8");
  } catch {
    throw invalid("找不到打包凭据文件");
  }
  try {
    return parseCredentials(JSON.parse(raw));
  } catch (error) {
    if (error instanceof SyntaxError) throw invalid("凭据文件不是有效 JSON");
    throw error;
  }
}
