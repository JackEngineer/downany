import { describe, expect, it } from "vitest";

import {
  decideBridgeEnqueue,
  isSidecarAcceptingEnqueue,
  SIDECAR_NOT_READY_ERROR,
} from "./enqueueGate";

describe("decideBridgeEnqueue", () => {
  it("flushes when sidecar is ready", () => {
    expect(decideBridgeEnqueue(true)).toEqual({ kind: "flush" });
  });

  it("defers with explicit error when sidecar is not ready", () => {
    expect(decideBridgeEnqueue(false)).toEqual({
      kind: "defer",
      error: SIDECAR_NOT_READY_ERROR,
    });
  });
});

describe("isSidecarAcceptingEnqueue", () => {
  it("only accepts connected state", () => {
    expect(isSidecarAcceptingEnqueue("connected")).toBe(true);
    expect(isSidecarAcceptingEnqueue("connecting")).toBe(false);
    expect(isSidecarAcceptingEnqueue("reconnecting")).toBe(false);
    expect(isSidecarAcceptingEnqueue("disconnected")).toBe(false);
    expect(isSidecarAcceptingEnqueue("failed")).toBe(false);
  });
});
