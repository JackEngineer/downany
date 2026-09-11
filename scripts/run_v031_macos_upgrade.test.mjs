import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { appBundleForExecutable, copyInstalledApp, parseArguments } from "./run_v031_macos_upgrade.mjs";

const absolute = (name) => path.resolve("/tmp", name);

test("macOS upgrade gate requires both release packages and the evidence destination", () => {
  const parsed = parseArguments([
    `--source-executable=${absolute("source/Downany.app/Contents/MacOS/Downany")}`,
    `--source-artifact=${absolute("Downany-0.3.0-mac.dmg")}`,
    `--candidate-executable=${absolute("candidate/Downany.app/Contents/MacOS/Downany")}`,
    `--candidate-artifact=${absolute("Downany-0.3.1-mac.dmg")}`,
    `--playwright-module=${absolute("playwright")}`,
    `--results=${absolute("results.json")}`,
  ]);
  assert.equal(parsed.sourceVersion, "0.3.0");
  assert.equal(parsed.candidateVersion, "0.3.1");
  assert.throws(() => parseArguments([]), /required/i);
});

test("macOS upgrade gate rejects ambiguous paths and versions", () => {
  const required = [
    `--source-executable=${absolute("source/Downany.app/Contents/MacOS/Downany")}`,
    `--source-artifact=${absolute("Downany-0.3.0-mac.dmg")}`,
    `--candidate-executable=${absolute("candidate/Downany.app/Contents/MacOS/Downany")}`,
    `--candidate-artifact=${absolute("Downany-0.3.1-mac.dmg")}`,
    `--playwright-module=${absolute("playwright")}`,
    `--results=${absolute("results.json")}`,
  ];
  assert.throws(() => parseArguments(["--source-executable=relative", ...required.slice(1)]), /absolute/i);
  assert.throws(() => parseArguments([...required, required[0]]), /duplicate/i);
  assert.throws(() => parseArguments([...required, "--source-version=0.3"]), /major.minor.patch/i);
  assert.throws(() => parseArguments([...required, "--platform=darwin"]), /unknown/i);
});

test("resolves a macOS executable to its enclosing app bundle", () => {
  assert.equal(
    appBundleForExecutable(absolute("Downany.app/Contents/MacOS/Downany")),
    absolute("Downany.app"),
  );
  assert.throws(() => appBundleForExecutable(absolute("Downany")), /app bundle/i);
});

test("isolated installation preserves relative framework symlinks", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "downany-upgrade-copy-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceApp = path.join(root, "source", "Downany.app");
  const executable = path.join(sourceApp, "Contents", "MacOS", "Downany");
  const framework = path.join(sourceApp, "Contents", "Frameworks", "Example.framework");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.mkdirSync(path.join(framework, "Versions", "A", "Resources"), { recursive: true });
  fs.writeFileSync(executable, "binary");
  fs.symlinkSync("A", path.join(framework, "Versions", "Current"));
  fs.symlinkSync("Versions/Current/Resources", path.join(framework, "Resources"));

  const installedApp = path.join(root, "installed", "Downany.app");
  copyInstalledApp(executable, installedApp, root);

  assert.equal(fs.readlinkSync(path.join(installedApp, "Contents", "Frameworks", "Example.framework", "Versions", "Current")), "A");
  assert.equal(fs.readlinkSync(path.join(installedApp, "Contents", "Frameworks", "Example.framework", "Resources")), "Versions/Current/Resources");
});
