import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { parseArguments } from "./run_v031_macos_first_install.mjs";

const absolute = (name) => path.resolve("/tmp", name);

test("macOS first-install gate requires mounted package, artifact and evidence paths", () => {
  const parsed = parseArguments([
    `--package-executable=${absolute("Downany.app/Contents/MacOS/Downany")}`,
    `--candidate-artifact=${absolute("Downany-0.3.1-mac.dmg")}`,
    `--playwright-module=${absolute("playwright")}`,
    `--results=${absolute("results.json")}`,
  ]);
  assert.equal(parsed.expectedVersion, "0.3.1");
  assert.throws(() => parseArguments([]), /required/i);
});

test("macOS first-install gate fails closed on ambiguous arguments", () => {
  const required = [
    `--package-executable=${absolute("Downany.app/Contents/MacOS/Downany")}`,
    `--candidate-artifact=${absolute("Downany-0.3.1-mac.dmg")}`,
    `--playwright-module=${absolute("playwright")}`,
    `--results=${absolute("results.json")}`,
  ];
  assert.throws(() => parseArguments(["--package-executable=relative", ...required.slice(1)]), /absolute/i);
  assert.throws(() => parseArguments([...required, required[0]]), /duplicate/i);
  assert.throws(() => parseArguments([...required, "--expected-version=0.3"]), /major.minor.patch/i);
  assert.throws(() => parseArguments([...required, "--source=v0.3.1"]), /unknown/i);
});
