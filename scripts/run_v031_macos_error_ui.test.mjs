import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { buildSeededFailureSql, parseArguments } from "./run_v031_macos_error_ui.mjs";

const absolute = (name) => path.resolve("/tmp", name);

test("macOS error UI gate requires package, artifact, external samples and evidence paths", () => {
  const parsed = parseArguments([
    `--package-executable=${absolute("Downany.app/Contents/MacOS/Downany")}`,
    `--candidate-artifact=${absolute("Downany.dmg")}`,
    `--playwright-module=${absolute("playwright")}`,
    `--results=${absolute("results.json")}`,
    "--login-url=https://www.douyin.com/video/1",
    "--removed-url=https://www.youtube.com/watch?v=aaaaaaaaaaa",
  ]);
  assert.equal(parsed.expectedVersion, "0.3.1");
  assert.throws(() => parseArguments([]), /required/i);
});

test("macOS error UI gate rejects private schemes and ambiguous arguments", () => {
  const required = [
    `--package-executable=${absolute("Downany.app/Contents/MacOS/Downany")}`,
    `--candidate-artifact=${absolute("Downany.dmg")}`,
    `--playwright-module=${absolute("playwright")}`,
    `--results=${absolute("results.json")}`,
    "--login-url=https://www.douyin.com/video/1",
    "--removed-url=https://www.youtube.com/watch?v=aaaaaaaaaaa",
  ];
  assert.throws(() => parseArguments(["--package-executable=relative", ...required.slice(1)]), /absolute/i);
  assert.throws(() => parseArguments([...required, required[0]]), /duplicate/i);
  assert.throws(() => parseArguments([...required.slice(0, 4), "--login-url=file:///tmp/private", required[5]]), /https/i);
  assert.throws(() => parseArguments([...required, "--target=mac"]), /unknown/i);
});

test("seeded presentation updates accept only owned task ids and approved error codes", () => {
  const assignments = [
    { id: "11111111-1111-4111-8111-111111111111", errorCode: "private" },
    { id: "22222222-2222-4222-8222-222222222222", errorCode: "geo_blocked" },
    { id: "33333333-3333-4333-8333-333333333333", errorCode: "ytdlp_outdated" },
    { id: "44444444-4444-4444-8444-444444444444", errorCode: "need_po_token" },
    { id: "55555555-5555-4555-8555-555555555555", errorCode: "output_path_invalid" },
  ];
  const sql = buildSeededFailureSql(assignments);
  assert.match(sql, /BEGIN IMMEDIATE/);
  assert.match(sql, /ytdlp_outdated/);
  assert.doesNotMatch(sql, /Cookie|Users|https?:/i);
  assert.throws(() => buildSeededFailureSql([
    { ...assignments[0], id: "not-owned'; DROP TABLE task_queue; --" }, ...assignments.slice(1),
  ]), /task id/i);
  assert.throws(() => buildSeededFailureSql([
    { ...assignments[0], errorCode: "unknown" }, ...assignments.slice(1),
  ]), /error code/i);
});
