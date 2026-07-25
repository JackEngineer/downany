import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false },
}));

import { resolveRepoRoot, resolveSidecarLaunch } from "./paths";

describe("packaging paths", () => {
  it("resolves repo root from dist-electron layout", () => {
    // __dirname in tests is desktop/electron
    const root = resolveRepoRoot(__dirname);
    expect(root).toMatch(/downloader$/);
  });

  it("dev launch uses python -m src.sidecar", () => {
    const launch = resolveSidecarLaunch(__dirname, {
      repoRoot: resolveRepoRoot(__dirname),
      pythonPath: "/tmp/fake-python",
    });
    expect(launch.command).toBe("/tmp/fake-python");
    expect(launch.args).toEqual(["-m", "src.sidecar"]);
  });
});
