import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { evaluateManualAcceptance, manualAcceptanceContract } from "./v031_manual_acceptance.mjs";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const REQUIRED_CHECKS = {
  firstInstall: true,
  upgradeFrom030: true,
  settingsPreserved: true,
  queuePreserved: true,
  pauseResume: true,
  playback: true,
  noOverwrite: true,
};

function historicalTrial(participantId) {
  return {
    participantId,
    firstTimeUser: true,
    target: null,
    candidateSha256: null,
    observedAt: null,
    addMethod: null,
    completedWithoutGuidance: null,
    completedSteps: [],
    blockedStep: null,
    notes: "",
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

function passingEvidence(version = "0.3.1") {
  return {
    version,
    firstUseTrials: [],
    packageRecords: [
      packageRecord("macos-arm64", HASH_A),
      packageRecord("windows-x64", HASH_B),
    ],
  };
}

test("both manual package records pass without first-use participants", () => {
  const report = evaluateManualAcceptance(passingEvidence());
  assert.equal(report.passed, true);
  assert.deepEqual(report.firstUse, { status: "cancelled_by_user", historicalTrialCount: 0 });
  assert.deepEqual(report.packageTargets, ["macos-arm64", "windows-x64"]);
  assert.deepEqual(report.failures, []);
});

test("missing legacy trial field does not block the retained manual gate", () => {
  const evidence = passingEvidence();
  delete evidence.firstUseTrials;
  const report = evaluateManualAcceptance(evidence);
  assert.equal(report.passed, true);
  assert.deepEqual(report.firstUse, { status: "cancelled_by_user", historicalTrialCount: 0 });
});

test("unfilled historical trials are retained without blocking or mutating their evidence", () => {
  const evidence = passingEvidence();
  evidence.firstUseTrials = ["P1", "P2", "P3", "P4", "P5"].map(historicalTrial);
  const original = structuredClone(evidence);
  const report = evaluateManualAcceptance(evidence);
  assert.equal(report.passed, true);
  assert.deepEqual(report.firstUse, { status: "cancelled_by_user", historicalTrialCount: 5 });
  assert.deepEqual(report.failures, []);
  assert.deepEqual(evidence, original);
});

test("legacy participant qualifications, extension steps and candidate comparisons no longer block", () => {
  const evidence = passingEvidence();
  evidence.firstUseTrials = [
    { ...historicalTrial("legacy"), firstTimeUser: false, target: "windows-x64", candidateSha256: HASH_A, addMethod: "extension", completedWithoutGuidance: true },
    { ...historicalTrial("legacy"), completedWithoutGuidance: false },
  ];
  const original = structuredClone(evidence);
  const report = evaluateManualAcceptance(evidence);
  assert.equal(report.passed, true);
  assert.deepEqual(report.firstUse, { status: "cancelled_by_user", historicalTrialCount: 2 });
  assert.deepEqual(evidence, original);
});

test("historical successes are not reported as currently accepted participant successes", () => {
  const evidence = passingEvidence();
  evidence.firstUseTrials = ["P1", "P2", "P3", "P4", "P5"].map((id) => ({
    ...historicalTrial(id), target: "macos-arm64", candidateSha256: HASH_A,
    observedAt: "2026-09-12T09:30:00+08:00", addMethod: "extension",
    completedWithoutGuidance: true, completedSteps: ["install", "add", "download", "open", "extensionConnect"],
  }));
  const report = evaluateManualAcceptance(evidence);
  assert.deepEqual(report.firstUse, { status: "cancelled_by_user", historicalTrialCount: 5 });
  assert.equal("completedWithoutGuidance" in report.firstUse, false);
});

for (const expectedVersion of ["0.3.1", "0.3.2"]) {
for (const target of ["macos-arm64", "windows-x64"]) {
  test(`${expectedVersion} still rejects missing ${target} manual package evidence`, () => {
    const evidence = passingEvidence(expectedVersion);
    evidence.packageRecords = evidence.packageRecords.filter((record) => record.target !== target);
    const report = evaluateManualAcceptance(evidence, { expectedVersion });
    assert.equal(report.passed, false);
    assert.ok(report.failures.includes(`Missing manual package record: ${target}`));
  });

  for (const check of Object.keys(REQUIRED_CHECKS)) {
    test(`${expectedVersion} still requires ${target} manual check ${check}`, () => {
      const evidence = passingEvidence(expectedVersion);
      evidence.packageRecords.find((record) => record.target === target).checks[check] = false;
      const report = evaluateManualAcceptance(evidence, { expectedVersion });
      assert.equal(report.passed, false);
      assert.ok(report.failures.includes(`${target} manual check must pass: ${check}`));
    });
  }

  for (const [field, value, expected] of [
    ["manual", false, "package record must be manual"],
    ["candidateSha256", null, "is missing a candidate SHA-256"],
    ["candidateSha256", "invalid", "is missing a candidate SHA-256"],
    ["recordedAt", null, "is missing a valid record time"],
    ["recordedAt", "invalid", "is missing a valid record time"],
    ["notes", "", "package record must include a concise manual note"],
  ]) {
    test(`${expectedVersion} still rejects ${target} ${field}=${value}`, () => {
      const evidence = passingEvidence(expectedVersion);
      evidence.packageRecords.find((record) => record.target === target)[field] = value;
      const report = evaluateManualAcceptance(evidence, { expectedVersion });
      assert.equal(report.passed, false);
      assert.ok(report.failures.includes(`${target} ${expected}`));
    });
  }
}

}

test("duplicate and unknown package targets remain invalid", () => {
  const evidence = passingEvidence();
  evidence.packageRecords.push(packageRecord("macos-arm64", HASH_A), packageRecord("unknown", HASH_A));
  const report = evaluateManualAcceptance(evidence);
  assert.equal(report.passed, false);
  assert.ok(report.failures.includes("Duplicate manual package record: macos-arm64"));
  assert.ok(report.failures.includes("Unknown package target: unknown"));
});

for (const privateValue of ["/Users/person/private.mp4", "C:\\Users\\person\\private.mp4", "https://example.invalid/private", "cookie", "token"]) {
  test(`privacy scan still covers ignored historical fields: ${privateValue}`, () => {
    const evidence = passingEvidence();
    evidence.firstUseTrials = [{ ...historicalTrial("P1"), notes: privateValue }];
    evidence.archived = { nested: [privateValue] };
    const original = structuredClone(evidence);
    const report = evaluateManualAcceptance(evidence);
    assert.equal(report.passed, false);
    assert.ok(report.failures.includes("evidence.firstUseTrials[0].notes contains private evidence"));
    assert.ok(report.failures.includes("evidence.archived.nested[0] contains private evidence"));
    assert.deepEqual(evidence, original);
  });
}

test("invalid evidence and version remain rejected with an explicit cancelled first-use status", () => {
  const invalid = evaluateManualAcceptance(null);
  assert.equal(invalid.passed, false);
  assert.deepEqual(invalid.firstUse, { status: "cancelled_by_user", historicalTrialCount: 0 });
  const evidence = passingEvidence();
  evidence.version = "0.3.0";
  assert.ok(evaluateManualAcceptance(evidence).failures.includes("Evidence version must be 0.3.1"));
});

test("public contract only declares the retained manual requirements", () => {
  assert.deepEqual(manualAcceptanceContract, {
    targets: ["macos-arm64", "windows-x64"],
    firstUseStatus: "cancelled_by_user",
    packageChecks: Object.keys(REQUIRED_CHECKS),
  });
});

test("repository template is complete but cannot be mistaken for executed evidence", () => {
  const template = JSON.parse(fs.readFileSync(new URL(
    "../docs/acceptance/v0.3.1-manual-acceptance.template.json",
    import.meta.url,
  ), "utf8"));
  const report = evaluateManualAcceptance(template);
  assert.ok(Array.isArray(template.firstUseTrials));
  assert.equal(template.packageRecords.length, 2);
  assert.equal(report.passed, false);
  assert.equal(report.firstUse.status, "cancelled_by_user");
  assert.match(report.failures.join("\n"), /manual/i);
  assert.match(report.failures.join("\n"), /firstInstall/i);
});

// 以下数据仅用于校验器单元测试，不能写入真实人工验收报告。
test("explicit next-release contract accepts complete records without changing their identity", () => {
  const evidence = passingEvidence("0.3.2");
  const original = structuredClone(evidence);
  const report = evaluateManualAcceptance(evidence, { expectedVersion: "0.3.2" });
  assert.equal(report.passed, true);
  assert.deepEqual(report.packageTargets, ["macos-arm64", "windows-x64"]);
  assert.deepEqual(report.failures, []);
  assert.deepEqual(evidence, original);
});

test("historical and next-release records cannot satisfy one another's contract", () => {
  assert.deepEqual(evaluateManualAcceptance(passingEvidence("0.3.2")).failures,
    ["Evidence version must be 0.3.1"]);
  assert.deepEqual(evaluateManualAcceptance(passingEvidence(), { expectedVersion: "0.3.2" }).failures,
    ["Evidence version must be 0.3.2"]);
});

test("expected release versions require strict major.minor.patch strings", () => {
  for (const expectedVersion of ["", "0.3", "0.3.2-beta", "0.3.2+build", "00.3.2", "0.03.2", "0.3.02",
    "0.3.2\n", "../0.3.2", " 0.3.2", null, 32, {}, new String("0.3.2")]) {
    assert.throws(() => evaluateManualAcceptance(passingEvidence(), { expectedVersion }),
      /^Error: Expected version must be major.minor.patch$/);
  }
});

test("an unexecuted historical template remains blocked after changing the requested version", () => {
  const template = JSON.parse(fs.readFileSync(new URL(
    "../docs/acceptance/v0.3.1-manual-acceptance.template.json", import.meta.url), "utf8"));
  template.version = "0.3.2";
  const report = evaluateManualAcceptance(template, { expectedVersion: "0.3.2" });
  assert.equal(report.passed, false);
  for (const target of ["macos-arm64", "windows-x64"]) {
    assert.ok(report.failures.includes(`${target} package record must be manual`));
    assert.ok(report.failures.includes(`${target} is missing a candidate SHA-256`));
    for (const check of Object.keys(REQUIRED_CHECKS)) {
      assert.ok(report.failures.includes(`${target} manual check must pass: ${check}`));
    }
  }
});

function runCli(t, evidence, args = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "downany-manual-evaluator-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const evidencePath = path.join(root, "synthetic-unit-test.json");
  fs.writeFileSync(evidencePath, JSON.stringify(evidence));
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL("./evaluate_v031_manual_acceptance.mjs", import.meta.url)), evidencePath, ...args,
  ], { encoding: "utf8", timeout: 10000, windowsHide: true, env: { ...process.env, NODE_OPTIONS: "" } });
  assert.ifError(result.error);
  return result;
}

