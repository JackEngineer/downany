import { describe, expect, it } from "vitest";

import { appUpdateToast, safeVersion } from "./updatePresentation";

describe("safe update presentation", () => {
  it.each(["0.3.0", "2026.07.04", "0.3.1-rc.1", "1.2.3+build.4"])("accepts a version identifier: %s", (value) => {
    expect(safeVersion(value)).toBe(value);
  });

  it.each([null, undefined, 42, "Cookie: fake-secret", "C:\\private\\file", "https://example.com/private", "0.3.1\nsecret", "1.2." + "x".repeat(100)])("does not display a malformed version: %s", (value) => {
    expect(safeVersion(value)).toBe("");
  });

  it("does not copy server messages or invalid versions into the update toast", () => {
    const toast = appUpdateToast({ status: "available", currentVersion: "0.3.0", latestVersion: "Cookie: fake-secret", message: "C:\\private\\data" }, "en");
    expect(toast.kind).toBe("success");
    expect(JSON.stringify(toast)).not.toMatch(/fake-secret|private/);
  });
});
