import path from "node:path";

const INSTALLER_TARGETS = ["macos-arm64", "windows-x64"];
const REQUIRED_VERSION = "0.3.1";
const REQUIRED_EXTENSION_VERSION = "0.8.3";
const ARTIFACT_FILENAMES = Object.freeze({
  "macos-arm64": `Downany-${REQUIRED_VERSION}-mac.dmg`,
  "windows-x64": `Downany-${REQUIRED_VERSION}-win-x64.exe`,
  extension: `Downany-chrome-extension-${REQUIRED_EXTENSION_VERSION}.zip`,
});

function isSha256(value) {
  return /^[a-f0-9]{64}$/.test(value || "");
}

function isSafeRelativePath(value) {
  return typeof value === "string"
    && value.length > 0
    && !value.startsWith("/")
    && !/^[A-Za-z]:\//.test(value)
    && !value.includes("\\")
    && !value.split("/").includes("..");
}

function validateDeclaration(label, declaration, failures) {
  if (!declaration || typeof declaration !== "object" || Array.isArray(declaration)) {
    failures.push(`${label} artifact declaration is invalid`);
    return false;
  }
  if (!isSafeRelativePath(declaration.path)) {
    failures.push(`${label} path must be repository-relative`);
  }
  if (ARTIFACT_FILENAMES[label] && path.posix.basename(declaration.path || "") !== ARTIFACT_FILENAMES[label]) {
    failures.push(`${label} filename must be ${ARTIFACT_FILENAMES[label]}`);
  }
  if (!isSha256(declaration.sha256)) failures.push(`${label} SHA-256 is invalid`);
  if (!Number.isInteger(declaration.bytes) || declaration.bytes <= 0) {
    failures.push(`${label} byte size is invalid`);
  }
  return true;
}

function compareInspection(label, declaration, inspection, failures, verified) {
  if (!inspection?.exists) {
    failures.push(`${label} artifact is missing`);
    return;
  }
  if (inspection.sha256 !== declaration.sha256) failures.push(`${label} SHA-256 does not match`);
  if (inspection.bytes !== declaration.bytes) failures.push(`${label} byte size does not match`);
  if (inspection.sha256 === declaration.sha256 && inspection.bytes === declaration.bytes) {
    verified.push(label);
  }
}

export function evaluateCandidateArtifacts(manifest, inspections = {}) {
  const failures = [];
  const releaseBlockers = [];
  const verified = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return {
      integrityPassed: false,
      releaseReady: false,
      verified,
      releaseBlockers: ["candidate manifest is missing"],
      failures: ["Candidate manifest must be an object"],
    };
  }
  if (manifest.version !== REQUIRED_VERSION) failures.push(`version must be ${REQUIRED_VERSION}`);
  if (manifest.extensionVersion !== REQUIRED_EXTENSION_VERSION) {
    failures.push(`extensionVersion must be ${REQUIRED_EXTENSION_VERSION}`);
  }

  const installers = manifest.installers && typeof manifest.installers === "object"
    ? manifest.installers
    : {};
  for (const target of INSTALLER_TARGETS) {
    const declaration = installers[target];
    if (declaration === null || declaration === undefined) {
      releaseBlockers.push(`${target} installer is not available`);
      continue;
    }
    if (validateDeclaration(target, declaration, failures)) {
      compareInspection(target, declaration, inspections[target], failures, verified);
    }
  }

  if (validateDeclaration("extension", manifest.extension, failures)) {
    compareInspection("extension", manifest.extension, inspections.extension, failures, verified);
  }

  const integrityPassed = failures.length === 0;
  return {
    integrityPassed,
    releaseReady: integrityPassed && releaseBlockers.length === 0,
    verified,
    releaseBlockers,
    failures,
  };
}

export function recordCandidateArtifact(manifest, record) {
  const target = record?.target;
  if (![...INSTALLER_TARGETS, "extension"].includes(target)) {
    throw new Error("Candidate artifact target is invalid");
  }
  if (manifest?.version !== REQUIRED_VERSION || manifest?.extensionVersion !== REQUIRED_EXTENSION_VERSION) {
    throw new Error("Candidate manifest versions do not match the v0.3.1 contract");
  }
  if (!manifest.installers || typeof manifest.installers !== "object" || Array.isArray(manifest.installers)) {
    throw new Error("Candidate manifest installers are invalid");
  }
  if (!isSha256(record?.sha256) || !Number.isInteger(record?.bytes) || record.bytes <= 0) {
    throw new Error("Candidate artifact digest or byte size is invalid");
  }
  const repositoryRoot = path.resolve(record.repositoryRoot || "");
  const artifactPath = path.resolve(record.artifactPath || "");
  const relativePath = path.relative(repositoryRoot, artifactPath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("Candidate artifact must be inside the repository");
  }
  if (path.basename(artifactPath) !== ARTIFACT_FILENAMES[target]) {
    throw new Error(`Candidate artifact filename must be ${ARTIFACT_FILENAMES[target]}`);
  }
  const declaration = {
    path: relativePath.split(path.sep).join("/"),
    sha256: record.sha256,
    bytes: record.bytes,
  };
  const updated = structuredClone(manifest);
  if (target === "extension") updated.extension = declaration;
  else updated.installers[target] = declaration;
  return updated;
}

export const candidateArtifactContract = Object.freeze({
  installerTargets: INSTALLER_TARGETS,
  version: REQUIRED_VERSION,
  extensionVersion: REQUIRED_EXTENSION_VERSION,
  artifactFilenames: ARTIFACT_FILENAMES,
});
