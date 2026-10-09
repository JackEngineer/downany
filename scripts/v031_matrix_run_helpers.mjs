import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { classifyAnonymousLoginTask, sanitizeLoginEvidence } from "./v031_login_evidence.mjs";

const TARGETS = new Set(["macos-arm64", "windows-x64"]);

export function parseMatrixRunArguments(rawArguments) {
  const allowed = new Set([
    "--executable", "--candidate-artifact", "--playwright-module", "--matrix", "--results", "--target",
    "--expected-version", "--cookiefile", "--cookies-from-browser", "--case", "--timeout-minutes",
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
  const cookiesFromBrowser = args.get("--cookies-from-browser") || "";
  assert.ok(!cookiesFromBrowser.includes(":"), "Use only a browser name; profile suffix is not supported by the packaged downloader");
  assert.ok(!(cookiesFromBrowser && args.has("--cookiefile")), "Use only one credential source");
  return {
    executable: args.get("--executable"),
    candidateArtifact: args.get("--candidate-artifact"),
    playwrightModule: args.get("--playwright-module"),
    matrixPath: args.get("--matrix"),
    resultsPath: args.get("--results"),
    target,
    expectedVersion,
    cookiefile: args.get("--cookiefile") || "",
    cookiesFromBrowser,
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

async function parseCollection(page, url) {
  return page.evaluate(({ sourceUrl }) => new Promise((resolve, reject) => {
    let parseId = "";
    let timeout;
    let settled = false;
    const earlyResults = [];
    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      unsubscribe();
      if (error) reject(error);
      else resolve(value);
    };
    const receive = (payload) => {
      if (payload?.parseId !== parseId) return;
      if (payload.cancelled === true) {
        finish(undefined, new Error("Collection parse was cancelled"));
      } else if (payload.ok === false) {
        // 解析事件没有可信分类码；错误正文留在候选应用内。
        finish({ failureStage: "collection_parse" });
      } else if (payload.ok === true) {
        finish({ parsed: payload });
      } else {
        finish(undefined, new Error("Invalid collection parse result"));
      }
    };
    const unsubscribe = window.api.onEvent((event) => {
      if (event.event !== "download.parseResult") return;
      if (!parseId) earlyResults.push(event.payload);
      else receive(event.payload);
    });
    Promise.resolve().then(() => window.api.request("download.parseUrls", {
      urls: [sourceUrl], allow_playlist: true, timeout: 90,
    })).then((reply) => {
      if (typeof reply?.parseId !== "string" || !reply.parseId.trim()) {
        finish(undefined, new Error("Invalid collection parse acknowledgement"));
        return;
      }
      parseId = reply.parseId;
      // 只记录已被应用接受的解析等待超时，不把 IPC 启动失败计作网站结果。
      timeout = setTimeout(() => finish({ failureStage: "collection_parse" }), 120_000);
      for (const payload of earlyResults) receive(payload);
      earlyResults.length = 0;
    }).catch((error) => finish(undefined, error));
  }), { sourceUrl: url });
}

export async function createMatrixCaseTask(page, row, url) {
  let urls = [url];
  let items;
  if (row.scenario === "collection") {
    const result = await parseCollection(page, url);
    if (result.failureStage === "collection_parse") return result;
    const parsed = result.parsed;
    assert.ok(parsed.entries === undefined || Array.isArray(parsed.entries), "Invalid collection entries");
    const entry = (parsed.entries || []).find((item) => typeof item?.url === "string" && item.url.trim() &&
      item.available !== false && String(item.available ?? "1") !== "0");
    if (!entry) return { failureStage: "collection_parse" };
    urls = [entry.url];
    items = [{
      url: entry.url,
      title: String(entry.title || entry.id || "集合样本"),
      group_id: `acceptance-${row.id}`,
      group_title: String(parsed.playlist?.title || "集合样本"),
      playlist_index: Number(entry.index) || 1,
    }];
  }
  const reply = await page.evaluate(({ taskUrls, taskItems }) =>
    window.api.request("download.createTasks", {
      urls: taskUrls, items: taskItems, expandPlaylists: false,
    }), { taskUrls: urls, taskItems: items });
  assert.equal(reply.taskIds?.length, 1, "Each matrix case must create exactly one task");
  return { taskId: reply.taskIds[0] };
}

export function buildSanitizedCaseResult({ target, candidateSha256, sampleSha256, row, task, artifact, recordedAt, loginEvidence, failureStage }) {
  const completed = task?.status === "completed" && artifact?.playable === true;
  const expectedError = row.expectation === "error" && task?.status === "failed";
  const safeLoginEvidence = sanitizeLoginEvidence(loginEvidence);
  return {
    target,
    candidateSha256,
    id: row.id,
    outcome: completed ? "completed" : expectedError ? "expected_error" : "failed",
    errorCode: String(task?.error_code || ""),
    artifactPlayable: completed,
    ...(row.scenario === "collection" && !task && failureStage === "collection_parse" ? { failureStage } : {}),
    ...(completed ? {
      artifactSha256: artifact.sha256,
      artifactBytes: artifact.bytes,
    } : {}),
    recordedAt,
    ...(/^[a-f0-9]{64}$/.test(sampleSha256 || "") ? { sampleSha256 } : {}),
    ...(safeLoginEvidence ? { loginEvidence: safeLoginEvidence } : {}),
  };
}

export function assertCredentialSettings(settings, expected) {
  // 不使用 deepEqual：断言差异可能将 Cookie 文件路径写入日志。
  assert.ok(settings?.cookies_from_browser === expected.cookiesFromBrowser &&
    settings?.cookiefile === expected.cookiefile, "Candidate credential settings do not match the isolated attempt");
}

export function removeAttemptState(directories) {
  // Windows 文件锁可能使一项删除失败；仍须尝试清理另一项，并让执行失败。
  try {
    fs.rmSync(directories.dataDir, { recursive: true, force: true });
  } finally {
    fs.rmSync(directories.profileDir, { recursive: true, force: true });
  }
}

export async function collectMatrixCase({ target, candidateSha256, row, url, credentialSource, runAttempt }) {
  const sampleSha256 = createHash("sha256").update(url).digest("hex");
  const identity = { target, candidateSha256, sampleSha256 };
  if (row.scenario !== "login") {
    const attempt = await runAttempt({ row, url, credentialSource, phase: "single" });
    return buildSanitizedCaseResult({ ...identity, row, ...attempt });
  }
  assert.ok(["browser", "cookiefile"].includes(credentialSource), "Login cases require one credential source");
  const anonymous = await runAttempt({ row, url, credentialSource: "none", phase: "anonymous" });
  const classification = classifyAnonymousLoginTask(anonymous.task);
  const loginEvidence = {
    schemaVersion: 1, source: "paired-candidate-runs", caseId: row.id, ...identity,
    anonymous: { ...classification, credentialSource: "none", instanceId: anonymous.instanceId, recordedAt: anonymous.recordedAt },
    authorized: null,
  };
  // 匿名可下载或遇到风控等不明确错误时，不读取登录凭证。
  if (classification.outcome !== "authentication_required") {
    return buildSanitizedCaseResult({ ...identity, row, ...anonymous, loginEvidence });
  }
  const authorized = await runAttempt({ row, url, credentialSource, phase: "authorized" });
  loginEvidence.authorized = {
    credentialSource, instanceId: authorized.instanceId, recordedAt: authorized.recordedAt,
    ...(authorized.artifact?.playable ? { artifactSha256: authorized.artifact.sha256 } : {}),
  };
  return buildSanitizedCaseResult({ ...identity, row, ...authorized, loginEvidence });
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
    const loginEvidence = sanitizeLoginEvidence(item.loginEvidence);
    const safe = {
      target: item.target,
      candidateSha256: item.candidateSha256,
      id: item.id,
      outcome: item.outcome,
      errorCode: String(item.errorCode || ""),
      artifactPlayable: item.artifactPlayable === true,
      ...(item.outcome === "failed" && item.artifactPlayable === false && item.failureStage === "collection_parse"
        ? { failureStage: "collection_parse" } : {}),
      ...(typeof item.artifactSha256 === "string" ? { artifactSha256: item.artifactSha256 } : {}),
      ...(Number.isFinite(item.artifactBytes) ? { artifactBytes: item.artifactBytes } : {}),
      ...(typeof item.recordedAt === "string" ? { recordedAt: item.recordedAt } : {}),
      ...(/^[a-f0-9]{64}$/.test(item.sampleSha256 || "") ? { sampleSha256: item.sampleSha256 } : {}),
      ...(loginEvidence ? { loginEvidence } : {}),
    };
    merged.set(`${safe.target}:${safe.id}`, safe);
  }
  return [...merged.values()].sort((a, b) =>
    `${a.target}:${a.id}`.localeCompare(`${b.target}:${b.id}`));
}
