import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { evaluateCandidateArtifacts } from "./v031_candidate_artifacts.mjs";

async function inspectArtifact(repositoryRoot, declaration) {
  if (!declaration?.path) return undefined;
  const artifactPath = path.resolve(repositoryRoot, declaration.path);
  try {
    const stat = await fs.promises.stat(artifactPath);
    if (!stat.isFile()) return { exists: false };
    const hash = crypto.createHash("sha256");
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(artifactPath);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", resolve);
    });
    return { exists: true, bytes: stat.size, sha256: hash.digest("hex") };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false };
    throw error;
  }
}

const args = process.argv.slice(2);
const verifyAvailable = args.includes("--verify-available");
const manifestArg = args.find((arg) => !arg.startsWith("--"));
if (!manifestArg) {
  console.error("用法：node scripts/evaluate_v031_candidate_artifacts.mjs <候选产物清单.json> [--verify-available]");
  process.exitCode = 2;
} else {
  const repositoryRoot = process.cwd();
  const manifestPath = path.resolve(repositoryRoot, manifestArg);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const inspections = {};
  for (const [label, declaration] of [
    ["macos-arm64", manifest.installers?.["macos-arm64"]],
    ["windows-x64", manifest.installers?.["windows-x64"]],
    ["extension", manifest.extension],
  ]) {
    if (declaration) inspections[label] = await inspectArtifact(repositoryRoot, declaration);
  }
  const report = evaluateCandidateArtifacts(manifest, inspections);
  console.log(JSON.stringify(report, null, 2));
  const passed = verifyAvailable ? report.integrityPassed : report.releaseReady;
  if (!passed) process.exitCode = 1;
}
