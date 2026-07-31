import { describe, expect, it } from "vitest";
import { checkForAppUpdates, isAppUpdateConfigured } from "./appUpdater";

describe("appUpdater stub", () => {
  it("reports disabled when feed is unset", async () => {
    expect(isAppUpdateConfigured()).toBe(false);
    const info = await checkForAppUpdates("0.1.0");
    expect(info.status).toBe("disabled");
    expect(info.currentVersion).toBe("0.1.0");
  });
});
