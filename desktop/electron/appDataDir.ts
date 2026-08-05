import * as path from "node:path";

export function resolveDownanyDataDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string,
): string {
  const override = (env.DOWNANY_DATA_DIR || env.VIDEODL_DATA_DIR || "").trim();
  if (override) return path.resolve(override);
  if (platform === "win32") {
    const local = (env.LOCALAPPDATA || "").trim();
    const base = local || path.join(home, "AppData", "Local");
    return path.join(base, "Downany");
  }
  return path.join(home, "Library", "Application Support", "Downany");
}

export function resolveDownanyLogDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string,
): string {
  const data = resolveDownanyDataDir(env, platform, home);
  const override = (env.DOWNANY_DATA_DIR || env.VIDEODL_DATA_DIR || "").trim();
  if (override || platform === "win32") {
    return path.join(data, "logs");
  }
  return path.join(home, "Library", "Logs", "Downany");
}
