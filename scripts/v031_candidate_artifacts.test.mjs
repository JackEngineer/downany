import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { evaluateCandidateArtifacts } from "./v031_candidate_artifacts.mjs";

const MAC_HASH = "a".repeat(64);
const WIN_HASH = "b".repeat(64);
const EXT_HASH = "c".repeat(64);

function artifact(path, sha256, bytes) {
  return { path, sha256, bytes };
}

function completeManifest() {
  return {
    version: "0.3.1",
    extensionVersion: "0.8.3",
    installers: {
      "macos-arm64": artifact("mac.dmg", MAC_HASH, 100),
      "windows-x64": artifact("win.exe", WIN_HASH, 200),
    },
    extension: artifact("extension.zip", EXT_HASH, 300),
  };
}

function matchingInspections() {
  return {
    "macos-arm64": { exists: true, sha256: MAC_HASH, bytes: 100 },
    "windows-x64": { exists: true, sha256: WIN_HASH, bytes: 200 },
    extension: { exists: true, sha256: EXT_HASH, bytes: 300 },
  };
}

test("passes only when both installers and the extension match their manifest", () => {
  const report = evaluateCandidateArtifacts(completeManifest(), matchingInspections());
  assert.equal(report.integrityPassed, true);
  assert.equal(report.releaseReady, true);
  assert.deepEqual(report.verified, ["macos-arm64", "windows-x64", "extension"]);
  assert.deepEqual(report.failures, []);
});

test("keeps available artifact integrity separate from release completeness", () => {
  const manifest = completeManifest();
  manifest.installers["windows-x64"] = null;
  const inspections = matchingInspections();
  delete inspections["windows-x64"];

  const report = evaluateCandidateArtifacts(manifest, inspections);
  assert.equal(report.integrityPassed, true);
  assert.equal(report.releaseReady, false);
  assert.deepEqual(report.verified, ["macos-arm64", "extension"]);
  assert.match(report.releaseBlockers.join("\n"), /windows-x64/);
});

test("fails closed when a declared file is missing or does not match", () => {
  const inspections = matchingInspections();
  inspections["macos-arm64"].sha256 = "d".repeat(64);
  inspections.extension.exists = false;

  const report = evaluateCandidateArtifacts(completeManifest(), inspections);
  assert.equal(report.integrityPassed, false);
  assert.equal(report.releaseReady, false);
  assert.match(report.failures.join("\n"), /macos-arm64.*SHA-256/i);
  assert.match(report.failures.join("\n"), /extension.*missing/i);
});

test("rejects wrong versions, invalid hashes and unsafe paths", () => {
  const manifest = completeManifest();
  manifest.version = "0.3.0";
  manifest.extensionVersion = "0.8.2";
  manifest.installers["macos-arm64"].sha256 = "invalid";
  manifest.installers["windows-x64"].path = "C:/private/win.exe";
  manifest.extension.path = "/private/tmp/extension.zip";

  const report = evaluateCandidateArtifacts(manifest, matchingInspections());
  assert.equal(report.integrityPassed, false);
  assert.match(report.failures.join("\n"), /version must be 0\.3\.1/i);
  assert.match(report.failures.join("\n"), /extensionVersion must be 0\.8\.3/i);
  assert.match(report.failures.join("\n"), /repository-relative/i);
});

test("repository candidate manifest verifies available files but remains blocked on Windows", () => {
  const manifest = JSON.parse(fs.readFileSync(new URL(
    "../docs/acceptance/v0.3.1-candidate-artifacts.json",
    import.meta.url,
  ), "utf8"));
  const inspections = {
    "macos-arm64": { exists: true, ...manifest.installers["macos-arm64"] },
    extension: { exists: true, ...manifest.extension },
  };
  const report = evaluateCandidateArtifacts(manifest, inspections);
  assert.equal(report.integrityPassed, true);
  assert.equal(report.releaseReady, false);
  assert.deepEqual(report.releaseBlockers, ["windows-x64 installer is not available"]);
});
