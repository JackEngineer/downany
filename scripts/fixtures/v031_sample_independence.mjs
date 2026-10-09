/** 仅用于单元测试的合成审核输入，不是网站样本的真实复核证据。 */
import { createHash } from "node:crypto";

const hash = (value) => createHash("sha256").update(`synthetic-review:${value}`).digest("hex");
export const syntheticBilibiliAliases = Object.freeze([hash("alias-bv"), hash("alias-av")]);

export function createSyntheticSampleIndependenceReview() {
  return {
    schemaVersion: 1,
    groups: [{
      status: "rejected",
      reason: "duplicate_content",
      sampleSha256s: [...syntheticBilibiliAliases],
      evidence: {
        kind: "local_extractor_tests_and_packaged_media",
        target: "macos-arm64",
        candidateSha256: hash("candidate"),
        caseIds: ["bilibili-01", "bilibili-03"],
        extractorVideoIdSha256: hash("extractor-video-id"),
        sameDefaultPart: true,
        sameDecodedMedia: true,
        decodedMediaSha256: hash("decoded-media"),
      },
    }],
  };
}
