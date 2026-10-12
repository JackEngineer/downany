import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import { protectOutput } from "./stdio";

describe("launcher output lifetime", () => {
  it("survives an asynchronous broken pipe and stops further writes", async () => {
    let writes = 0;
    const stream = new Writable({ write(_chunk, _encoding, callback) {
      writes += 1;
      setImmediate(() => callback(Object.assign(new Error("write EPIPE"), { code: "EPIPE" })));
    } });
    const write = protectOutput(stream);
    write("Sidecar log\n");
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(() => write("late log\n")).not.toThrow();
    expect(writes).toBe(1);
  });
  it("keeps healthy output working", () => {
    let output = "";
    const stream = new Writable({ write(chunk, _encoding, callback) { output += chunk; callback(); } });
    protectOutput(stream)("hello\n");
    expect(output).toBe("hello\n");
  });
  it("does not hide unrelated errors", () => {
    const stream = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    protectOutput(stream);
    expect(() => stream.emit("error", Object.assign(new Error("disk failure"), { code: "EIO" }))).toThrow("disk failure");
  });
});
