import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createOptionalTelegramSupervisor } from "./runtimeFactory";

const temporaryRoots: string[] = [];

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    await fs.rm(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

describe("optional Telegram local supervisor", () => {
  it.each([
    ["win32"],
    ["darwin"],
  ] as const)("falls back to the cloud API when %s native resources are absent", async (platform) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "downany-telegram-runtime-"));
    temporaryRoots.push(root);

    await expect(createOptionalTelegramSupervisor({
      fromDir: root,
      isPackaged: true,
      platform,
      resourcesPath: path.join(root, "resources"),
      dataDir: path.join(root, "data"),
      env: {},
    })).resolves.toBeNull();
  });
});
