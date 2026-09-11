import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  buildSanitizedCaseResult,
  mergeTargetResults,
  parseMatrixRunArguments,
  resolveMatrixCases,
} from "./v031_matrix_run_helpers.mjs";

const absolute = (name) => path.resolve("/tmp", name);

test("requires explicit candidate, target, matrix and evidence paths", () => {
  const parsed = parseMatrixRunArguments([
    `--executable=${absolute("Downany")}`,
    `--candidate-artifact=${absolute("Downany.dmg")}`,
    `--playwright-module=${absolute("playwright")}`,
    `--matrix=${absolute("matrix.json")}`,
    `--results=${absolute("results.json")}`,
    "--target=macos-arm64",
    "--expected-version=0.3.1",
  ]);
  assert.equal(parsed.target, "macos-arm64");
  assert.equal(parsed.expectedVersion, "0.3.1");
  assert.equal(parsed.candidateArtifact, absolute("Downany.dmg"));
  assert.equal(parsed.timeoutMs, 15 * 60_000);
  assert.throws(() => parseMatrixRunArguments([]), /required/i);
  assert.throws(() => parseMatrixRunArguments([
    `--executable=${absolute("Downany")}`,
    `--candidate-artifact=${absolute("Downany.dmg")}`,
    `--playwright-module=${absolute("playwright")}`,
    `--matrix=${absolute("matrix.json")}`,
    `--results=${absolute("results.json")}`,
    "--target=linux-x64",
  ]), /target/i);
});

test("resolves URLs only in memory and reports missing environment keys", () => {
  const rows = [
    { id: "youtube-01", urlSource: "DOWNANY_YOUTUBE_01" },
    { id: "youtube-02", urlSource: "DOWNANY_YOUTUBE_02" },
  ];
  const resolved = resolveMatrixCases(rows, { DOWNANY_YOUTUBE_01: "https://secret.invalid/one" });
  assert.equal(resolved.cases[0].url, "https://secret.invalid/one");
  assert.deepEqual(resolved.missing, ["DOWNANY_YOUTUBE_02"]);
  assert.doesNotMatch(JSON.stringify(resolved.missing), /secret\.invalid/);
});

test("case evidence excludes URLs, private paths and raw errors", () => {
  const result = buildSanitizedCaseResult({
    target: "windows-x64",
    candidateSha256: "b".repeat(64),
    row: { id: "youtube-01", expectation: "downloadable" },
    task: {
      status: "completed",
      error_code: "",
      error_message: "Cookie: secret https://private.invalid",
      file_path: "C:\\Users\\private\\movie.mp4",
    },
    artifact: { playable: true, sha256: "a".repeat(64), bytes: 1234 },
    recordedAt: "2026-09-11T00:00:00.000Z",
  });
  assert.deepEqual(result, {
    target: "windows-x64",
    candidateSha256: "b".repeat(64),
    id: "youtube-01",
    outcome: "completed",
    errorCode: "",
    artifactPlayable: true,
    artifactSha256: "a".repeat(64),
    artifactBytes: 1234,
    recordedAt: "2026-09-11T00:00:00.000Z",
  });
  assert.doesNotMatch(JSON.stringify(result), /private|Cookie|Users/i);
});

test("merges resumable target evidence without duplicates", () => {
  const existing = [
    { target: "macos-arm64", id: "youtube-01", outcome: "failed", candidateSha256: "a".repeat(64), url: "https://secret.invalid", rawError: "Cookie: private" },
    { target: "windows-x64", id: "youtube-01", outcome: "completed", candidateSha256: "c".repeat(64) },
  ];
  const merged = mergeTargetResults(existing, [
    { target: "macos-arm64", id: "youtube-01", outcome: "completed", candidateSha256: "b".repeat(64) },
    { target: "macos-arm64", id: "youtube-02", outcome: "completed", candidateSha256: "b".repeat(64) },
  ]);
  assert.equal(merged.length, 3);
  assert.equal(merged.find((item) => item.target === "macos-arm64" && item.id === "youtube-01").outcome, "completed");
  assert.equal(merged.find((item) => item.target === "windows-x64").outcome, "completed");
  assert.ok(merged.filter((item) => item.target === "macos-arm64").every((item) => item.candidateSha256 === "b".repeat(64)));
  assert.doesNotMatch(JSON.stringify(merged), /secret|Cookie|rawError/i);
});
