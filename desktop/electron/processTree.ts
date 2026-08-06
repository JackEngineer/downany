import { execFileSync } from "node:child_process";

export function killProcessTree(pid: number, platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") {
    try {
      execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      // process may already have exited
    }
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // ignore
    }
  }
}
