import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveOpenablePath } from "./resolveOpenablePath";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveOpenablePath", () => {
  it("prefers merged mp4 when fragment path is recorded", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "videodl-open-"));
    tmpDirs.push(dir);
    const finalPath = path.join(dir, "demo.mp4");
    fs.writeFileSync(finalPath, "x");
    const fragment = path.join(dir, "demo.f140.m4a");
    expect(resolveOpenablePath(fragment)).toBe(finalPath);
  });

  it("returns original when no sibling exists", () => {
    expect(resolveOpenablePath("/tmp/no-such.f140.m4a")).toBe(
      "/tmp/no-such.f140.m4a",
    );
  });
});
