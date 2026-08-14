import { describe, expect, it } from "vitest";

import {
  buildSidecarChildEnv,
  buildTelegramBotApiChildEnv,
  resolveTelegramBotApiPaths,
  selectSidecarRecoveryPrivatePaths,
  selectTelegramPrivateDataPaths,
} from "./paths";

describe("Telegram runtime paths and child environments", () => {
  it("uses a data-root private layout and packaged resource paths", () => {
    const paths = resolveTelegramBotApiPaths({ platform: "win32", isPackaged: true, resourcesPath: "C:\\Program Files\\Downany\\resources", downanyDataDir: "D:\\Downany Data", env: { DOWNANY_TELEGRAM_BOT_API_BIN: "C:\\evil.exe" } });
    expect(paths.executable).toBe("C:\\Program Files\\Downany\\resources\\telegram-bot-api\\telegram-bot-api.exe");
    expect(paths.credentialFile).toBe("D:\\Downany Data\\telegram\\bot-token.v1");
    expect(Object.keys(selectTelegramPrivateDataPaths(paths)).sort()).toEqual(["credentialFile", "ownerStateFile", "rootDir", "sidecarOwnerStateFile", "tempDir", "workDir"].sort());
    expect(Object.keys(selectSidecarRecoveryPrivatePaths(paths)).sort()).toEqual(["rootDir", "sidecarOwnerStateFile"].sort());
  });

  it("removes secrets and only adds app credentials to the Bot API child", () => {
    const base = { PATH: "x", path: "bad", Bot_Token: "123456:ABC_secret-value", GH_TOKEN: "secret", unrelated: "keep" };
    const child = buildTelegramBotApiChildEnv(base, { apiId: "123456", apiHash: "0123456789abcdef0123456789abcdef" });
    expect(child).toEqual({ PATH: "x", TELEGRAM_API_ID: "123456", TELEGRAM_API_HASH: "0123456789abcdef0123456789abcdef" });
  });

  it("builds a credential-free Sidecar environment", () => {
    const child = buildSidecarChildEnv({ PATH: "x", DOWNANY_TELEGRAM_API_HASH: "secret", GH_TOKEN: "secret" }, { dataDir: "D:\\data", binDir: "D:\\bin", noProxy: "127.0.0.1" });
    expect(child).toMatchObject({ PATH: "x", DOWNANY_DATA_DIR: "D:\\data", DOWNANY_BIN_DIR: "D:\\bin", NO_PROXY: "127.0.0.1", PYTHONUNBUFFERED: "1" });
    expect(Object.keys(child).some((key) => /telegram|token|api_hash|api_id/i.test(key))).toBe(false);
  });
});
