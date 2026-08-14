import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { ProcessOwnerState, ProcessOwnerStateStore } from "./supervisor";

function isOwnerState(value: unknown): value is ProcessOwnerState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.version === 5 && record.kind === "telegram-bot-api" && typeof record.instanceId === "string";
}

export function createFileProcessOwnerStateStore(filePath: string): ProcessOwnerStateStore {
  const resolved = path.resolve(filePath);
  return {
    async load(): Promise<ProcessOwnerState | null> {
      try {
        const raw = await fs.readFile(resolved, "utf8");
        const parsed: unknown = JSON.parse(raw);
        if (!isOwnerState(parsed)) throw new Error("Telegram owner state schema invalid");
        return parsed;
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
        throw error;
      }
    },
    async write(state: ProcessOwnerState): Promise<void> {
      await fs.mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
      const temporary = `${resolved}.${process.pid}.${Date.now()}.tmp`;
      const handle = await fs.open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await fs.rename(temporary, resolved);
      } finally {
        await fs.rm(temporary, { force: true });
      }
    },
    async clear(): Promise<void> {
      await fs.rm(resolved, { force: true });
    },
  };
}
