/** 已确认 URL 别名的证据复核；只对已知摘要组作否决，不宣称识别所有内容别名。 */
import fs from "node:fs";

const REVIEW_URL = new URL("../docs/acceptance/v0.3.1-sample-independence-review.json", import.meta.url);
const INVALID_REVIEW = "Sample independence review is missing or invalid";
const SHA256 = /^[a-f0-9]{64}$/;
const CASE_ID = /^(youtube|bilibili|douyin)-(0[1-9]|10)$/;

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function validateSampleIndependenceReview(value) {
  const fail = () => { throw new Error(INVALID_REVIEW); };
  if (!exactKeys(value, ["schemaVersion", "groups"]) || value.schemaVersion !== 1
    || !Array.isArray(value.groups) || value.groups.length === 0) fail();
  const seen = new Set();
  for (const group of value.groups) {
    if (!exactKeys(group, ["status", "reason", "sampleSha256s", "evidence"])
      || group.status !== "rejected" || group.reason !== "duplicate_content"
      || !Array.isArray(group.sampleSha256s) || group.sampleSha256s.length < 2) fail();
    for (const hash of group.sampleSha256s) {
      if (typeof hash !== "string" || !SHA256.test(hash) || seen.has(hash)) fail();
      seen.add(hash);
    }
    const evidence = group.evidence;
    if (!exactKeys(evidence, ["kind", "target", "candidateSha256", "caseIds", "extractorVideoIdSha256",
      "sameDefaultPart", "sameDecodedMedia", "decodedMediaSha256"])
      || evidence.kind !== "local_extractor_tests_and_packaged_media"
      || !["macos-arm64", "windows-x64"].includes(evidence.target)
      || typeof evidence.candidateSha256 !== "string" || !SHA256.test(evidence.candidateSha256)
      || !Array.isArray(evidence.caseIds) || evidence.caseIds.length !== group.sampleSha256s.length
      || evidence.caseIds.some((id) => typeof id !== "string" || !CASE_ID.test(id))
      || new Set(evidence.caseIds).size !== evidence.caseIds.length
      || typeof evidence.extractorVideoIdSha256 !== "string" || !SHA256.test(evidence.extractorVideoIdSha256)
      || evidence.sameDefaultPart !== true || evidence.sameDecodedMedia !== true
      || typeof evidence.decodedMediaSha256 !== "string" || !SHA256.test(evidence.decodedMediaSha256)) fail();
  }
  return value;
}

export function loadSampleIndependenceReview() {
  try {
    return validateSampleIndependenceReview(JSON.parse(fs.readFileSync(REVIEW_URL, "utf8")));
  } catch {
    // 不把文件路径、非法字段或原始错误带到验收输出。
    throw new Error(INVALID_REVIEW);
  }
}

export function findReviewedSampleConflicts(samples, { loadReview = loadSampleIndependenceReview } = {}) {
  // 显式注入只替换输入来源；任何来源仍须满足完整审核合同。
  const { groups } = validateSampleIndependenceReview(loadReview());
  const groupByHash = new Map(groups.flatMap((group, index) => group.sampleSha256s.map((hash) => [hash, index])));
  const byTargetAndGroup = new Map();
  for (const sample of samples) {
    const group = groupByHash.get(sample.sampleSha256);
    if (group === undefined) continue;
    const key = `${sample.target}:${group}`;
    const entry = byTargetAndGroup.get(key) || { target: sample.target, ids: new Set() };
    entry.ids.add(sample.id);
    byTargetAndGroup.set(key, entry);
  }
  return [...byTargetAndGroup.values()].filter(({ ids }) => ids.size > 1)
    .map(({ target, ids }) => ({ target, ids: [...ids].sort(), status: "rejected", reason: "duplicate_content" }));
}

export function assertIndependentMatrixSamples(samples, { loadReview = loadSampleIndependenceReview } = {}) {
  // 先加载并校验默认复核数据，空输入也不能跳过损坏/缺失的复核文件。
  const reviewed = findReviewedSampleConflicts(samples, { loadReview });
  const exact = new Map();
  let repeated = false;
  for (const sample of samples) {
    if (typeof sample.sampleSha256 !== "string" || !SHA256.test(sample.sampleSha256)) {
      throw new Error("Sample independence preflight requires valid sample identities");
    }
    const key = `${sample.target}:${sample.sampleSha256}`;
    if (exact.has(key) && exact.get(key) !== sample.id) repeated = true;
    exact.set(key, sample.id);
  }
  if (repeated || reviewed.length) throw new Error("Sample independence review rejected duplicate content");
}
