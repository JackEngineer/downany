import * as fs from "node:fs/promises";
import * as path from "node:path";

export type { TelegramAppCredentials } from "./appCredentials";
import type { TelegramAppCredentials } from "./appCredentials";

export interface TelegramRuntimePaths {
  executable: string;
  processHostExecutable: string;
  rootDir: string;
  workDir: string;
  tempDir: string;
  credentialFile: string;
  appCredentialsFile: string;
  ownerStateFile: string;
  sidecarOwnerStateFile: string;
}

export type TelegramPrivateDataPaths = Pick<
  TelegramRuntimePaths,
  "rootDir" | "workDir" | "tempDir" | "credentialFile" | "ownerStateFile" | "sidecarOwnerStateFile"
>;

export type SidecarRecoveryPrivatePaths = Pick<TelegramRuntimePaths, "rootDir" | "sidecarOwnerStateFile">;

function pathForPlatform(platform: "darwin" | "win32"): typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

export function selectTelegramPrivateDataPaths(paths: TelegramRuntimePaths): TelegramPrivateDataPaths {
  return {
    rootDir: paths.rootDir,
    workDir: paths.workDir,
    tempDir: paths.tempDir,
    credentialFile: paths.credentialFile,
    ownerStateFile: paths.ownerStateFile,
    sidecarOwnerStateFile: paths.sidecarOwnerStateFile,
  };
}

export function selectSidecarRecoveryPrivatePaths(paths: TelegramRuntimePaths): SidecarRecoveryPrivatePaths {
  return { rootDir: paths.rootDir, sidecarOwnerStateFile: paths.sidecarOwnerStateFile };
}

function executableName(platform: "darwin" | "win32"): string {
  return platform === "win32" ? "telegram-bot-api.exe" : "telegram-bot-api";
}

function processHostName(platform: "darwin" | "win32"): string {
  return platform === "win32" ? "DownanyProcessHost.exe" : "DownanyProcessHost";
}

export function resolveTelegramBotApiPaths(input: {
  platform: "darwin" | "win32";
  isPackaged: boolean;
  resourcesPath: string;
  downanyDataDir: string;
  env: NodeJS.ProcessEnv;
}): TelegramRuntimePaths {
  const pathModule = pathForPlatform(input.platform);
  const resourceBotApi = pathModule.join(input.resourcesPath, "telegram-bot-api", executableName(input.platform));
  const executable = !input.isPackaged && input.env.DOWNANY_TELEGRAM_BOT_API_BIN
    ? pathModule.resolve(input.env.DOWNANY_TELEGRAM_BOT_API_BIN)
    : resourceBotApi;
  const rootDir = pathModule.join(pathModule.resolve(input.downanyDataDir), "telegram");
  return {
    executable,
    processHostExecutable: pathModule.join(input.resourcesPath, "process-host", processHostName(input.platform)),
    rootDir,
    workDir: pathModule.join(rootDir, "bot-api"),
    tempDir: pathModule.join(rootDir, "temp"),
    credentialFile: pathModule.join(rootDir, "bot-token.v1"),
    appCredentialsFile: pathModule.join(input.resourcesPath, "telegram-bot-api", "app-credentials.json"),
    ownerStateFile: pathModule.join(rootDir, "owner-state.json"),
    sidecarOwnerStateFile: pathModule.join(rootDir, "sidecar-owner-state.json"),
  };
}

export interface TelegramPathSecurityDeps {
  platform: "darwin" | "win32";
  currentUserSid: string | null;
  inspectPath(path: string): Promise<{
    exists: boolean;
    kind: "directory" | "file" | "other";
    isLinkOrReparsePoint: boolean;
    posixMode: number | null;
  }>;
  createDirectory(path: string, mode: 0o700): Promise<void>;
  createFile?: (path: string, mode: 0o600) => Promise<void>;
  chmod(path: string, mode: 0o700 | 0o600): Promise<void>;
  applyWindowsAcl(path: string, kind: "directory" | "file", currentUserSid: string): Promise<void>;
  inspectWindowsAcl(path: string): Promise<{
    inheritanceDisabled: boolean;
    allowSids: string[];
    fullControlSids: string[];
  }>;
}

