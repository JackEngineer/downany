import { describe, expect, it } from "vitest";

import { Methods, PROTOCOL_VERSION } from "./protocol";

describe("protocol constants", () => {
  it("matches frozen protocol version", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it("includes required methods", () => {
    expect(Methods).toContain("app.getSnapshot");
    expect(Methods).toContain("app.ping");
    expect(Methods).toContain("app.shutdown");
    expect(Methods).toContain("app.runMigration");
    expect(Methods).toContain("updater.updateYtDlp");
    expect(new Set(Methods).size).toBe(Methods.length);
  });
});
