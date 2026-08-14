import { describe, expect, it } from "vitest";

import { initializePrimaryInstance } from "./singleInstance";

describe("single-instance startup", () => {
  it("does not initialize a second app when the lock is unavailable", () => {
    let calls = 0;
    initializePrimaryInstance(false, () => {
      calls += 1;
    });

    expect(calls).toBe(0);
  });

  it("initializes the owner app after acquiring the lock", () => {
    let calls = 0;
    initializePrimaryInstance(true, () => {
      calls += 1;
    });

    expect(calls).toBe(1);
  });
});
