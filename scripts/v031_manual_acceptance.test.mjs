import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { evaluateManualAcceptance } from "./v031_manual_acceptance.mjs";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const REQUIRED_STEPS = ["install", "add", "download", "open"];
const REQUIRED_CHECKS = {
  firstInstall: true,
  upgradeFrom030: true,
  settingsPreserved: true,
  queuePreserved: true,
  pauseResume: true,
  playback: true,
  noOverwrite: true,
};

function trial(participantId, completedWithoutGuidance, target = "macos-arm64", addMethod = "app") {
  return {
    participantId,
    firstTimeUser: true,
    target,
    candidateSha256: target === "macos-arm64" ? HASH_A : HASH_B,
    observedAt: "2026-09-12T09:30:00+08:00",
    addMethod,
    completedWithoutGuidance,
    completedSteps: completedWithoutGuidance
      ? [...REQUIRED_STEPS, ...(addMethod === "extension" ? ["extensionConnect"] : [])]
      : ["install", "add"],
    blockedStep: completedWithoutGuidance ? null : "download",
    notes: completedWithoutGuidance ? "" : "下载阶段需要观察员提示",
  };
}

function packageRecord(target, hash) {
  return {
    target,
    candidateSha256: hash,
    recordedAt: "2026-09-12T10:00:00+08:00",
    manual: true,
    checks: { ...REQUIRED_CHECKS },
    notes: "在真实系统中逐项操作并确认",
  };
}

function passingEvidence() {
  return {
    version: "0.3.1",
    firstUseTrials: [
      trial("P1", true), trial("P2", true), trial("P3", true),
      trial("P4", true, "windows-x64", "extension"), trial("P5", false, "windows-x64"),
    ],
    packageRecords: [
      packageRecord("macos-arm64", HASH_A),
      packageRecord("windows-x64", HASH_B),
    ],
  };
}

test("passes only with five first-time users, four unassisted successes and both manual package records", () => {
  const report = evaluateManualAcceptance(passingEvidence());
  assert.equal(report.passed, true);
  assert.equal(report.firstUse.completedWithoutGuidance, 4);
  assert.deepEqual(report.packageTargets, ["macos-arm64", "windows-x64"]);
  assert.deepEqual(report.failures, []);
});

test("fails when fewer than four users complete the first download without guidance", () => {
  const evidence = passingEvidence();
  evidence.firstUseTrials[3] = trial("P4", false, "windows-x64");
  const report = evaluateManualAcceptance(evidence);
  assert.equal(report.passed, false);
  assert.match(report.failures.join("\n"), /at least 4/i);
});

test("requires one real extension route and its connection step", () => {
  const withoutExtension = passingEvidence();
  withoutExtension.firstUseTrials[3] = trial("P4", true, "windows-x64");
  assert.match(evaluateManualAcceptance(withoutExtension).failures.join("\n"), /extension/i);

  const missingConnection = passingEvidence();
  missingConnection.firstUseTrials[3].completedSteps = [...REQUIRED_STEPS];
  assert.match(evaluateManualAcceptance(missingConnection).failures.join("\n"), /extensionConnect/);

  const incompleteExtension = passingEvidence();
  incompleteExtension.firstUseTrials[3] = trial("P4", true, "windows-x64");
  incompleteExtension.firstUseTrials[4] = trial("P5", false, "windows-x64", "extension");
  assert.match(evaluateManualAcceptance(incompleteExtension).failures.join("\n"), /complete the extension connection/i);
});

test("fails closed for missing manual package checks and mismatched candidate hashes", () => {
  const evidence = passingEvidence();
  evidence.packageRecords[0].manual = false;
  evidence.packageRecords[1].checks.playback = false;
  evidence.firstUseTrials[3].candidateSha256 = HASH_A;
  const report = evaluateManualAcceptance(evidence);
  assert.equal(report.passed, false);
  assert.match(report.failures.join("\n"), /manual/i);
  assert.match(report.failures.join("\n"), /playback/i);
  assert.match(report.failures.join("\n"), /candidate/i);
});

test("rejects duplicate participants, private evidence and incomplete failed-trial notes", () => {
  const evidence = passingEvidence();
  evidence.firstUseTrials[4].participantId = "P4";
  evidence.firstUseTrials[4].notes = "/Users/person/Downloads/private.mp4";
  evidence.firstUseTrials[4].blockedStep = null;
  const report = evaluateManualAcceptance(evidence);
  assert.equal(report.passed, false);
  assert.match(report.failures.join("\n"), /duplicate/i);
  assert.match(report.failures.join("\n"), /private/i);
  assert.match(report.failures.join("\n"), /blockedStep/i);
});

test("repository template is complete but cannot be mistaken for executed evidence", () => {
  const template = JSON.parse(fs.readFileSync(new URL(
    "../docs/acceptance/v0.3.1-manual-acceptance.template.json",
    import.meta.url,
  ), "utf8"));
  const report = evaluateManualAcceptance(template);
  assert.equal(template.firstUseTrials.length, 5);
  assert.equal(template.packageRecords.length, 2);
  assert.equal(report.passed, false);
  assert.match(report.failures.join("\n"), /completedWithoutGuidance/i);
  assert.match(report.failures.join("\n"), /manual/i);
});
