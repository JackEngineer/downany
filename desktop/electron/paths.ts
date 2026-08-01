/** 开发态 / 打包态资源路径。 */
import { app } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";

export function resolveRepoRoot(fromDir: string): string {
  // dist-electron -> desktop -> repo
  const candidate = path.resolve(fromDir, "..", "..");
  if (fs.existsSync(path.join(candidate, "src", "sidecar"))) {
    return candidate;
  }
  const alt = path.resolve(fromDir, "..");
  if (fs.existsSync(path.join(alt, "src", "sidecar"))) {
    return alt;
  }
  return candidate;
}

export function resourcesRoot(fromDir: string): string {
  if (app.isPackaged) {
    return process.resourcesPath;
  }
  const desktopRoot = path.resolve(fromDir, "..");
  return path.join(desktopRoot, "resources");
}

export function bundledBinDir(fromDir: string): string {
  return path.join(resourcesRoot(fromDir), "bin");
}

export function bundledSidecarPath(fromDir: string): string {
  const root = path.join(resourcesRoot(fromDir), "sidecar");
  // onedir（推荐）：sidecar/VideoDownloaderSidecar/VideoDownloaderSidecar
  const onedir = path.join(root, "VideoDownloaderSidecar", "VideoDownloaderSidecar");
  if (fs.existsSync(onedir)) {
    return onedir;
  }
  // onefile 兼容：sidecar/VideoDownloaderSidecar
  return path.join(root, "VideoDownloaderSidecar");
}


export interface SidecarLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export function resolveSidecarLaunch(
  fromDir: string,
  opts: { pythonPath?: string; dataDir?: string; repoRoot?: string } = {},
): SidecarLaunch {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const binDir = bundledBinDir(fromDir);

  if (fs.existsSync(binDir)) {
    env.VIDEODL_BIN_DIR = binDir;
  }
  if (opts.dataDir) {
    env.VIDEODL_DATA_DIR = opts.dataDir;
  }

  if (app.isPackaged) {
    return {
      command: bundledSidecarPath(fromDir),
      args: [],
      cwd: process.resourcesPath,
      env,
    };
  }

  const repoRoot = opts.repoRoot || resolveRepoRoot(fromDir);
  const python =
    opts.pythonPath ||
    process.env.VIDEODL_PYTHON ||
    path.join(repoRoot, "venv", "bin", "python");
  const devBin = path.join(repoRoot, "bin");
  if (!env.VIDEODL_BIN_DIR && fs.existsSync(devBin)) {
    env.VIDEODL_BIN_DIR = devBin;
  }
  return {
    command: python,
    args: ["-m", "src.sidecar"],
    cwd: repoRoot,
    env,
  };
}
