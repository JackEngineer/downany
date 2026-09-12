import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  OFFICIAL_V030_WINDOWS_SHA256,
  installerArguments,
  parseArguments,
} from "./run_v031_windows_upgrade.mjs";

const absolute = (name) => path.resolve(".build", "windows-upgrade-test", name);

test("Windows upgrade gate requires official v0.3.0 and exact v0.3.1 package inputs", () => {
  const parsed = parseArguments([
    `--source-artifact=${absolute("Downany-0.3.0-win-x64.exe")}`,
    `--candidate-artifact=${absolute("Downany-0.3.1-win-x64.exe")}`,
    `--candidate-executable=${absolute("win-unpacked/Downany.exe")}`,
    `--playwright-module=${absolute("node_modules/playwright")}`,
    `--results=${absolute("v0.3.1-windows-upgrade-results.json")}`,
  ]);
  assert.equal(parsed.sourceVersion, "0.3.0");
  assert.equal(parsed.candidateVersion, "0.3.1");
  assert.equal(OFFICIAL_V030_WINDOWS_SHA256, "ea4749ed52edf8bfd350ad3bd0a7eebf17fafe7c5eba19b53e306bb2c3cae946");
});

test("Windows upgrade gate rejects missing, relative and ambiguous package paths", () => {
  assert.throws(() => parseArguments([]), /required/i);
  assert.throws(() => parseArguments([
    "--source-artifact=Downany-0.3.0-win-x64.exe",
    `--candidate-artifact=${absolute("Downany-0.3.1-win-x64.exe")}`,
    `--candidate-executable=${absolute("win-unpacked/Downany.exe")}`,
    `--playwright-module=${absolute("node_modules/playwright")}`,
    `--results=${absolute("results.json")}`,
  ]), /absolute/i);
  assert.throws(() => parseArguments([
    `--source-artifact=${absolute("wrong.exe")}`,
    `--candidate-artifact=${absolute("Downany-0.3.1-win-x64.exe")}`,
    `--candidate-executable=${absolute("win-unpacked/Downany.exe")}`,
    `--playwright-module=${absolute("node_modules/playwright")}`,
    `--results=${absolute("results.json")}`,
  ]), /source artifact/i);
});

test("NSIS install arguments keep the owned destination last", () => {
  const installRoot = absolute("installed/Downany");
  assert.deepEqual(installerArguments(installRoot), ["/S", "/currentuser", `/D=${installRoot}`]);
});
