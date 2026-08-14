import { safeStorage } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";

export interface CredentialBackend {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

function electronBackend(): CredentialBackend {
  return safeStorage as unknown as CredentialBackend;
}

export class TelegramCredentialVault {
  private readonly filePath: string;
  private readonly backend: CredentialBackend;

  constructor(dataDirOrFilePath: string, backend: CredentialBackend = electronBackend()) {
    // Keep the old dataDir constructor compatible with existing profiles/tests;
    // new callers pass the v1 file path explicitly so the on-disk contract is
    // unambiguous and never creates two token copies.
    this.filePath = path.basename(dataDirOrFilePath) === "bot-token.v1"
      ? path.resolve(dataDirOrFilePath)
      : path.join(dataDirOrFilePath, "telegram", "bot-token.bin");
    this.backend = backend;
  }

  hasToken(): boolean {
    return fs.existsSync(this.filePath);
  }

  save(token: string): void {
    if (!this.backend.isEncryptionAvailable()) {
      throw new Error("系统加密存储尚未可用，请稍后重试");
    }
    const encrypted = this.backend.encryptString(token);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      const fd = fs.openSync(temporary, "wx", 0o600);
      try {
        fs.writeFileSync(fd, encrypted);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      try {
        fs.renameSync(temporary, this.filePath);
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error
          ? String((error as NodeJS.ErrnoException).code || "")
          : "";
        if (process.platform !== "win32" || !["EEXIST", "EPERM"].includes(code)) throw error;
        fs.rmSync(this.filePath, { force: true });
        fs.renameSync(temporary, this.filePath);
      }
    } finally {
      try {
        fs.unlinkSync(temporary);
      } catch {
        // already renamed
      }
    }
  }

  read(): string | null {
    if (!this.hasToken()) return null;
    if (!this.backend.isEncryptionAvailable()) {
      throw new Error("系统加密存储尚未可用，请稍后重试");
    }
    return this.backend.decryptString(fs.readFileSync(this.filePath));
  }

  clear(): void {
    try {
      fs.rmSync(this.filePath, { force: true });
    } catch (error) {
      throw new Error(`删除 Telegram 凭据失败: ${String(error)}`);
    }
  }
}
