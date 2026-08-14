import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { TelegramCredentialVault } from "./credentialVault";

let dataDir: string | undefined;

afterEach(() => {
  if (dataDir) {
    fs.rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  }
});

describe("TelegramCredentialVault", () => {
  it("stores only encrypted bytes below the platform data directory", () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "downany-vault-"));
    const backend = {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(`encrypted:${value}`, "utf8"),
      decryptString: (value: Buffer) => value.toString("utf8").replace(/^encrypted:/, ""),
    };
    const vault = new TelegramCredentialVault(dataDir, backend);

    vault.save("42:secret");

    const filePath = path.join(dataDir, "telegram", "bot-token.bin");
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "telegram", "telegram", "bot-token.bin"))).toBe(false);
    expect(fs.readFileSync(filePath, "utf8")).toBe("encrypted:42:secret");
    expect(vault.read()).toBe("42:secret");

    vault.clear();
    expect(fs.existsSync(filePath)).toBe(false);
  });
});
