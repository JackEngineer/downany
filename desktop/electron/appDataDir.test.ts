import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { resolveDownanyDataDir, resolveDownanyLogDir } from "./appDataDir";

const HOME = "/Users/test";

describe("resolveDownanyDataDir", () => {
  it("uses macOS Application Support on darwin", () => {
    expect(resolveDownanyDataDir({}, "darwin", HOME)).toBe(
      path.join(HOME, "Library", "Application Support", "Downany"),
    );
  });

  it("uses LOCALAPPDATA on win32", () => {
    const env = { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" };
    expect(resolveDownanyDataDir(env, "win32", HOME)).toBe(
      path.join("C:\\Users\\test\\AppData\\Local", "Downany"),
    );
  });

  it("falls back to home AppData Local on win32 without LOCALAPPDATA", () => {
    expect(resolveDownanyDataDir({}, "win32", HOME)).toBe(
      path.join(HOME, "AppData", "Local", "Downany"),
    );
  });

  it("respects DOWNANY_DATA_DIR override", () => {
    const env = { DOWNANY_DATA_DIR: "/custom/data" };
    expect(resolveDownanyDataDir(env, "darwin", HOME)).toBe(
      path.resolve("/custom/data"),
    );
  });

  it("respects VIDEODL_DATA_DIR override", () => {
    const env = { VIDEODL_DATA_DIR: "/legacy/data" };
    expect(resolveDownanyDataDir(env, "win32", HOME)).toBe(
      path.resolve("/legacy/data"),
    );
  });
});

describe("resolveDownanyLogDir", () => {
  it("uses macOS Library Logs on darwin", () => {
    expect(resolveDownanyLogDir({}, "darwin", HOME)).toBe(
      path.join(HOME, "Library", "Logs", "Downany"),
    );
  });

  it("uses data/logs on win32", () => {
    const env = { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" };
    expect(resolveDownanyLogDir(env, "win32", HOME)).toBe(
      path.join("C:\\Users\\test\\AppData\\Local", "Downany", "logs"),
    );
  });

  it("uses data/logs when data dir is overridden", () => {
    const env = { DOWNANY_DATA_DIR: "/custom/data" };
    expect(resolveDownanyLogDir(env, "darwin", HOME)).toBe(
      path.join("/custom/data", "logs"),
    );
  });
});
