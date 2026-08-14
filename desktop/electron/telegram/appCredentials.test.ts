import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { loadTelegramAppCredentials } from "./appCredentials";

describe("Telegram app credentials", () => {
  it("loads both values from development environment", async () => {
    await expect(loadTelegramAppCredentials({
      isPackaged: false,
      appCredentialsFile: "unused",
      env: { DOWNANY_TELEGRAM_API_ID: "123456", DOWNANY_TELEGRAM_API_HASH: "0123456789abcdef0123456789abcdef" },
    })).resolves.toEqual({ apiId: "123456", apiHash: "0123456789abcdef0123456789abcdef" });
  });

  it("rejects a missing paired credential without echoing values", async () => {
    await expect(loadTelegramAppCredentials({ isPackaged: false, appCredentialsFile: "unused", env: { DOWNANY_TELEGRAM_API_ID: "123456" } })).rejects.toThrow(/apiHash/);
  });

  it("loads the strict packaged schema", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "downany-app-credentials-"));
    const file = path.join(dir, "app-credentials.json");
    await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, apiId: "123456", apiHash: "0123456789abcdef0123456789abcdef" }));
    await expect(loadTelegramAppCredentials({ isPackaged: true, appCredentialsFile: file, env: {} })).resolves.toEqual({ apiId: "123456", apiHash: "0123456789abcdef0123456789abcdef" });
    await fs.rm(dir, { recursive: true, force: true });
  });
});
