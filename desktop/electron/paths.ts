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

export function platformExecutable(baseName: string): string[] {
  if (process.platform === "win32") {
    return [`${baseName}.exe`, baseName];
  }
  return [baseName, `${baseName}.exe`];
}

export function defaultDevPython(repoRoot: string): string {
  if (process.platform === "win32") {
    return path.join(repoRoot, "venv", "Scripts", "python.exe");
  }
  return path.join(repoRoot, "venv", "bin", "python");
}

export function bundledSidecarPath(fromDir: string): string {
  const root = path.join(resourcesRoot(fromDir), "sidecar");
  const onedirDir = path.join(root, "DownanySidecar");

  // onedir（推荐）：sidecar/DownanySidecar/{DownanySidecar[.exe]}
  for (const name of platformExecutable("DownanySidecar")) {
    const candidate = path.join(onedirDir, name);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // onefile 兼容：sidecar/{DownanySidecar[.exe]}
  for (const name of platformExecutable("DownanySidecar")) {
    const candidate = path.join(root, name);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return path.join(onedirDir, platformExecutable("DownanySidecar")[0]);
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

  const legacyBin = process.env.VIDEODL_BIN_DIR;
  const legacyData = process.env.VIDEODL_DATA_DIR;
  const legacyPython = process.env.VIDEODL_PYTHON;
  if (!process.env.DOWNANY_BIN_DIR && legacyBin) {
    env.DOWNANY_BIN_DIR = legacyBin;
  }
  if (!process.env.DOWNANY_DATA_DIR && legacyData) {
    env.DOWNANY_DATA_DIR = legacyData;
  }
  if (!process.env.DOWNANY_PYTHON && legacyPython) {
    env.DOWNANY_PYTHON = legacyPython;
  }

  if (fs.existsSync(binDir)) {
    env.DOWNANY_BIN_DIR = binDir;
  }
  if (opts.dataDir) {
    env.DOWNANY_DATA_DIR = opts.dataDir;
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
    process.env.DOWNANY_PYTHON ||
    process.env.VIDEODL_PYTHON ||
    defaultDevPython(repoRoot);
  const devBin = path.join(repoRoot, "bin");
  if (!env.DOWNANY_BIN_DIR && fs.existsSync(devBin)) {
    env.DOWNANY_BIN_DIR = devBin;
  }
  return {
    command: python,
    args: ["-m", "src.sidecar"],
    cwd: repoRoot,
    env,
  };
}
