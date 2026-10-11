import { describe, it, expect } from "vitest";
import { runtimeInfo } from "./runtimeInfo";
describe("actual runtime versions", () => {
  it("distinguishes installed desktop from the handshaken service", () => {
    expect(runtimeInfo("0.3.3", "0.3.2", "connected", "listening")).toMatchObject({sidecarVersion:"0.3.2",versionMismatch:true});
  });
  it("does not present a previous or unsafe handshake as currently running", () => {
    expect(runtimeInfo("0.3.3", "0.3.2", "reconnecting", "unavailable").sidecarVersion).toBeNull();
    expect(runtimeInfo("0.3.3", "private-path-secret", "connected", "listening").sidecarVersion).toBeNull();
  });
});
