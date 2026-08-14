import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { TelegramPathSecurityDeps } from "./paths";

export type PackagedPlatform = "win32-x64" | "darwin-arm64";

export interface PackagedTelegramResourceInput {
  resourcesRoot: string;
  platform: PackagedPlatform;
  telegramExecutable: string;
  telegramManifest: string;
  processHostExecutable: string;
  processHostManifest: string;
  pathSecurity: TelegramPathSecurityDeps;
}

function isContained(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function requireRegularResource(filePath: string, root: string, security: TelegramPathSecurityDeps): Promise<void> {
  if (!path.isAbsolute(filePath) || !isContained(filePath, root)) {
    throw new Error("packaged Telegram resource path escapes its resource directory");
  }
  const info = await security.inspectPath(filePath);
  if (!info.exists || info.kind !== "file" || info.isLinkOrReparsePoint) {
    throw new Error("packaged Telegram resource must be a regular non-link file");
  }
}

function parseManifest(raw: string, expected: {
  platform: PackagedPlatform;
  executable: string;
  sizeField: "size" | "bytes";
  kind: "telegram" | "process-host";
}): { sha256: string; bytes: number } {
  if (raw.charCodeAt(0) === 0xfeff || raw.includes("\r") || !raw.endsWith("\n") || raw.slice(0, -1).includes("\n")) {
    throw new Error("packaged Telegram manifest must be one-line UTF-8 LF JSON");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("packaged Telegram manifest is invalid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("packaged Telegram manifest must be an object");
  }
  const record = value as Record<string, unknown>;
  const requiredKeys = expected.kind === "telegram"
    ? ["schemaVersion", "platform", "sourceCommit", "executable", "size", "sha256"]
    : ["schemaVersion", "platform", "sourceDisposition", "executable", "sha256", "bytes"];
  const keys = Object.keys(record).sort();
  if (keys.join("\0") !== [...requiredKeys].sort().join("\0")) {
    throw new Error("packaged Telegram manifest fields do not match the fixed schema");
  }
  if (record.schemaVersion !== 1 || record.platform !== expected.platform || record.executable !== expected.executable) {
    throw new Error("packaged Telegram manifest platform or executable does not match");
  }
  if (expected.kind === "telegram" && (typeof record.sourceCommit !== "string" || !/^[0-9a-f]{40}$/.test(record.sourceCommit))) {
    throw new Error("Telegram Bot API manifest sourceCommit is invalid");
  }
  if (expected.kind === "process-host" && record.sourceDisposition !== "project_source") {
    throw new Error("ProcessHost manifest sourceDisposition is invalid");
  }
  if (typeof record.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(record.sha256)) {
    throw new Error("packaged Telegram manifest SHA256 is invalid");
  }
  const bytesValue = record[expected.sizeField];
  if (!Number.isSafeInteger(bytesValue) || Number(bytesValue) <= 0) {
    throw new Error("packaged Telegram manifest byte count is invalid");
  }
  if (expected.kind === "process-host" && Number(bytesValue) <= 4096) {
    throw new Error("ProcessHost resource is unexpectedly small");
  }
  return { sha256: record.sha256, bytes: Number(bytesValue) };
}

async function verifyArtifact(input: {
  executable: string;
  manifest: string;
  resourcesRoot: string;
  platform: PackagedPlatform;
  executableName: string;
  sizeField: "size" | "bytes";
  kind: "telegram" | "process-host";
  pathSecurity: TelegramPathSecurityDeps;
}): Promise<void> {
  const root = path.join(input.resourcesRoot, input.kind === "telegram" ? "telegram-bot-api" : "process-host");
  await requireRegularResource(input.executable, root, input.pathSecurity);
  await requireRegularResource(input.manifest, root, input.pathSecurity);
  const manifest = parseManifest(await fs.readFile(input.manifest, "utf8"), {
    platform: input.platform,
    executable: input.executableName,
    sizeField: input.sizeField,
    kind: input.kind,
  });
  const bytes = await fs.readFile(input.executable);
  const actual = {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength,
  };
  if (actual.sha256 !== manifest.sha256 || actual.bytes !== manifest.bytes) {
    throw new Error(`packaged ${input.kind} manifest does not match the executable`);
  }
}

export async function verifyPackagedTelegramResources(input: PackagedTelegramResourceInput): Promise<void> {
  const telegramExecutableName = input.platform === "win32-x64" ? "telegram-bot-api.exe" : "telegram-bot-api";
  const processHostExecutableName = input.platform === "win32-x64" ? "DownanyProcessHost.exe" : "DownanyProcessHost";
  await verifyArtifact({
    executable: input.telegramExecutable,
    manifest: input.telegramManifest,
    resourcesRoot: input.resourcesRoot,
    platform: input.platform,
    executableName: telegramExecutableName,
    sizeField: "size",
    kind: "telegram",
    pathSecurity: input.pathSecurity,
  });
  await verifyArtifact({
    executable: input.processHostExecutable,
    manifest: input.processHostManifest,
    resourcesRoot: input.resourcesRoot,
    platform: input.platform,
    executableName: processHostExecutableName,
    sizeField: "bytes",
    kind: "process-host",
    pathSecurity: input.pathSecurity,
  });
}
