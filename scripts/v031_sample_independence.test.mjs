import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  assertIndependentMatrixSamples,
  findReviewedSampleConflicts,
  loadSampleIndependenceReview,
  validateSampleIndependenceReview,
} from "./v031_sample_independence.mjs";
import { createSyntheticSampleIndependenceReview } from "./fixtures/v031_sample_independence.mjs";

const fixture = createSyntheticSampleIndependenceReview();
const reviewOptions = { loadReview: createSyntheticSampleIndependenceReview };
const aliases = fixture.groups[0].sampleSha256s;
const sample = (id, hash, target = "macos-arm64") => ({ target, id, sampleSha256: hash });

test("injected review excludes both synthetic aliases on each target without modifying rows", () => {
  const rows = [sample("bilibili-01", aliases[0]), sample("bilibili-03", aliases[1])];
  const before = structuredClone(rows);
  assert.deepEqual(findReviewedSampleConflicts(rows, reviewOptions), [{ target: "macos-arm64", ids: ["bilibili-01", "bilibili-03"], status: "rejected", reason: "duplicate_content" }]);
  assert.deepEqual(rows, before);
  assert.throws(() => assertIndependentMatrixSamples(rows, reviewOptions), /^Error: Sample independence review rejected duplicate content$/);
});

test("review follows hashes across case IDs but does not combine different targets", () => {
  assert.equal(findReviewedSampleConflicts([sample("bilibili-02", aliases[0]), sample("bilibili-05", aliases[1])], reviewOptions).length, 1);
  assert.deepEqual(findReviewedSampleConflicts([sample("bilibili-01", aliases[0]), sample("bilibili-03", aliases[1], "windows-x64")], reviewOptions), []);
  assert.doesNotThrow(() => assertIndependentMatrixSamples([sample("bilibili-01", aliases[0]), sample("bilibili-03", "f".repeat(64))], reviewOptions));
});

test("preflight rejects exact URL reuse and invalid identities without exposing them", () => {
  assert.throws(() => assertIndependentMatrixSamples([sample("youtube-01", "a".repeat(64)), sample("youtube-02", "a".repeat(64))], reviewOptions), /rejected duplicate content/);
  assert.throws(() => assertIndependentMatrixSamples([sample("youtube-01", "PRIVATE URL")], reviewOptions), /^Error: Sample independence preflight requires valid sample identities$/);
});

for (const [label, mutate] of [
  ["passed override", (d) => { d.groups[0].status = "passed"; }],
  ["unknown reason", (d) => { d.groups[0].reason = "PRIVATE URL"; }],
  ["missing groups", (d) => { delete d.groups; }],
  ["empty groups", (d) => { d.groups = []; }],
  ["unknown schema", (d) => { d.schemaVersion = 2; }],
  ["unknown field", (d) => { d.groups[0].rawUrl = "PRIVATE URL"; }],
  ["invalid sample hash", (d) => { d.groups[0].sampleSha256s[0] = "PRIVATE URL"; }],
  ["repeated hash", (d) => { d.groups[0].sampleSha256s[1] = d.groups[0].sampleSha256s[0]; }],
  ["overlapping groups", (d) => { d.groups.push(structuredClone(d.groups[0])); }],
  ["unbound evidence", (d) => { delete d.groups[0].evidence.candidateSha256; }],
  ["invalid case identity", (d) => { d.groups[0].evidence.caseIds[0] = "PRIVATE URL"; }],
  ["missing decoded proof", (d) => { d.groups[0].evidence.sameDecodedMedia = false; }],
]) {
  test(`${label} cannot silently disable the default review`, () => {
    const data = structuredClone(fixture); mutate(data);
    assert.throws(() => validateSampleIndependenceReview(data), /^Error: Sample independence review is missing or invalid$/);
  });
}

for (const [label, read] of [
  ["missing", () => { throw new Error("PRIVATE PATH"); }],
  ["invalid JSON", () => "PRIVATE CONTENT"],
  ["invalid schema", () => JSON.stringify({ schemaVersion: 1, groups: [] })],
]) {
  test(`${label} review fails closed even for empty input`, (t) => {
    t.mock.method(fs, "readFileSync", read);
    assert.throws(() => loadSampleIndependenceReview(), /^Error: Sample independence review is missing or invalid$/);
    assert.throws(() => findReviewedSampleConflicts([]), /^Error: Sample independence review is missing or invalid$/);
    assert.throws(() => assertIndependentMatrixSamples([]), /^Error: Sample independence review is missing or invalid$/);
  });
}


test("the default file loader validates supplied file data", (t) => {
  t.mock.method(fs, "readFileSync", () => JSON.stringify(fixture));
  assert.deepEqual(loadSampleIndependenceReview(), fixture);
});

test("an injected loader cannot bypass review schema validation", () => {
  const invalid = { loadReview: () => ({ schemaVersion: 1, groups: [] }) };
  assert.throws(() => findReviewedSampleConflicts([], invalid), /^Error: Sample independence review is missing or invalid$/);
  assert.throws(() => assertIndependentMatrixSamples([], invalid), /^Error: Sample independence review is missing or invalid$/);
});
