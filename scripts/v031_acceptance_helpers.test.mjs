import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import test from "node:test";

import {
  evaluateReliabilityResults as evaluateReviewedResults,
  validateReliabilityMatrix,
} from "./v031_acceptance_helpers.mjs";
import { createSyntheticSampleIndependenceReview, syntheticBilibiliAliases } from "./fixtures/v031_sample_independence.mjs";

const evaluateReliabilityResults = (rows, results) => evaluateReviewedResults(rows, results, {
  loadReview: createSyntheticSampleIndependenceReview,
});

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
  return targets.flatMap((target) => rows.map((row) => {
    const result = {
      id: row.id,
      target,
      outcome: row.expectation === "error" ? "expected_error" : "completed",
      errorCode: row.expectedError,
      artifactPlayable: row.expectation === "downloadable",
      candidateSha256: (target === "macos-arm64" ? "a" : "b").repeat(64),
      sampleSha256: createHash("sha256").update(row.id).digest("hex"),
    };
    if (row.scenario === "login") {
      Object.assign(result, {
        artifactSha256: "d".repeat(64),
        artifactBytes: 1024,
        recordedAt: "2026-09-27T12:01:00.000Z",
      });
      result.loginEvidence = {
        schemaVersion: 1,
        source: "paired-candidate-runs",
        caseId: row.id,
        target,
        candidateSha256: result.candidateSha256,
        sampleSha256: result.sampleSha256,
        anonymous: {
          outcome: "authentication_required",
          restriction: "registered_users",
          credentialSource: "none",
          instanceId: "11111111-1111-4111-8111-111111111111",
          recordedAt: "2026-09-27T12:00:00.000Z",
        },
        authorized: {
          credentialSource: "browser",
          instanceId: "22222222-2222-4222-8222-222222222222",
          recordedAt: result.recordedAt,
          artifactSha256: result.artifactSha256,
        },
      };
    }
    return result;
  }));
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

test("keeps historical completed downloads but excludes unpaired login evidence from the gate", () => {
  const rows = matrix();
  const results = passingResults(rows);
  for (const result of results) delete result.loginEvidence;
  const before = structuredClone(results);

  const report = evaluateReliabilityResults(rows, results);

  assert.equal(report.passed, false);
  assert.deepEqual(results, before);
  for (const target of ["macos-arm64", "windows-x64"]) {
    for (const platform of ["youtube", "bilibili", "douyin"]) {
      assert.deepEqual(report.targets[target].platforms[platform], {
        completed: 7,
        total: 9,
        successRate: 7 / 9,
      });
    }
  }
  assert.equal(report.failures.filter((failure) => failure.includes("paired login evidence")).length, 12);
});

test("requires valid paired evidence for every downloadable login row on both targets", () => {
  const rows = matrix();
  for (const target of ["macos-arm64", "windows-x64"]) {
    for (const row of rows.filter((item) => item.scenario === "login")) {
      const results = passingResults(rows);
      delete results.find((result) => result.id === row.id && result.target === target).loginEvidence;

      const report = evaluateReliabilityResults(rows, results);

      assert.equal(report.passed, false, `${target} ${row.id}`);
      assert.ok(report.failures.includes(`${target} ${row.id} must provide valid paired login evidence`));
      assert.equal(report.targets[target].platforms[row.platform].completed, 8);
      assert.equal(report.targets[target].platforms[row.platform].total, 9);
    }
  }
});

for (const [field, value] of [
  ["caseId", "youtube-07"],
  ["sampleSha256", "e".repeat(64)],
  ["candidateSha256", "f".repeat(64)],
  ["target", "macos-arm64"],
]) {
  test(`rejects a login pair whose ${field} differs from the completed result`, () => {
    const rows = matrix();
    const results = passingResults(rows);
    const result = results.find((item) => item.id === "youtube-06" && item.target === "windows-x64");
    result.loginEvidence[field] = value;

    const report = evaluateReliabilityResults(rows, results);

    assert.equal(report.passed, false);
    assert.ok(report.failures.includes("windows-x64 youtube-06 must provide valid paired login evidence"));
    assert.deepEqual(report.targets["windows-x64"].platforms.youtube, {
      completed: 8,
      total: 9,
      successRate: 8 / 9,
    });
    assert.equal(result.outcome, "completed");
  });
}

for (const [label, sampleSha256] of [
  ["missing", undefined],
  ["empty", ""],
  ["invalid", "PRIVATE sample URL or error"],
  ["uppercase", "A".repeat(64)],
  ["non-string", ["a".repeat(64)]],
]) {
  test(`excludes a completed download with ${label} sample identity without exposing its value`, () => {
    const rows = matrix();
    const results = passingResults(rows);
    const result = results.find((item) => item.target === "macos-arm64" && item.id === "youtube-01");
    result.sampleSha256 = sampleSha256;
    const before = structuredClone(results);

    const report = evaluateReliabilityResults(rows, results);

    assert.equal(report.passed, false);
    assert.equal(report.targets["macos-arm64"].platforms.youtube.completed, 8);
    assert.equal(report.targets["windows-x64"].platforms.youtube.completed, 9);
    assert.match(report.failures.join("\n"), /macos-arm64 youtube-01.*sample identity/);
    assert.doesNotMatch(report.failures.join("\n"), /PRIVATE/);
    assert.doesNotMatch(report.failures.join("\n"), /same sample SHA-256/);
    assert.deepEqual(results, before);
  });
}

