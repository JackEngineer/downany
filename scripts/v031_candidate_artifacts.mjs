import path from "node:path";

const INSTALLER_TARGETS = ["macos-arm64", "windows-x64"];
export function createCandidateArtifactContract({ version, extensionVersion }) {
  const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  if (!versionPattern.test(version || "") || !versionPattern.test(extensionVersion || "")) {
    throw new Error("Candidate artifact versions must be major.minor.patch");
  }
  return Object.freeze({
    installerTargets: Object.freeze([...INSTALLER_TARGETS]), version, extensionVersion,
    artifactFilenames: Object.freeze({
      "macos-arm64": `Downany-${version}-mac.dmg`,
      "windows-x64": `Downany-${version}-win-x64.exe`,
      extension: `Downany-chrome-extension-${extensionVersion}.zip`,
    }),
  });
}

// 保留历史 0.3.1 清单的默认合同；新版本必须显式指定已锁定的版本。
export const candidateArtifactContract = createCandidateArtifactContract({
  version: "0.3.1", extensionVersion: "0.8.3",
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

function validateDeclaration(label, declaration, failures, contract) {
  if (!declaration || typeof declaration !== "object" || Array.isArray(declaration)) {
    failures.push(`${label} artifact declaration is invalid`);
    return false;
  }
  if (!isSafeRelativePath(declaration.path)) {
    failures.push(`${label} path must be repository-relative`);
  }
  if (contract.artifactFilenames[label] && path.posix.basename(declaration.path || "") !== contract.artifactFilenames[label]) {
    failures.push(`${label} filename must be ${contract.artifactFilenames[label]}`);
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

export function evaluateCandidateArtifacts(manifest, inspections = {}, versions = candidateArtifactContract) {
  const contract = createCandidateArtifactContract(versions);
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
  if (manifest.version !== contract.version) failures.push(`version must be ${contract.version}`);
  if (manifest.extensionVersion !== contract.extensionVersion) {
    failures.push(`extensionVersion must be ${contract.extensionVersion}`);
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
    if (validateDeclaration(target, declaration, failures, contract)) {
      compareInspection(target, declaration, inspections[target], failures, verified);
    }
  }

  if (validateDeclaration("extension", manifest.extension, failures, contract)) {
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

export function recordCandidateArtifact(manifest, record, versions = candidateArtifactContract) {
  const contract = createCandidateArtifactContract(versions);
  const target = record?.target;
  if (![...INSTALLER_TARGETS, "extension"].includes(target)) {
    throw new Error("Candidate artifact target is invalid");
  }
  if (manifest?.version !== contract.version || manifest?.extensionVersion !== contract.extensionVersion) {
    throw new Error("Candidate manifest versions do not match the locked artifact contract");
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
  if (path.basename(artifactPath) !== contract.artifactFilenames[target]) {
    throw new Error(`Candidate artifact filename must be ${contract.artifactFilenames[target]}`);
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
