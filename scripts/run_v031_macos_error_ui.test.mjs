import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { parseArguments } from "./run_v031_macos_error_ui.mjs";

const absolute = (name) => path.resolve("/tmp", name);

test("macOS error UI gate requires package, artifact, external samples and evidence paths", () => {
  const parsed = parseArguments([
    `--package-executable=${absolute("Downany.app/Contents/MacOS/Downany")}`,
    `--candidate-artifact=${absolute("Downany.dmg")}`,
    `--playwright-module=${absolute("playwright")}`,
    `--results=${absolute("results.json")}`,
    "--login-url=https://www.douyin.com/video/1",
    "--removed-url=https://www.youtube.com/watch?v=aaaaaaaaaaa",
  ]);
  assert.equal(parsed.expectedVersion, "0.3.1");
  assert.throws(() => parseArguments([]), /required/i);
});

test("macOS error UI gate rejects private schemes and ambiguous arguments", () => {
  const required = [
    `--package-executable=${absolute("Downany.app/Contents/MacOS/Downany")}`,
    `--candidate-artifact=${absolute("Downany.dmg")}`,
    `--playwright-module=${absolute("playwright")}`,
    `--results=${absolute("results.json")}`,
    "--login-url=https://www.douyin.com/video/1",
    "--removed-url=https://www.youtube.com/watch?v=aaaaaaaaaaa",
  ];
  assert.throws(() => parseArguments(["--package-executable=relative", ...required.slice(1)]), /absolute/i);
  assert.throws(() => parseArguments([...required, required[0]]), /duplicate/i);
  assert.throws(() => parseArguments([...required.slice(0, 4), "--login-url=file:///tmp/private", required[5]]), /https/i);
  assert.throws(() => parseArguments([...required, "--target=mac"]), /unknown/i);
});