test("requires verifiable sample identity even when a negative case returns the expected error", () => {
  const rows = matrix();
  const results = passingResults(rows);
  delete results.find((item) => item.target === "macos-arm64" && item.id === "youtube-10").sampleSha256;

  const report = evaluateReliabilityResults(rows, results);

  assert.equal(report.passed, false);
  assert.match(report.failures.join("\n"), /macos-arm64 youtube-10.*sample identity/);
  assert.equal(report.targets["macos-arm64"].platforms.youtube.completed, 9);
});

test("excludes every case sharing one sample within a target without depending on input order", () => {
  const rows = matrix();
  const results = passingResults(rows);
  for (const target of ["macos-arm64", "windows-x64"]) {
    const first = results.find((item) => item.target === target && item.id === "youtube-01");
    results.find((item) => item.target === target && item.id === "youtube-02").sampleSha256 = first.sampleSha256;
  }
  const before = structuredClone(results);

  for (const ordered of [results, [...results].reverse()]) {
    const report = evaluateReliabilityResults(rows, ordered);
    assert.equal(report.passed, false);
    for (const target of ["macos-arm64", "windows-x64"]) {
      assert.deepEqual(report.targets[target].platforms.youtube, { completed: 7, total: 9, successRate: 7 / 9 });
      assert.match(report.failures.join("\n"), new RegExp(`${target}.*sample.*reused.*youtube-01.*youtube-02`));
      assert.equal(report.targets[target].platforms.bilibili.completed, 9);
    }
  }
  assert.deepEqual(results, before);
});

test("does not treat a valid login pair as a distinct sample when another scenario uses the same sample", () => {
  const rows = matrix();
  const results = passingResults(rows);
  for (const target of ["macos-arm64", "windows-x64"]) {
    const login = results.find((item) => item.target === target && item.id === "youtube-06");
    results.find((item) => item.target === target && item.id === "youtube-01").sampleSha256 = login.sampleSha256;
  }

  const report = evaluateReliabilityResults(rows, results);

  assert.equal(report.passed, false);
  for (const target of ["macos-arm64", "windows-x64"]) {
    assert.equal(report.targets[target].platforms.youtube.completed, 7);
    assert.match(report.failures.join("\n"), new RegExp(`${target}.*sample.*reused.*youtube-01.*youtube-06`));
  }
  assert.doesNotMatch(report.failures.join("\n"), /paired login evidence/);
});

test("excludes both targets when the same case uses different valid samples", () => {
  const rows = matrix();
  const results = passingResults(rows);
  results.find((item) => item.target === "windows-x64" && item.id === "youtube-01").sampleSha256 = "e".repeat(64);

  const report = evaluateReliabilityResults(rows, results);

  assert.equal(report.passed, false);
  assert.match(report.failures.join("\n"), /youtube-01.*same sample SHA-256.*both targets/);
  for (const target of ["macos-arm64", "windows-x64"]) {
    assert.equal(report.targets[target].platforms.youtube.completed, 8);
  }
});

test("keeps historical results unchanged but cannot certify independent samples without their identities", () => {
  const rows = matrix();
  const results = passingResults(rows);
  for (const result of results) delete result.sampleSha256;
  const before = structuredClone(results);

  const report = evaluateReliabilityResults(rows, results);

  assert.equal(report.passed, false);
  assert.equal(report.failures.filter((failure) => failure.includes("sample identity")).length, 60);
  for (const target of ["macos-arm64", "windows-x64"]) {
    for (const platform of ["youtube", "bilibili", "douyin"]) {
      assert.deepEqual(report.targets[target].platforms[platform], { completed: 0, total: 9, successRate: 0 });
    }
  }
  assert.deepEqual(results, before);
});

test("injected independence review excludes synthetic aliases without rewriting downloads", () => {
  const rows = matrix();
  const results = passingResults(rows);
  for (const target of ["macos-arm64", "windows-x64"]) {
    for (const [index, id] of ["bilibili-01", "bilibili-03"].entries()) {
      const result = results.find((item) => item.target === target && item.id === id);
      result.sampleSha256 = syntheticBilibiliAliases[index];
      result.sampleIndependenceReview = { status: "passed" }; // A row cannot override the default review.
    }
  }
  const before = structuredClone(results);
  for (const ordered of [results, [...results].reverse()]) {
    const report = evaluateReliabilityResults(rows, ordered);
    assert.equal(report.passed, false);
    for (const target of ["macos-arm64", "windows-x64"]) {
      assert.equal(report.targets[target].platforms.bilibili.completed, 7);
      assert.match(report.failures.join("\n"), new RegExp(`${target}.*independence review.*bilibili-01.*bilibili-03`));
    }
  }
  assert.deepEqual(results, before);
});

test("a genuinely rerun replacement URL hash does not inherit a previous alias exclusion", () => {
  const rows = matrix();
  const results = passingResults(rows);
  for (const target of ["macos-arm64", "windows-x64"]) {
    results.find((item) => item.target === target && item.id === "bilibili-01").sampleSha256 = syntheticBilibiliAliases[0];
  }
  assert.equal(evaluateReliabilityResults(rows, results).passed, true);
});

test("default acceptance evaluation fails closed when the real review is missing", (t) => {
  t.mock.method(fs, "readFileSync", () => { throw new Error("PRIVATE PATH"); });
  assert.throws(() => evaluateReviewedResults(matrix(), []), /^Error: Sample independence review is missing or invalid$/);
});

test("acceptance evaluation rejects an invalid injected review", () => {
  assert.throws(() => evaluateReviewedResults(matrix(), [], {
    loadReview: () => ({ schemaVersion: 1, groups: [] }),
  }), /^Error: Sample independence review is missing or invalid$/);
});
