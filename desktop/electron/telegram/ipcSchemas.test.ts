import { describe, expect, it } from "vitest";

import { telegramChatIdSchema, telegramTokenSchema } from "./ipcSchemas";

describe("Telegram IPC schemas", () => {
  it("accepts signed group/chat identifiers", () => {
    expect(telegramChatIdSchema.parse("-1001234567890")).toBe("-1001234567890");
    expect(telegramChatIdSchema.parse("123456")).toBe("123456");
  });

  it("rejects ambiguous or unsafe identifiers", () => {
    expect(() => telegramChatIdSchema.parse("-0")).toThrow();
    expect(() => telegramChatIdSchema.parse("1.0")).toThrow();
    expect(() => telegramChatIdSchema.parse("1e3")).toThrow();
  });

  it("keeps Bot Token validation at the IPC edge", () => {
    expect(() => telegramTokenSchema.parse("12345:abcdefghijklmnopqrstuvwxyz" )).not.toThrow();
    expect(() => telegramTokenSchema.parse("12345:short")).toThrow();
  });
});
