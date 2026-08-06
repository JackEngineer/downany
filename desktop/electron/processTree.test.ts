import { beforeEach, describe, expect, it, vi } from "vitest";

const { execFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
  default: { execFileSync: execFileSyncMock },
}));

import { killProcessTree } from "./processTree";

describe("killProcessTree", () => {
  beforeEach(() => {
    execFileSyncMock.mockClear();
  });

  it("uses taskkill /T /F on win32", () => {
    killProcessTree(4242, "win32");
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "taskkill",
      ["/pid", "4242", "/T", "/F"],
      expect.objectContaining({ windowsHide: true }),
    );
  });

  it("kills process group on posix", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    killProcessTree(999, "linux");
    expect(kill).toHaveBeenCalledWith(-999, "SIGTERM");
    kill.mockRestore();
  });

  it("falls back to single pid on posix when group kill fails", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation((targetPid) => {
      if (targetPid === -888) {
        throw new Error("no group");
      }
      return true;
    });
    killProcessTree(888, "darwin");
    expect(kill).toHaveBeenCalledWith(-888, "SIGTERM");
    expect(kill).toHaveBeenCalledWith(888, "SIGTERM");
    kill.mockRestore();
  });
});
