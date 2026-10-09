import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as runHelpers from "./v031_matrix_run_helpers.mjs";

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
    "--cookies-from-browser=chrome",
  ]);
  assert.equal(parsed.target, "macos-arm64");
  assert.equal(parsed.expectedVersion, "0.3.1");
  assert.equal(parsed.candidateArtifact, absolute("Downany.dmg"));
  assert.equal(parsed.cookiesFromBrowser, "chrome");
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
  assert.throws(() => parseMatrixRunArguments([
    `--executable=${absolute("Downany")}`,
    `--candidate-artifact=${absolute("Downany.dmg")}`,
    `--playwright-module=${absolute("playwright")}`,
    `--matrix=${absolute("matrix.json")}`,
    `--results=${absolute("results.json")}`,
    "--target=macos-arm64",
    "--cookies-from-browser=chrome:Default",
  ]), /browser name/i);
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

test("collection parse failure evidence preserves only the fixed stage without inventing a task", () => {
  const result = buildSanitizedCaseResult({
    target: "macos-arm64", candidateSha256: "b".repeat(64), sampleSha256: "c".repeat(64),
    row: { id: "douyin-08", scenario: "collection", expectation: "downloadable" },
    failureStage: "collection_parse", rawError: "Cookie: secret", recordedAt: "2026-09-27T09:00:00.000Z",
  });
  assert.equal(result.failureStage, "collection_parse");
  assert.equal(result.outcome, "failed");
  assert.equal(result.artifactPlayable, false);
  assert.equal(result.errorCode, "");
  assert.deepEqual(mergeTargetResults([], [result]), [result]);
  assert.doesNotMatch(JSON.stringify(result), /Cookie|secret|rawError|taskId/);
});

test("unrecognized or contradictory failure stages are dropped at evidence boundaries", () => {
  for (const item of [
    { failureStage: "Cookie: secret" },
    { failureStage: "collection_parse", outcome: "completed", artifactPlayable: true },
  ]) {
    const merged = mergeTargetResults([], [{ target: "macos-arm64", candidateSha256: "b".repeat(64),
      id: "douyin-08", outcome: "failed", artifactPlayable: false, ...item }]);
    assert.equal(merged[0].failureStage, undefined);
  }
});

const loginRow = { id: "bilibili-06", scenario: "login", expectation: "downloadable" };
const candidateSha256 = "b".repeat(64);
const instanceIds = ["1df90a84-3026-4851-bf4a-9a0432d7fb78", "441fd46b-dd84-48e7-a380-0a3dc8b6f56c"];
const attempts = [
  { task: { status: "failed", error_code: "need_login", error_message: "This video is only available for registered users" },
    artifact: { playable: false }, instanceId: instanceIds[0], recordedAt: "2026-09-27T06:00:00.000Z" },
  { task: { status: "completed", error_code: "" },
    artifact: { playable: true, sha256: "c".repeat(64), bytes: 1234 }, instanceId: instanceIds[1], recordedAt: "2026-09-27T06:01:00.000Z" },
];

test("login collection pairs the same URL in anonymous then authorized isolated attempts", async () => {
  assert.equal(typeof runHelpers.collectMatrixCase, "function");
  const calls = [];
  const result = await runHelpers.collectMatrixCase({
    target: "macos-arm64", candidateSha256, row: loginRow,
    url: "https://private.invalid/sample", credentialSource: "browser",
    runAttempt: async (input) => {
      calls.push(input);
      return structuredClone(attempts[calls.length - 1]);
    },
  });
  assert.deepEqual(calls.map(({ credentialSource, phase, url }) => ({ credentialSource, phase, url })), [
    { credentialSource: "none", phase: "anonymous", url: "https://private.invalid/sample" },
    { credentialSource: "browser", phase: "authorized", url: "https://private.invalid/sample" },
  ]);
  assert.equal(result.outcome, "completed");
  assert.equal(result.loginEvidence.caseId, "bilibili-06");
  assert.equal(result.loginEvidence.anonymous.restriction, "registered_users");
  assert.equal(result.loginEvidence.anonymous.instanceId, instanceIds[0]);
  assert.equal(result.loginEvidence.authorized.instanceId, instanceIds[1]);
  assert.equal(result.loginEvidence.authorized.artifactSha256, "c".repeat(64));
  assert.equal(result.sampleSha256, result.loginEvidence.sampleSha256);
  const merged = mergeTargetResults([], [result]);
  assert.deepEqual(merged[0].loginEvidence, result.loginEvidence);
  assert.equal(merged[0].sampleSha256, result.sampleSha256);
  assert.doesNotMatch(JSON.stringify(merged), /private\.invalid|error_message|only available/);
});

