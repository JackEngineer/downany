import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateReliabilityResults,
  validateReliabilityMatrix,
} from "./v031_acceptance_helpers.mjs";

function matrix() {
  const rows = [];
  for (const platform of ["youtube", "bilibili", "douyin"]) {
    for (let index = 1; index <= 10; index += 1) {
      rows.push({
        id: `${platform}-${String(index).padStart(2, "0")}`,
        platform,
        scenario: index <= 5 ? "ordinary" : index <= 7 ? "login" : index <= 9 ? "collection" : "invalid",
        expectation: index === 10 ? "error" : "downloadable",
        expectedError: index === 10 ? "removed" : undefined,
        urlSource: `DOWNANY_${platform.toUpperCase()}_${String(index).padStart(2, "0")}`,
      });
    }
  }
  return rows;
}

function passingResults(rows, targets = ["macos-arm64", "windows-x64"]) {
  return targets.flatMap((target) => rows.map((row) => ({
    id: row.id,
    target,
    outcome: row.expectation === "error" ? "expected_error" : "completed",
    errorCode: row.expectedError,
    artifactPlayable: row.expectation === "downloadable",
    candidateSha256: (target === "macos-arm64" ? "a" : "b").repeat(64),
  })));
}

test("accepts a 30-case matrix balanced across three priority platforms and required scenarios", () => {
  assert.deepEqual(validateReliabilityMatrix(matrix()), {
    total: 30,
    byPlatform: { youtube: 10, bilibili: 10, douyin: 10 },
  });
});

test("rejects a matrix that cannot prove one priority platform", () => {
  assert.throws(
    () => validateReliabilityMatrix(matrix().filter((row) => row.platform !== "douyin")),
    /30 cases/,
  );
});

test("passes only when downloadable cases reach 90 percent per platform and errors match", () => {
  const rows = matrix();
  const results = passingResults(rows);

  const report = evaluateReliabilityResults(rows, results);

  assert.equal(report.passed, true);
  assert.deepEqual(
    Object.fromEntries(Object.entries(report.targets["macos-arm64"].platforms).map(([key, value]) => [key, value.successRate])),
    { youtube: 1, bilibili: 1, douyin: 1 },
  );
  assert.equal(report.targets["windows-x64"].platforms.youtube.successRate, 1);
});

test("does not accept macOS evidence as Windows evidence", () => {
  const rows = matrix();
  const report = evaluateReliabilityResults(rows, passingResults(rows, ["macos-arm64"]));

  assert.equal(report.passed, false);
  assert.match(report.failures.join("\n"), /windows-x64.*missing/i);
});

test("fails the release gate when one platform drops below 90 percent", () => {
  const rows = matrix();
  const results = passingResults(rows);
  for (const id of ["youtube-01", "youtube-02"]) {
    const result = results.find((item) => item.id === id && item.target === "windows-x64");
    result.outcome = "failed";
    result.artifactPlayable = false;
  }

  const report = evaluateReliabilityResults(rows, results);

  assert.equal(report.passed, false);
  assert.equal(report.targets["windows-x64"].platforms.youtube.successRate, 7 / 9);
  assert.match(report.failures.join("\n"), /windows-x64.*youtube.*90%/i);
});

test("does not count an incorrect error classification as a successful negative case", () => {
  const rows = matrix();
  const results = passingResults(rows);
  results.find((item) => item.id === "bilibili-10" && item.target === "macos-arm64").errorCode = "network";

  const report = evaluateReliabilityResults(rows, results);

  assert.equal(report.passed, false);
  assert.match(report.failures.join("\n"), /macos-arm64.*bilibili-10.*removed/);
});

test("rejects duplicate case evidence for the same target", () => {
  const rows = matrix();
  const results = passingResults(rows);
  results.push({ ...results[0] });

  const report = evaluateReliabilityResults(rows, results);

  assert.equal(report.passed, false);
  assert.match(report.failures.join("\n"), /duplicate.*macos-arm64.*youtube-01/i);
});

test("rejects evidence that mixes candidate packages for one target", () => {
  const rows = matrix();
  const results = passingResults(rows);
  results.find((item) => item.target === "macos-arm64").candidateSha256 = "c".repeat(64);

  const report = evaluateReliabilityResults(rows, results);

  assert.equal(report.passed, false);
  assert.match(report.failures.join("\n"), /macos-arm64.*candidate/i);
});
