const PLATFORMS = ["youtube", "bilibili", "douyin"];
const REQUIRED_SCENARIOS = ["ordinary", "login", "collection", "invalid"];
const TARGETS = ["macos-arm64", "windows-x64"];

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

  const targets = {};
  for (const target of TARGETS) {
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

    const platforms = {};
    for (const platform of PLATFORMS) {
      const downloadable = rows.filter(
        (row) => row.platform === platform && row.expectation === "downloadable",
      );
      const completed = downloadable.filter((row) => {
        const result = byTargetAndId.get(`${target}:${row.id}`);
        return result?.outcome === "completed" && result.artifactPlayable === true;
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