function canonicalInside(child: string, parent: string, platform: "darwin" | "win32"): boolean {
  const pathModule = pathForPlatform(platform);
  const relative = pathModule.relative(pathModule.resolve(parent), pathModule.resolve(child));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${pathModule.sep}`) && !pathModule.isAbsolute(relative));
}

async function inspectPrivateComponent(component: string, kind: "directory" | "file", deps: TelegramPathSecurityDeps): Promise<void> {
  let info = await deps.inspectPath(component);
  if (!info.exists) {
    if (kind === "directory") await deps.createDirectory(component, 0o700);
    else if (deps.createFile) await deps.createFile(component, 0o600);
    else return;
    info = await deps.inspectPath(component);
    if (!info.exists) throw new Error(`Telegram 私有路径创建失败：${component}`);
  }
  if (info.kind !== kind || info.isLinkOrReparsePoint) throw new Error(`Telegram 私有路径不安全：${component}`);
  if (deps.platform === "darwin") {
    const expected = kind === "directory" ? 0o700 : 0o600;
    if (info.posixMode !== null && (info.posixMode & 0o777) !== expected) await deps.chmod(component, expected);
    const after = await deps.inspectPath(component);
    if (after.isLinkOrReparsePoint || (after.posixMode !== null && (after.posixMode & 0o777) !== expected)) {
      throw new Error(`Telegram 私有权限校验失败：${component}`);
    }
  } else {
    if (!deps.currentUserSid) throw new Error("无法确认当前 Windows 用户 SID");
    await deps.applyWindowsAcl(component, kind, deps.currentUserSid);
    const acl = await deps.inspectWindowsAcl(component);
    const allowed = new Set([deps.currentUserSid, "S-1-5-18"]);
    if (!acl.inheritanceDisabled || acl.allowSids.length === 0 || acl.fullControlSids.length === 0 || acl.allowSids.some((sid) => !allowed.has(sid)) || acl.fullControlSids.some((sid) => !allowed.has(sid))) {
      throw new Error(`Telegram Windows 私有 ACL 校验失败：${component}`);
    }
  }
}

export async function ensurePrivateTelegramPaths(paths: TelegramPrivateDataPaths, deps: TelegramPathSecurityDeps): Promise<void> {
  const pathModule = pathForPlatform(deps.platform);
  const root = pathModule.resolve(paths.rootDir);
  for (const value of [paths.workDir, paths.tempDir, paths.credentialFile, paths.ownerStateFile, paths.sidecarOwnerStateFile]) {
    if (!canonicalInside(value, root, deps.platform)) throw new Error("Telegram 私有路径越界");
  }
  await inspectPrivateComponent(root, "directory", deps);
  await inspectPrivateComponent(paths.workDir, "directory", deps);
  await inspectPrivateComponent(paths.tempDir, "directory", deps);
  await inspectPrivateComponent(paths.credentialFile, "file", deps);
  await inspectPrivateComponent(paths.ownerStateFile, "file", deps);
  await inspectPrivateComponent(paths.sidecarOwnerStateFile, "file", deps);
}

export async function ensurePrivateSidecarRecoveryPaths(paths: SidecarRecoveryPrivatePaths, deps: TelegramPathSecurityDeps): Promise<void> {
  const pathModule = pathForPlatform(deps.platform);
  const root = pathModule.resolve(paths.rootDir);
  if (!canonicalInside(paths.sidecarOwnerStateFile, root, deps.platform)) throw new Error("Sidecar 恢复路径越界");
  await inspectPrivateComponent(root, "directory", deps);
  await inspectPrivateComponent(paths.sidecarOwnerStateFile, "file", deps);
}

async function ensureResourceFile(filePath: string, root: string, deps: TelegramPathSecurityDeps): Promise<void> {
  const pathModule = pathForPlatform(deps.platform);
  if (!pathModule.isAbsolute(filePath) || !canonicalInside(filePath, root, deps.platform)) throw new Error(`Telegram 资源路径越界：${filePath}`);
  const info = await deps.inspectPath(filePath);
  if (!info.exists || info.kind !== "file" || info.isLinkOrReparsePoint) throw new Error(`Telegram 资源不可执行：${filePath}`);
}

export async function ensureProcessHostResourceInput(input: { processHostExecutable: string; isPackaged: boolean; resourcesPath: string }, deps: TelegramPathSecurityDeps): Promise<void> {
  await ensureResourceFile(input.processHostExecutable, pathForPlatform(deps.platform).join(input.resourcesPath, "process-host"), deps);
}

export async function ensureTelegramResourceInputs(input: { executable: string; appCredentialsFile: string; isPackaged: boolean; resourcesPath: string; envOverrideExecutable: string | null; hasDevelopmentCredentials?: boolean }, deps: TelegramPathSecurityDeps): Promise<void> {
  const pathModule = pathForPlatform(deps.platform);
  if (input.envOverrideExecutable) {
    if (input.isPackaged || !pathModule.isAbsolute(input.executable)) throw new Error("Telegram Bot API 开发覆盖必须是绝对路径");
    const info = await deps.inspectPath(input.executable);
    if (!info.exists || info.kind !== "file" || info.isLinkOrReparsePoint) throw new Error("Telegram Bot API 开发覆盖不是安全文件");
  } else {
    await ensureResourceFile(input.executable, pathForPlatform(deps.platform).join(input.resourcesPath, "telegram-bot-api"), deps);
  }
  if (input.isPackaged || !input.hasDevelopmentCredentials) {
    await ensureResourceFile(input.appCredentialsFile, pathForPlatform(deps.platform).join(input.resourcesPath, "telegram-bot-api"), deps);
  }
}

export async function ensurePrivateTelegramFile(filePath: string, privateRootDir: string, deps: TelegramPathSecurityDeps): Promise<void> {
  if (!canonicalInside(filePath, privateRootDir, deps.platform)) throw new Error("Telegram 私有文件路径越界");
  await inspectPrivateComponent(privateRootDir, "directory", deps);
  await inspectPrivateComponent(filePath, "file", deps);
}

export function buildTelegramBotApiChildEnv(baseEnv: NodeJS.ProcessEnv, appCredentials: TelegramAppCredentials): NodeJS.ProcessEnv {
  const allowed = new Set(["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE"]);
  const result: NodeJS.ProcessEnv = {};
  for (const canonical of allowed) {
    const exact = baseEnv[canonical];
    const entry = exact !== undefined
      ? exact
      : Object.entries(baseEnv).find(([key]) => key.toLowerCase() === canonical.toLowerCase())?.[1];
    if (entry !== undefined) result[canonical] = entry;
  }
  result.TELEGRAM_API_ID = appCredentials.apiId;
  result.TELEGRAM_API_HASH = appCredentials.apiHash;
  return result;
}

export function buildSidecarChildEnv(baseEnv: NodeJS.ProcessEnv, runtime: { dataDir: string; binDir: string; noProxy: string }): NodeJS.ProcessEnv {
  const result = buildTelegramBotApiChildEnv(baseEnv, { apiId: "0", apiHash: "00000000000000000000000000000000" });
  delete result.TELEGRAM_API_ID;
  delete result.TELEGRAM_API_HASH;
  result.DOWNANY_DATA_DIR = runtime.dataDir;
  result.DOWNANY_BIN_DIR = runtime.binDir;
  result.NO_PROXY = runtime.noProxy;
  result.PYTHONUNBUFFERED = "1";
  return result;
}

// Keep the fs import intentionally used by consumers that want a production adapter
// without making path resolution itself perform filesystem I/O.
export const telegramPathFs = fs;
