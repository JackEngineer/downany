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
  const results = rows.map((row) => ({
    id: row.id,
    outcome: row.expectation === "error" ? "expected_error" : "completed",
    errorCode: row.expectedError,
    artifactPlayable: row.expectation === "downloadable",
  }));

  const report = evaluateReliabilityResults(rows, results);

  assert.equal(report.passed, true);
  assert.deepEqual(
    Object.fromEntries(Object.entries(report.platforms).map(([key, value]) => [key, value.successRate])),
    { youtube: 1, bilibili: 1, douyin: 1 },
  );
});

test("fails the release gate when one platform drops below 90 percent", () => {
  const rows = matrix();
  const results = rows.map((row) => ({
    id: row.id,
    outcome: row.expectation === "error" ? "expected_error" : "completed",
    errorCode: row.expectedError,
    artifactPlayable: row.expectation === "downloadable",
  }));
  for (const id of ["youtube-01", "youtube-02"]) {
    const result = results.find((item) => item.id === id);
    result.outcome = "failed";
    result.artifactPlayable = false;
  }

  const report = evaluateReliabilityResults(rows, results);

  assert.equal(report.passed, false);
  assert.equal(report.platforms.youtube.successRate, 7 / 9);
  assert.match(report.failures.join("\n"), /youtube.*90%/i);
});

test("does not count an incorrect error classification as a successful negative case", () => {
  const rows = matrix();
  const results = rows.map((row) => ({
    id: row.id,
    outcome: row.expectation === "error" ? "expected_error" : "completed",
    errorCode: row.expectedError,
    artifactPlayable: row.expectation === "downloadable",
  }));
  results.find((item) => item.id === "bilibili-10").errorCode = "network";

  const report = evaluateReliabilityResults(rows, results);

  assert.equal(report.passed, false);
  assert.match(report.failures.join("\n"), /bilibili-10.*removed/);
});
