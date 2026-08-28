import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { registerProtocolClient } from "./protocolClient";

describe("protocol client registration", () => {
  it.each([false, true])("does not change the protocol association in isolated smoke (defaultApp=%s)", (defaultApp) => {
    const app = { setAsDefaultProtocolClient: vi.fn(() => true) };
    expect(registerProtocolClient(app, {
      env: { DOWNANY_SKIP_PROTOCOL_REGISTRATION: "1" }, defaultApp,
      execPath: "D:/candidate/Downany.exe", argv: ["electron", "./entry.js"],
    })).toBe(false);
    expect(app.setAsDefaultProtocolClient).not.toHaveBeenCalled();
  });

  it.each([undefined, "0", "true"])("preserves packaged registration unless explicitly skipped (%s)", (flag) => {
    const app = { setAsDefaultProtocolClient: vi.fn(() => true) };
    expect(registerProtocolClient(app, {
      env: { DOWNANY_SKIP_PROTOCOL_REGISTRATION: flag }, defaultApp: false,
      execPath: "D:/installed/Downany.exe", argv: [],
    })).toBe(true);
    expect(app.setAsDefaultProtocolClient).toHaveBeenCalledTimes(1);
    expect(app.setAsDefaultProtocolClient).toHaveBeenCalledWith("downany");
  });

  it("preserves the resolved development entry point", () => {
    const app = { setAsDefaultProtocolClient: vi.fn(() => true) };
    registerProtocolClient(app, {
      env: {}, defaultApp: true, execPath: "D:/tools/electron.exe",
      argv: ["electron", "./entry.js"],
    });
    expect(app.setAsDefaultProtocolClient).toHaveBeenCalledTimes(1);
    expect(app.setAsDefaultProtocolClient).toHaveBeenCalledWith(
      "downany", "D:/tools/electron.exe", [path.resolve("./entry.js")],
    );
  });

  it("does not register an incomplete development command", () => {
    const app = { setAsDefaultProtocolClient: vi.fn(() => true) };
    expect(registerProtocolClient(app, {
      env: {}, defaultApp: true, execPath: "D:/tools/electron.exe", argv: ["electron"],
    })).toBe(false);
    expect(app.setAsDefaultProtocolClient).not.toHaveBeenCalled();
  });
});