for (const [version, args] of [["0.3.1", []], ["0.3.2", ["--expected-version=0.3.2"]]]) {
  test(`CLI accepts complete ${version} unit-test records with its requested contract`, (t) => {
    const result = runCli(t, passingEvidence(version), args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).passed, true);
  });
}

for (const [version, args] of [["0.3.2", []], ["0.3.1", ["--expected-version=0.3.2"]]]) {
  test(`CLI rejects ${version} unit-test records under the other release contract`, (t) => {
    const result = runCli(t, passingEvidence(version), args);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).passed, false);
  });
}

test("CLI still rejects empty next-release manual evidence", (t) => {
  const result = runCli(t, { version: "0.3.2", firstUseTrials: [], packageRecords: [] }, ["--expected-version=0.3.2"]);
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.passed, false);
  assert.ok(report.failures.includes("Missing manual package record: macos-arm64"));
  assert.ok(report.failures.includes("Missing manual package record: windows-x64"));
});

for (const [label, args] of [
  ["empty version", ["--expected-version="]],
  ["invalid version", ["--expected-version=00.3.2"]],
  ["duplicate versions", ["--expected-version=0.3.2", "--expected-version=0.3.1"]],
  ["unknown option", ["--accept-template=true"]],
  ["multiple records", ["extra-record.json"]],
]) {
  test(`CLI fails closed for ${label}`, (t) => {
    const result = runCli(t, passingEvidence("0.3.2"), args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.notEqual(result.stderr.trim(), "");
  });
}
