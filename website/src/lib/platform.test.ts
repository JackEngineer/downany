import { describe, expect, it } from "vitest";
import { detectPlatform, orderPlatforms } from "./platform";

describe("detectPlatform", () => {
  it.each([
    [{ userAgentDataPlatform: "macOS", userAgent: "ignored" }, "macos"],
    [{ userAgentDataPlatform: "Windows", userAgent: "ignored" }, "windows"],
    [{ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" }, "macos"],
    [{ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }, "windows"],
    [{ userAgent: "Mozilla/5.0 (X11; Linux x86_64)" }, "other"],
  ] as const)("maps %o to %s", (input, expected) => {
    expect(detectPlatform(input)).toBe(expected);
  });

  it("prefers userAgentData when it conflicts with the legacy user agent", () => {
    expect(
      detectPlatform({
        userAgentDataPlatform: "Windows",
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      }),
    ).toBe("windows");
  });
});

describe("orderPlatforms", () => {
  it("puts the visitor platform first without hiding the alternative", () => {
    expect(orderPlatforms("windows")).toEqual(["windows", "macos"]);
    expect(orderPlatforms("macos")).toEqual(["macos", "windows"]);
    expect(orderPlatforms("other")).toEqual(["macos", "windows"]);
  });
});
