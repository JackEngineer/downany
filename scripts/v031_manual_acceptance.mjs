const TARGETS = ["macos-arm64", "windows-x64"];
const PARTICIPANTS = ["P1", "P2", "P3", "P4", "P5"];
const FIRST_USE_STEPS = ["install", "add", "download", "open"];
const ADD_METHODS = ["app", "extension"];
const EXTENSION_STEP = "extensionConnect";
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

export function evaluateManualAcceptance(evidence) {
  const failures = [];
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return {
      passed: false,
      firstUse: { total: 0, completedWithoutGuidance: 0 },
      packageTargets: [],
      failures: ["Manual acceptance evidence must be an object"],
    };
  }
  if (evidence.version !== "0.3.1") failures.push("Evidence version must be 0.3.1");
  collectPrivateEvidence(evidence, failures);

  const trials = Array.isArray(evidence.firstUseTrials) ? evidence.firstUseTrials : [];
  if (trials.length !== 5) failures.push("First-use evidence must contain exactly 5 trials");
  const participantIds = new Set();
  let completedWithoutGuidance = 0;
  let extensionTrials = 0;
  let completedExtensionTrials = 0;
  for (const trial of trials) {
    const id = trial?.participantId;
    if (!PARTICIPANTS.includes(id)) failures.push(`Unknown participant id: ${id || "<missing>"}`);
    if (participantIds.has(id)) failures.push(`Duplicate participant id: ${id || "<missing>"}`);
    participantIds.add(id);
    if (trial?.firstTimeUser !== true) failures.push(`${id || "Trial"} must be a first-time user`);
    if (!TARGETS.includes(trial?.target)) failures.push(`${id || "Trial"} has an invalid target`);
    if (!ADD_METHODS.includes(trial?.addMethod)) {
      failures.push(`${id || "Trial"} must record addMethod as app or extension`);
    } else if (trial.addMethod === "extension") {
      extensionTrials += 1;
    }
    if (!isSha256(trial?.candidateSha256)) failures.push(`${id || "Trial"} is missing a candidate SHA-256`);
    if (!isTimestamp(trial?.observedAt)) failures.push(`${id || "Trial"} is missing a valid observation time`);
    if (typeof trial?.completedWithoutGuidance !== "boolean") {
      failures.push(`${id || "Trial"} must record completedWithoutGuidance`);
      continue;
    }
    const steps = Array.isArray(trial.completedSteps) ? trial.completedSteps : [];
    if (trial.addMethod === "extension" && steps.includes(EXTENSION_STEP)) {
      completedExtensionTrials += 1;
    }
    if (trial.completedWithoutGuidance) {
      completedWithoutGuidance += 1;
      if (FIRST_USE_STEPS.some((step) => !steps.includes(step))) {
        failures.push(`${id} must complete install, add, download and open`);
      }
      if (trial.addMethod === "extension" && !steps.includes(EXTENSION_STEP)) {
        failures.push(`${id} extension trial must complete ${EXTENSION_STEP}`);
      }
      if (trial.blockedStep !== null) failures.push(`${id} completed but has a blockedStep`);
    } else {
      if (!FIRST_USE_STEPS.includes(trial.blockedStep)) failures.push(`${id} must record a blockedStep`);
      if (typeof trial.notes !== "string" || !trial.notes.trim()) failures.push(`${id} must explain the blocked trial`);
    }
  }
  if (participantIds.size !== 5 || PARTICIPANTS.some((id) => !participantIds.has(id))) {
    failures.push("First-use evidence must identify anonymous participants P1 through P5 exactly once");
  }
  if (completedWithoutGuidance < 4) failures.push("At least 4 first-time users must complete without guidance");
  if (extensionTrials < 1) failures.push("At least 1 first-time user must use the extension route");
  if (completedExtensionTrials < 1) failures.push("At least 1 first-time user must complete the extension connection");

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
  for (const trial of trials) {
    const record = recordsByTarget.get(trial?.target);
    if (record && trial.candidateSha256 !== record.candidateSha256) {
      failures.push(`${trial.participantId || "Trial"} candidate does not match ${trial.target} manual package record`);
    }
  }

  return {
    passed: failures.length === 0,
    firstUse: { total: trials.length, completedWithoutGuidance },
    packageTargets: TARGETS.filter((target) => recordsByTarget.has(target)),
    failures,
  };
}

export const manualAcceptanceContract = Object.freeze({
  targets: TARGETS,
  participants: PARTICIPANTS,
  firstUseSteps: FIRST_USE_STEPS,
  addMethods: ADD_METHODS,
  extensionStep: EXTENSION_STEP,
  packageChecks: PACKAGE_CHECKS,
});
