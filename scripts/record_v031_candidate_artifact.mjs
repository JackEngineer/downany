import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { recordCandidateArtifact } from "./v031_candidate_artifacts.mjs";

function parseArguments(rawArguments) {
  const allowed = new Set(["--manifest", "--target", "--artifact"]);
  const parsed = new Map();
  for (const argument of rawArguments) {
    const separator = argument.indexOf("=");
    if (separator <= 0) throw new Error("参数必须使用 --名称=值 格式");
    const name = argument.slice(0, separator);
    const value = argument.slice(separator + 1);
    if (!allowed.has(name) || parsed.has(name) || !value) throw new Error(`未知、重复或空参数：${name}`);
    parsed.set(name, value);
  }
  for (const name of allowed) {
    if (!parsed.has(name)) throw new Error(`缺少参数：${name}`);
  }
  return {
    manifestPath: parsed.get("--manifest"),
    target: parsed.get("--target"),
    artifactPath: parsed.get("--artifact"),
  };
}

async function sha256(filePath) {
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

function assertInsideRepository(repositoryRoot, candidatePath, label) {
  const relativePath = path.relative(repositoryRoot, candidatePath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`${label}必须位于仓库内`);
  }
}

try {
  const repositoryRoot = fs.realpathSync(process.cwd());
  const args = parseArguments(process.argv.slice(2));
  const manifestPath = fs.realpathSync(path.resolve(repositoryRoot, args.manifestPath));
  const artifactPath = fs.realpathSync(path.resolve(repositoryRoot, args.artifactPath));
  assertInsideRepository(repositoryRoot, manifestPath, "候选清单");
  assertInsideRepository(repositoryRoot, artifactPath, "候选产物");
  const stat = fs.statSync(artifactPath);
  if (!stat.isFile()) throw new Error("候选产物不是普通文件");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const updated = recordCandidateArtifact(manifest, {
    target: args.target,
    repositoryRoot,
    artifactPath,
    sha256: await sha256(artifactPath),
    bytes: stat.size,
  });
  const temporaryPath = `${manifestPath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, manifestPath);
  const declaration = args.target === "extension" ? updated.extension : updated.installers[args.target];
  console.log(JSON.stringify({ target: args.target, ...declaration }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
