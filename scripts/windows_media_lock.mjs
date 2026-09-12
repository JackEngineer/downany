#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_WINDOWS_MEDIA_LOCK = path.resolve(
  scriptDir,
  "../packaging/ffmpeg-windows/source.lock.json",
);

function requireString(lock, key) {
  const value = lock?.[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Windows media lock ${key} must be a non-empty string`);
  }
  return value.trim();
}

export function validateWindowsMediaLock(lock) {
  if (!lock || typeof lock !== "object" || Array.isArray(lock)) {
    throw new Error("Windows media lock must be an object");
  }
  if (lock.schemaVersion !== 1) {
    throw new Error(`Unsupported Windows media lock schema: ${String(lock.schemaVersion)}`);
  }

  const repository = requireString(lock, "repository");
  const tag = requireString(lock, "tag");
  const retentionClass = requireString(lock, "retentionClass");
  const asset = requireString(lock, "asset");
  const url = requireString(lock, "url");
  const sha256 = requireString(lock, "sha256").toLowerCase();

  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error(`Invalid Windows media lock repository: ${repository}`);
  }
  if (retentionClass !== "monthly-final") {
    throw new Error(
      `Windows media lock retentionClass must be monthly-final, got ${retentionClass}`,
    );
  }
  if (!/^autobuild-\d{4}-\d{2}-(?:28|29|30|31)-\d{2}-\d{2}$/.test(tag)) {
    throw new Error(`Windows media lock tag is not a month-end candidate: ${tag}`);
  }
  if (asset.includes("/") || asset.includes("\\") || !asset.endsWith(".zip")) {
    throw new Error(`Invalid Windows media lock asset: ${asset}`);
  }
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error("Windows media lock sha256 must contain 64 lowercase hex characters");
  }

  const expectedUrl = `https://github.com/${repository}/releases/download/${tag}/${asset}`;
  if (url !== expectedUrl) {
    throw new Error(`Windows media lock URL must be ${expectedUrl}`);
  }

  return { schemaVersion: 1, repository, tag, retentionClass, asset, url, sha256 };
}

export function loadWindowsMediaLock(lockPath = DEFAULT_WINDOWS_MEDIA_LOCK) {
  const payload = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  return validateWindowsMediaLock(payload);
}

export async function verifyWindowsMediaLock(lock, {
  fetchImpl = globalThis.fetch,
  githubToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "",
} = {}) {
  const validated = validateWindowsMediaLock(lock);
  const releaseApi =
    `https://api.github.com/repos/${validated.repository}/releases/tags/` +
    encodeURIComponent(validated.tag);
  const apiHeaders = { accept: "application/vnd.github+json" };
  if (githubToken) apiHeaders.authorization = `Bearer ${githubToken}`;
  const response = await fetchImpl(releaseApi, {
    headers: apiHeaders,
  });
  if (!response.ok) {
    throw new Error(
      `Windows media release tag ${validated.tag} is unavailable (HTTP ${response.status})`,
    );
  }

  const release = await response.json();
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const asset = assets.find((candidate) => candidate?.name === validated.asset);
  if (!asset) {
    throw new Error(`Windows media asset ${validated.asset} is missing from ${validated.tag}`);
  }
  if (asset.digest !== `sha256:${validated.sha256}`) {
    throw new Error(
      `Windows media asset digest mismatch: expected sha256:${validated.sha256}, ` +
        `got ${String(asset.digest)}`,
    );
  }
  if (asset.browser_download_url !== validated.url) {
    throw new Error(`Windows media asset URL mismatch: ${String(asset.browser_download_url)}`);
  }

  const assetResponse = await fetchImpl(validated.url, { method: "HEAD" });
  if (!assetResponse.ok) {
    throw new Error(
      `Windows media asset ${validated.asset} is not downloadable (HTTP ${assetResponse.status})`,
    );
  }

  return { url: validated.url, sha256: validated.sha256, asset: validated.asset };
}

async function main() {
  const lock = loadWindowsMediaLock(process.argv[2]);
  const result = await verifyWindowsMediaLock(lock);
  console.log(`Verified Windows media lock: ${result.asset}`);
  console.log(`SHA-256: ${result.sha256}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
