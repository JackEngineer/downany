import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { parseArguments } from "./run_v031_macos_recovery.mjs";

const absolute = (name) => path.resolve("/tmp", name);

test("macOS recovery gate requires explicit candidate and evidence paths", () => {
  const parsed = parseArguments([
    `--executable=${absolute("Downany")}`,
    `--candidate-artifact=${absolute("Downany.dmg")}`,
    `--playwright-module=${absolute("playwright")}`,
    `--results=${absolute("results.json")}`,
  ]);
  assert.equal(parsed.expectedVersion, "0.3.1");
  assert.equal(parsed.candidateArtifact, absolute("Downany.dmg"));
  assert.throws(() => parseArguments([]), /required/i);
});

test("macOS recovery gate rejects relative, duplicate and unknown arguments", () => {
  const required = [
    `--executable=${absolute("Downany")}`,
    `--candidate-artifact=${absolute("Downany.dmg")}`,
    `--playwright-module=${absolute("playwright")}`,
    `--results=${absolute("results.json")}`,
  ];
  assert.throws(() => parseArguments(["--executable=relative", ...required.slice(1)]), /absolute/i);
  assert.throws(() => parseArguments([...required, required[0]]), /duplicate/i);
  assert.throws(() => parseArguments([...required, "--platform=darwin"]), /unknown/i);
});
