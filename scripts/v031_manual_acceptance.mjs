const TARGETS = ["macos-arm64", "windows-x64"];
const FIRST_USE_STATUS = "cancelled_by_user";
const PACKAGE_CHECKS = [
  "firstInstall",
  "upgradeFrom030",
  "settingsPreserved",
  "queuePreserved",
  "pauseResume",
  "playback",
  "noOverwrite",
];
const PRIVATE_EVIDENCE = /(?:https?:\/\/|\/Users\/|\/home\/|[A-Za-z]:\\|cookie|token)/i;

function isSha256(value) {
  return /^[a-f0-9]{64}$/.test(value || "");
}

function isTimestamp(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function collectPrivateEvidence(value, failures, location = "evidence") {
  if (typeof value === "string" && PRIVATE_EVIDENCE.test(value)) {
    failures.push(`${location} contains private evidence`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectPrivateEvidence(item, failures, `${location}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      collectPrivateEvidence(item, failures, `${location}.${key}`);
    }
  }
}

export function evaluateManualAcceptance(evidence, { expectedVersion = "0.3.1" } = {}) {
  if (typeof expectedVersion !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(expectedVersion)) {
    throw new Error("Expected version must be major.minor.patch");
  }
  const failures = [];
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return {
      passed: false,
      firstUse: { status: FIRST_USE_STATUS, historicalTrialCount: 0 },
      packageTargets: [],
      failures: ["Manual acceptance evidence must be an object"],
    };
  }
  if (evidence.version !== expectedVersion) failures.push(`Evidence version must be ${expectedVersion}`);
  collectPrivateEvidence(evidence, failures);

  // 首次试用门槛已由用户取消；历史字段只作记录，仍参与上方全证据隐私扫描。
  const trials = Array.isArray(evidence.firstUseTrials) ? evidence.firstUseTrials : [];
  const records = Array.isArray(evidence.packageRecords) ? evidence.packageRecords : [];
  const recordsByTarget = new Map();
  for (const record of records) {
    const target = record?.target;
    if (!TARGETS.includes(target)) {
      failures.push(`Unknown package target: ${target || "<missing>"}`);
      continue;
    }
    if (recordsByTarget.has(target)) {
      failures.push(`Duplicate manual package record: ${target}`);
      continue;
    }
    recordsByTarget.set(target, record);
    if (record.manual !== true) failures.push(`${target} package record must be manual`);
    if (!isSha256(record.candidateSha256)) failures.push(`${target} is missing a candidate SHA-256`);
    if (!isTimestamp(record.recordedAt)) failures.push(`${target} is missing a valid record time`);
    for (const check of PACKAGE_CHECKS) {
      if (record.checks?.[check] !== true) failures.push(`${target} manual check must pass: ${check}`);
    }
    if (typeof record.notes !== "string" || !record.notes.trim()) {
      failures.push(`${target} package record must include a concise manual note`);
    }
  }
  for (const target of TARGETS) {
    if (!recordsByTarget.has(target)) failures.push(`Missing manual package record: ${target}`);
  }

  return {
    passed: failures.length === 0,
    firstUse: { status: FIRST_USE_STATUS, historicalTrialCount: trials.length },
    packageTargets: TARGETS.filter((target) => recordsByTarget.has(target)),
    failures,
  };
}

export const manualAcceptanceContract = Object.freeze({
  targets: TARGETS,
  firstUseStatus: FIRST_USE_STATUS,
  packageChecks: PACKAGE_CHECKS,
});