test("anonymous success and challenge failures never trigger credential reads", async () => {
  assert.equal(typeof runHelpers.collectMatrixCase, "function");
  for (const task of [
    { status: "completed", error_code: "" },
    { status: "failed", error_code: "need_login", error_message: "Sign in to confirm you're not a bot" },
    { status: "failed", error_code: "need_login", error_message: "Fresh cookies (not necessarily logged in) are needed" },
  ]) {
    let callCount = 0;
    const result = await runHelpers.collectMatrixCase({
      target: "macos-arm64", candidateSha256, row: loginRow,
      url: "https://private.invalid/sample", credentialSource: "browser",
      runAttempt: async ({ credentialSource }) => {
        assert.equal(credentialSource, "none");
        callCount++;
        return { ...attempts[0], task, artifact: { playable: false } };
      },
    });
    assert.equal(callCount, 1);
    assert.equal(result.loginEvidence.authorized, null);
  }
});

test("ordinary samples keep one configured attempt and do not claim login evidence", async () => {
  assert.equal(typeof runHelpers.collectMatrixCase, "function");
  const calls = [];
  const result = await runHelpers.collectMatrixCase({
    target: "macos-arm64", candidateSha256, row: { ...loginRow, scenario: "ordinary" },
    url: "https://private.invalid/sample", credentialSource: "none",
    runAttempt: async (input) => { calls.push(input); return attempts[1]; },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].credentialSource, "none");
  assert.equal(result.outcome, "completed");
  assert.equal(result.loginEvidence, undefined);
});

test("login collection rejects missing credential source before starting attempts", async () => {
  assert.equal(typeof runHelpers.collectMatrixCase, "function");
  let called = false;
  await assert.rejects(() => runHelpers.collectMatrixCase({
    target: "macos-arm64", candidateSha256, row: loginRow,
    url: "https://private.invalid/sample", credentialSource: "none",
    runAttempt: async () => { called = true; },
  }), /credential source/i);
  assert.equal(called, false);
});

test("credential readback rejects inherited or mismatched settings without echoing secrets", () => {
  assert.equal(typeof runHelpers.assertCredentialSettings, "function");
  runHelpers.assertCredentialSettings({ cookies_from_browser: "", cookiefile: "" }, { cookiesFromBrowser: "", cookiefile: "" });
  runHelpers.assertCredentialSettings({ cookies_from_browser: "firefox", cookiefile: "" }, { cookiesFromBrowser: "firefox", cookiefile: "" });
  for (const settings of [
    { cookies_from_browser: "chrome", cookiefile: "" },
    { cookies_from_browser: "", cookiefile: "/private/secret-cookies.txt" },
    {},
  ]) {
    assert.throws(() => runHelpers.assertCredentialSettings(settings, { cookiesFromBrowser: "", cookiefile: "" }), (error) => {
      assert.match(error.message, /credential settings/i);
      assert.doesNotMatch(error.message, /chrome|secret-cookies/);
      return true;
    });
  }
});

test("matrix runner rejects ambiguous dual credential sources", () => {
  assert.throws(() => parseMatrixRunArguments([
    `--executable=${absolute("Downany")}`, `--candidate-artifact=${absolute("Downany.dmg")}`,
    `--playwright-module=${absolute("playwright")}`, `--matrix=${absolute("matrix.json")}`,
    `--results=${absolute("results.json")}`, "--target=macos-arm64",
    "--cookies-from-browser=chrome", `--cookiefile=${absolute("cookies.txt")}`,
  ]), /one credential source/i);
});

test("failed data cleanup still removes the isolated browser profile and propagates failure", (t) => {
  assert.equal(typeof runHelpers.removeAttemptState, "function");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "downany-state-cleanup-test-"));
  const directories = { dataDir: path.join(root, "data"), profileDir: path.join(root, "profile") };
  fs.mkdirSync(directories.dataDir);
  fs.mkdirSync(directories.profileDir);
  const remove = fs.rmSync;
  t.after(() => { t.mock.restoreAll(); remove(root, { recursive: true, force: true }); });
  t.mock.method(fs, "rmSync", (directory, options) => {
    if (directory === directories.dataDir) throw new Error("fixture directory busy");
    remove(directory, options);
  });
  assert.throws(() => runHelpers.removeAttemptState(directories), /busy/);
  assert.equal(fs.existsSync(directories.dataDir), true);
  assert.equal(fs.existsSync(directories.profileDir), false);
});
