import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { verifyPackagedTelegramResources } from "./resourceManifest";

const temporaryRoots: string[] = [];

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function makeFixture(): Promise<{
  root: string;
  telegramExecutable: string;
  telegramManifest: string;
  processHostExecutable: string;
  processHostManifest: string;
}> {
  return makePlatformFixture("win32-x64");
}

async function makePlatformFixture(platform: "win32-x64" | "darwin-arm64"): Promise<{
  root: string;
  telegramExecutable: string;
  telegramManifest: string;
  processHostExecutable: string;
  processHostManifest: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "downany-telegram-resource-"));
  temporaryRoots.push(root);
  const telegramDir = path.join(root, "telegram-bot-api");
  const processHostDir = path.join(root, "process-host");
  await fs.mkdir(telegramDir, { recursive: true });
  await fs.mkdir(processHostDir, { recursive: true });
  const telegramBytes = Buffer.from("telegram-resource-binary");
  const processHostBytes = Buffer.alloc(8192, 0x5a);
  const telegramExecutableName = platform === "win32-x64" ? "telegram-bot-api.exe" : "telegram-bot-api";
  const processHostExecutableName = platform === "win32-x64" ? "DownanyProcessHost.exe" : "DownanyProcessHost";
  const telegramExecutable = path.join(telegramDir, telegramExecutableName);
  const telegramManifest = path.join(telegramDir, "manifest.json");
  const processHostExecutable = path.join(processHostDir, processHostExecutableName);
  const processHostManifest = path.join(processHostDir, "process-host-manifest.json");
  await fs.writeFile(telegramExecutable, telegramBytes);
  await fs.writeFile(processHostExecutable, processHostBytes);
  await fs.writeFile(telegramManifest, JSON.stringify({
    schemaVersion: 1,
    platform,
    sourceCommit: "a".repeat(40),
    executable: telegramExecutableName,
    size: telegramBytes.byteLength,
    sha256: sha256(telegramBytes),
  }) + "\n", "utf8");
  await fs.writeFile(processHostManifest, JSON.stringify({
    schemaVersion: 1,
    platform,
    sourceDisposition: "project_source",
    executable: processHostExecutableName,
    sha256: sha256(processHostBytes),
    bytes: processHostBytes.byteLength,
  }) + "\n", "utf8");
  return { root, telegramExecutable, telegramManifest, processHostExecutable, processHostManifest };
}

function fakePathSecurity(platform: "win32" | "darwin" = "win32") {
  return {
    platform,
    currentUserSid: "S-1-5-21-test",
    async inspectPath(value: string) {
      try {
        const stat = await fs.lstat(value);
        return {
          exists: true,
          kind: stat.isDirectory() ? "directory" as const : stat.isFile() ? "file" as const : "other" as const,
          isLinkOrReparsePoint: stat.isSymbolicLink(),
          posixMode: null,
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return { exists: false, kind: "other" as const, isLinkOrReparsePoint: false, posixMode: null };
        }
        throw error;
      }
    },
    async createDirectory() {},
    async chmod() {},
    async applyWindowsAcl() {},
    async inspectWindowsAcl() {
      return { inheritanceDisabled: true, allowSids: ["S-1-5-21-test"], fullControlSids: ["S-1-5-21-test"] };
    },
  };
}

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    await fs.rm(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

describe("packaged Telegram resource manifest verification", () => {
  it("accepts matching platform manifests and binaries", async () => {
    const fixture = await makeFixture();

    await expect(verifyPackagedTelegramResources({
      ...fixture,
      resourcesRoot: fixture.root,
      platform: "win32-x64",
      pathSecurity: fakePathSecurity(),
    })).resolves.toBeUndefined();
  });

  it("accepts the macOS arm64 resource layout", async () => {
    const fixture = await makePlatformFixture("darwin-arm64");

    await expect(verifyPackagedTelegramResources({
      ...fixture,
      resourcesRoot: fixture.root,
      platform: "darwin-arm64",
      pathSecurity: fakePathSecurity("darwin"),
    })).resolves.toBeUndefined();
  });

  it("rejects a binary changed after the build manifest was written", async () => {
    const fixture = await makeFixture();
    await fs.appendFile(fixture.telegramExecutable, "tampered");

    await expect(verifyPackagedTelegramResources({
      ...fixture,
      resourcesRoot: fixture.root,
      platform: "win32-x64",
      pathSecurity: fakePathSecurity(),
    })).rejects.toThrow(/manifest/);
  });
});
