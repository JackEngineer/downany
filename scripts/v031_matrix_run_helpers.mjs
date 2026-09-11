import assert from "node:assert/strict";
import path from "node:path";

const TARGETS = new Set(["macos-arm64", "windows-x64"]);

export function parseMatrixRunArguments(rawArguments) {
  const allowed = new Set([
    "--executable", "--candidate-artifact", "--playwright-module", "--matrix", "--results", "--target",
    "--expected-version", "--cookiefile", "--case", "--timeout-minutes",
  ]);
  const args = new Map();
  for (const argument of rawArguments) {
    const separator = argument.indexOf("=");
    assert.ok(separator > 0, "Use --name=value arguments");
    const name = argument.slice(0, separator);
    const value = argument.slice(separator + 1);
    assert.ok(allowed.has(name) && !args.has(name) && value, `Unknown, duplicate or empty argument: ${name}`);
    args.set(name, value);
  }
  const required = ["--executable", "--candidate-artifact", "--playwright-module", "--matrix", "--results", "--target"];
  assert.ok(required.every((name) => args.has(name)), "Candidate, Playwright, matrix, results and target are required");
  const target = args.get("--target");
  assert.ok(TARGETS.has(target), "Target must be macos-arm64 or windows-x64");
  for (const name of ["--executable", "--candidate-artifact", "--playwright-module", "--matrix", "--results", "--cookiefile"]) {
    if (args.has(name)) assert.ok(path.isAbsolute(args.get(name)), `${name} must be absolute`);
  }
  const expectedVersion = args.get("--expected-version") || "0.3.1";
  assert.match(expectedVersion, /^\d+\.\d+\.\d+$/, "Expected version must be major.minor.patch");
  const timeoutMinutes = Number(args.get("--timeout-minutes") || 15);
  assert.ok(Number.isFinite(timeoutMinutes) && timeoutMinutes >= 1 && timeoutMinutes <= 120, "Timeout must be 1-120 minutes");
  return {
    executable: args.get("--executable"),
    candidateArtifact: args.get("--candidate-artifact"),
    playwrightModule: args.get("--playwright-module"),
    matrixPath: args.get("--matrix"),
    resultsPath: args.get("--results"),
    target,
    expectedVersion,
    cookiefile: args.get("--cookiefile") || "",
    caseId: args.get("--case") || "",
    timeoutMs: timeoutMinutes * 60_000,
  };
}

export function resolveMatrixCases(rows, environment) {
  const missing = [];
  const cases = [];
  for (const row of rows) {
    const url = String(environment[row.urlSource] || "").trim();
    if (!url) missing.push(row.urlSource);
    else cases.push({ row, url });
  }
  return { cases, missing };
}

export function buildSanitizedCaseResult({ target, candidateSha256, row, task, artifact, recordedAt }) {
  const completed = task?.status === "completed" && artifact?.playable === true;
  const expectedError = row.expectation === "error" && task?.status === "failed";
  return {
    target,
    candidateSha256,
    id: row.id,
    outcome: completed ? "completed" : expectedError ? "expected_error" : "failed",
    errorCode: String(task?.error_code || ""),
    artifactPlayable: completed,
    ...(completed ? {
      artifactSha256: artifact.sha256,
      artifactBytes: artifact.bytes,
    } : {}),
    recordedAt,
  };
}

export function mergeTargetResults(existing, updates) {
  const candidateByTarget = new Map();
  for (const item of updates) {
    assert.match(item.candidateSha256 || "", /^[a-f0-9]{64}$/, "Updated evidence requires candidate SHA-256");
    const previous = candidateByTarget.get(item.target);
    assert.ok(!previous || previous === item.candidateSha256, "Updates cannot mix candidate packages for one target");
    candidateByTarget.set(item.target, item.candidateSha256);
  }
  const merged = new Map();
  const compatibleExisting = existing.filter((item) => {
    const current = candidateByTarget.get(item.target);
    return !current || item.candidateSha256 === current;
  });
  for (const item of [...compatibleExisting, ...updates]) {
    const safe = {
      target: item.target,
      candidateSha256: item.candidateSha256,
      id: item.id,
      outcome: item.outcome,
      errorCode: String(item.errorCode || ""),
      artifactPlayable: item.artifactPlayable === true,
      ...(typeof item.artifactSha256 === "string" ? { artifactSha256: item.artifactSha256 } : {}),
      ...(Number.isFinite(item.artifactBytes) ? { artifactBytes: item.artifactBytes } : {}),
      ...(typeof item.recordedAt === "string" ? { recordedAt: item.recordedAt } : {}),
    };
    merged.set(`${safe.target}:${safe.id}`, safe);
  }
  return [...merged.values()].sort((a, b) =>
    `${a.target}:${a.id}`.localeCompare(`${b.target}:${b.id}`));
}
