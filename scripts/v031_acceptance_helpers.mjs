import { evaluateLoginEvidence } from "./v031_login_evidence.mjs";
import { findReviewedSampleConflicts } from "./v031_sample_independence.mjs";

const PLATFORMS = ["youtube", "bilibili", "douyin"];
const REQUIRED_SCENARIOS = ["ordinary", "login", "collection", "invalid"];
const TARGETS = ["macos-arm64", "windows-x64"];

function isSampleSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function validateReliabilityMatrix(rows) {
  if (!Array.isArray(rows) || rows.length !== 30) {
    throw new Error("Reliability matrix must contain exactly 30 cases");
  }
  const ids = new Set();
  const byPlatform = {};
  for (const platform of PLATFORMS) {
    const platformRows = rows.filter((row) => row.platform === platform);
    if (platformRows.length !== 10) {
      throw new Error(`Reliability matrix must contain 10 ${platform} cases`);
    }
    for (const scenario of REQUIRED_SCENARIOS) {
      if (!platformRows.some((row) => row.scenario === scenario)) {
        throw new Error(`${platform} matrix is missing ${scenario}`);
      }
    }
    byPlatform[platform] = platformRows.length;
  }
  for (const row of rows) {
    if (!row.id || ids.has(row.id)) throw new Error(`Duplicate or empty case id: ${row.id || "<empty>"}`);
    ids.add(row.id);
    if (!row.urlSource) throw new Error(`${row.id} is missing urlSource`);
    if (row.expectation === "error" && !row.expectedError) {
      throw new Error(`${row.id} is missing expectedError`);
    }
    if (row.expectation !== "error" && row.expectation !== "downloadable") {
      throw new Error(`${row.id} has an invalid expectation`);
    }
  }
  return { total: rows.length, byPlatform };
}

export function evaluateReliabilityResults(rows, results) {
  validateReliabilityMatrix(rows);
  const failures = [];
  const rowIds = new Set(rows.map((row) => row.id));
  const byTargetAndId = new Map();
  for (const result of Array.isArray(results) ? results : []) {
    if (!TARGETS.includes(result?.target)) {
      failures.push(`Unknown result target: ${result?.target || "<missing>"}`);
      continue;
    }
    if (!rowIds.has(result?.id)) {
      failures.push(`Unknown result id: ${result?.id || "<missing>"}`);
      continue;
    }
    const key = `${result.target}:${result.id}`;
    if (byTargetAndId.has(key)) {
      failures.push(`Duplicate result for ${result.target} ${result.id}`);
      continue;
    }
    byTargetAndId.set(key, result);
  }

  const unverifiedSampleKeys = new Set();
  for (const conflict of findReviewedSampleConflicts([...byTargetAndId.values()])) {
    failures.push(`${conflict.target} sample independence review rejected duplicate content: ${conflict.ids.join(", ")}`);
    for (const id of conflict.ids) unverifiedSampleKeys.add(`${conflict.target}:${id}`);
  }
  for (const target of TARGETS) {
    const bySample = new Map();
    for (const row of rows) {
      const key = `${target}:${row.id}`;
      const result = byTargetAndId.get(key);
      if (!result) continue;
      if (!isSampleSha256(result.sampleSha256)) {
        failures.push(`${target} ${row.id} must provide a valid sample SHA-256 to verify sample identity`);
        unverifiedSampleKeys.add(key);
        continue;
      }
      const ids = bySample.get(result.sampleSha256) || [];
      ids.push(row.id);
      bySample.set(result.sampleSha256, ids);
    }
    for (const ids of bySample.values()) {
      if (ids.length < 2) continue;
      failures.push(`${target} sample SHA-256 is reused by different cases: ${ids.join(", ")}`);
      // 无法按行序任选一个用例作为独立样本；整组保留历史但不计入通过数。
      for (const id of ids) unverifiedSampleKeys.add(`${target}:${id}`);
    }
  }
  for (const row of rows) {
    const hashes = new Set(TARGETS
      .map((target) => byTargetAndId.get(`${target}:${row.id}`)?.sampleSha256)
      .filter(isSampleSha256));
    if (hashes.size > 1) {
      failures.push(`${row.id} must use the same sample SHA-256 on both targets`);
      for (const target of TARGETS) unverifiedSampleKeys.add(`${target}:${row.id}`);
    }
  }

  const targets = {};
  for (const target of TARGETS) {
    const candidateHashes = new Set(
      [...byTargetAndId.values()]
        .filter((result) => result.target === target && /^[a-f0-9]{64}$/.test(result.candidateSha256 || ""))
        .map((result) => result.candidateSha256),
    );
    const targetResults = [...byTargetAndId.values()].filter((result) => result.target === target);
    if (targetResults.some((result) => !/^[a-f0-9]{64}$/.test(result.candidateSha256 || "")) || candidateHashes.size !== 1) {
      failures.push(`${target} evidence must identify exactly one candidate package`);
    }
    const missing = rows.filter((row) => !byTargetAndId.has(`${target}:${row.id}`));
    if (missing.length) {
      failures.push(`${target} missing evidence for: ${missing.map((row) => row.id).join(", ")}`);
    }

    for (const row of rows.filter((item) => item.expectation === "error")) {
      const result = byTargetAndId.get(`${target}:${row.id}`);
      if (result?.outcome !== "expected_error" || result.errorCode !== row.expectedError) {
        failures.push(`${target} ${row.id} must return ${row.expectedError}`);
      }
    }

    const qualifiedLoginIds = new Set();
    for (const row of rows.filter((item) => item.scenario === "login" && item.expectation === "downloadable")) {
      const result = byTargetAndId.get(`${target}:${row.id}`);
      if (evaluateLoginEvidence(result)) {
        qualifiedLoginIds.add(row.id);
      } else {
        failures.push(`${target} ${row.id} must provide valid paired login evidence`);
      }
    }

    const platforms = {};
    for (const platform of PLATFORMS) {
      const downloadable = rows.filter(
        (row) => row.platform === platform && row.expectation === "downloadable",
      );
      const completed = downloadable.filter((row) => {
        const result = byTargetAndId.get(`${target}:${row.id}`);
        return result?.outcome === "completed" && result.artifactPlayable === true
          && !unverifiedSampleKeys.has(`${target}:${row.id}`)
          && (row.scenario !== "login" || qualifiedLoginIds.has(row.id));
      }).length;
      const successRate = downloadable.length === 0 ? 0 : completed / downloadable.length;
      platforms[platform] = { completed, total: downloadable.length, successRate };
      if (successRate < 0.9) {
        failures.push(`${target} ${platform} downloadable success rate must reach 90%`);
      }
    }
    targets[target] = { platforms };
  }

  return { passed: failures.length === 0, targets, failures };
}
