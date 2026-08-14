import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { resourcesRoot } from "../paths";
import { resolveTelegramBotApiPaths } from "./paths";
import { loadTelegramAppCredentials } from "./appCredentials";
import { createFileProcessOwnerStateStore } from "./ownerStore";
import { createTelegramProcessHostAdapter } from "./processHostAdapter";
import { createNodeTelegramPathSecurity } from "./runtimeSecurity";
import { verifyPackagedTelegramResources } from "./resourceManifest";
import { TelegramBotApiSupervisor } from "./supervisor";

export async function createOptionalTelegramSupervisor(input: {
  fromDir: string;
  isPackaged: boolean;
  platform: NodeJS.Platform;
  resourcesPath?: string;
  dataDir: string;
  env: NodeJS.ProcessEnv;
  log?: (level: "info" | "warn" | "error", message: string) => void;
}): Promise<TelegramBotApiSupervisor | null> {
  if (input.platform !== "darwin" && input.platform !== "win32") return null;
  const resources = input.resourcesPath || resourcesRoot(input.fromDir);
  const paths = resolveTelegramBotApiPaths({
    platform: input.platform,
    isPackaged: input.isPackaged,
    resourcesPath: resources,
    downanyDataDir: input.dataDir,
    env: input.env,
  });
  const required = input.isPackaged
    ? [paths.executable, paths.processHostExecutable, paths.appCredentialsFile]
    : [paths.executable, paths.processHostExecutable];
  const present = await Promise.all(required.map(async (value) => {
    try {
      const stat = await fs.stat(value);
      return stat.isFile();
    } catch {
      return false;
    }
  }));
  if (!present.some(Boolean)) return null;
  if (!present.every(Boolean)) {
    throw new Error("Telegram 本地模式资源不完整，已拒绝回退到未受控本地进程");
  }

  const appCredentials = await loadTelegramAppCredentials({
    isPackaged: input.isPackaged,
    appCredentialsFile: paths.appCredentialsFile,
    env: input.env,
  });
  const pathSecurity = await createNodeTelegramPathSecurity(input.platform);
  const verifyPackagedResources = input.isPackaged
    ? async (): Promise<void> => verifyPackagedTelegramResources({
      resourcesRoot: resources,
      platform: input.platform === "win32" ? "win32-x64" : "darwin-arm64",
      telegramExecutable: paths.executable,
      telegramManifest: path.join(resources, "telegram-bot-api", "manifest.json"),
      processHostExecutable: paths.processHostExecutable,
      processHostManifest: path.join(resources, "process-host", "process-host-manifest.json"),
      pathSecurity,
    })
    : undefined;
  const adapter = createTelegramProcessHostAdapter({
    platform: input.platform,
    log: input.log,
  });
  return new TelegramBotApiSupervisor({
    paths,
    appCredentials,
    baseEnv: input.env,
    isPackaged: input.isPackaged,
    envOverrideExecutable: input.isPackaged ? null : (input.env.DOWNANY_TELEGRAM_BOT_API_BIN || null),
    ...adapter,
    ownerStore: createFileProcessOwnerStateStore(paths.ownerStateFile),
    pathSecurity,
    verifyPackagedResources,
    nowIso: () => new Date().toISOString(),
    sleep: async (ms, signal) => {
      if (signal.aborted) throw new Error("操作已取消");
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        const onAbort = (): void => {
          clearTimeout(timer);
          reject(new Error("操作已取消"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      });
    },
    randomId: randomUUID,
    log: input.log || (() => undefined),
  });
}
