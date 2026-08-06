import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false },
}));

import {
  bundledSidecarPath,
  defaultDevPython,
  platformExecutable,
  resolveRepoRoot,
  resolveSidecarLaunch,
} from "./paths";

describe("platformExecutable", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("returns .exe first on win32", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    expect(platformExecutable("DownanySidecar")).toEqual([
      "DownanySidecar.exe",
      "DownanySidecar",
    ]);
  });

  it("returns base name first on posix", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    expect(platformExecutable("DownanySidecar")).toEqual([
      "DownanySidecar",
      "DownanySidecar.exe",
    ]);
  });
});

describe("defaultDevPython", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("uses Scripts/python.exe on win32", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    expect(defaultDevPython("/repo")).toBe(
      path.join("/repo", "venv", "Scripts", "python.exe"),
    );
  });

  it("uses bin/python on posix", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    expect(defaultDevPython("/repo")).toBe(
      path.join("/repo", "venv", "bin", "python"),
    );
  });
});

describe("packaging paths", () => {
  it("resolves repo root from dist-electron layout", () => {
    const root = resolveRepoRoot(__dirname);
    expect(fs.existsSync(path.join(root, "src", "sidecar"))).toBe(true);
  });

  it("dev launch uses python -m src.sidecar", () => {
    const launch = resolveSidecarLaunch(__dirname, {
      repoRoot: resolveRepoRoot(__dirname),
      pythonPath: "/tmp/fake-python",
    });
    expect(launch.command).toBe("/tmp/fake-python");
    expect(launch.args).toEqual(["-m", "src.sidecar"]);
  });

  it("dev launch uses defaultDevPython when no override", () => {
    const repoRoot = resolveRepoRoot(__dirname);
    const launch = resolveSidecarLaunch(__dirname, { repoRoot });
    expect(launch.command).toBe(defaultDevPython(repoRoot));
  });

  it("dev launch prefers temp Scripts/python.exe on win32", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "downany-paths-"));
    const scriptsDir = path.join(tmp, "venv", "Scripts");
    fs.mkdirSync(scriptsDir, { recursive: true });
    const pythonExe = path.join(scriptsDir, "python.exe");
    fs.writeFileSync(pythonExe, "");

    const launch = resolveSidecarLaunch(__dirname, { repoRoot: tmp });
    expect(launch.command).toBe(pythonExe);

    Object.defineProperty(process, "platform", { value: originalPlatform });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("bundledSidecarPath prefers onedir executable", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "downany-sidecar-"));
    const resources = path.join(tmp, "resources");
    const onedirDir = path.join(resources, "sidecar", "DownanySidecar");
    fs.mkdirSync(onedirDir, { recursive: true });
    const sidecarBin = path.join(onedirDir, platformExecutable("DownanySidecar")[0]);
    fs.writeFileSync(sidecarBin, "");

    const resolved = bundledSidecarPath(path.join(tmp, "dist-electron"));
    expect(resolved).toBe(sidecarBin);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
