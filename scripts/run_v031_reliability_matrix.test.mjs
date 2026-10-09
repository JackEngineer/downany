import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { runIsolatedAttempt, runMatrix } from "./run_v031_reliability_matrix.mjs";
import { collectMatrixCase, mergeTargetResults } from "./v031_matrix_run_helpers.mjs";

const sourceUrl = "https://private.invalid/collection?secret=fixture";
const row = { id: "douyin-08", scenario: "collection", expectation: "downloadable" };
const candidateSha256 = "b".repeat(64);

// Execute the real page.evaluate callbacks; only the external Electron/IPC boundary is replaced.
function candidateFixture(t, { payload, unrelatedPayload, early = false, requestError, evaluateError, reply = { parseId: "parse-1" } } = {}) {
  const listeners = new Set();
  const requests = [];
  let root;
  let closed = false;
  let config;
  const emit = () => {
    if (unrelatedPayload) for (const listener of listeners) listener({ event: "download.parseResult", payload: unrelatedPayload });
    if (payload) for (const listener of listeners) listener({ event: "download.parseResult", payload });
  };
  const api = {
    onEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    request: async (method, params) => {
      requests.push({ method, params });
      if (method === "settings.get") return config;
      if (method === "download.parseUrls") {
        assert.deepEqual(Array.from(params.urls), [sourceUrl]);
        assert.equal(params.allow_playlist, true);
        if (requestError) throw requestError;
        if (early) emit(); else setImmediate(emit);
        return reply;
      }
      if (method === "download.createTasks") return { taskIds: ["task-1"] };
      if (method === "app.getSnapshot") return { tasks: [{ id: "task-1", status: "failed", error_code: "network" }] };
      throw new Error("Unexpected fixture method");
    },
  };
  const context = vm.createContext({ window: { api }, setTimeout: (callback) => setTimeout(callback, 10), clearTimeout });
  const page = {
    waitForFunction: async () => {},
    evaluate: async (callback, argument) => {
      if (evaluateError && argument?.sourceUrl) throw evaluateError;
      context.argument = argument;
      return vm.runInContext(`(${callback.toString()})(argument)`, context);
    },
  };
  const playwright = { _electron: { launch: async ({ env }) => {
    root = path.dirname(env.DOWNANY_DATA_DIR);
    config = JSON.parse(fs.readFileSync(path.join(env.DOWNANY_DATA_DIR, "config.json"), "utf8"));
    return { firstWindow: async () => page, evaluate: async () => ({ version: "0.3.1" }),
      process: () => null, close: async () => { closed = true; } };
  } } };
  t.after(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });
  return {
    collect: () => collectMatrixCase({ target: "macos-arm64", candidateSha256, row, url: sourceUrl,
      credentialSource: "none", runAttempt: (attempt) => runIsolatedAttempt({
        target: "macos-arm64", executable: path.resolve("/tmp/fixture/Downany"), expectedVersion: "0.3.1", timeoutMs: 100,
      }, playwright, "/unused-media-tools", attempt) }),
    requests,
    assertCleaned: () => {
      assert.equal(closed, true);
      assert.equal(fs.existsSync(path.join(root, "downany-data")), false);
      assert.equal(fs.existsSync(path.join(root, "electron-profile")), false);
      assert.equal(listeners.size, 0);
    },
  };
}

for (const [label, payload] of [
  ["candidate parse rejection", { parseId: "parse-1", ok: false, error: "Cookie: secret https://private.invalid/error", error_code: "secret" }],
  ["accepted parse timeout", undefined],
  ["no collection entries", { parseId: "parse-1", ok: true }],
  ["no available entry", { parseId: "parse-1", ok: true, entries: [{ url: sourceUrl, available: "0" }] }],
  ["boolean unavailable entry", { parseId: "parse-1", ok: true, entries: [{ url: sourceUrl, available: false }] }],
]) {
  test(`${label} survives the isolated attempt and merge as a sanitized failure without a task`, async (t) => {
    const fixture = candidateFixture(t, { payload });
    const result = await fixture.collect();
    assert.equal(result.outcome, "failed");
    assert.equal(result.artifactPlayable, false);
    assert.equal(result.failureStage, "collection_parse");
    assert.equal(result.errorCode, "");
    assert.equal(result.artifactSha256, undefined);
    assert.match(result.sampleSha256, /^[a-f0-9]{64}$/);
    const merged = mergeTargetResults([], [result]);
    assert.deepEqual(merged, [result]);
    assert.doesNotMatch(JSON.stringify(merged), /private|Cookie|secret|error_code|error_message|stack|taskId/i);
    assert.equal(fixture.requests.some(({ method }) => method === "download.createTasks"), false);
    fixture.assertCleaned();
  });
}

test("a matching parse result arriving before its acknowledgement still creates the selected task", async (t) => {
  const fixture = candidateFixture(t, { early: true, unrelatedPayload: { parseId: "other-parse", ok: false },
    payload: { parseId: "parse-1", ok: true,
    entries: [{ url: "https://private.invalid/blocked", available: "0" },
      { url: "https://private.invalid/selected", available: "1", title: "Selected", index: 2 }],
    playlist: { title: "Collection" } } });
  const result = await fixture.collect();
  assert.equal(result.outcome, "failed");
  assert.equal(result.errorCode, "network");
  assert.equal(result.failureStage, undefined);
  const created = fixture.requests.find(({ method }) => method === "download.createTasks").params;
  assert.deepEqual(Array.from(created.urls), ["https://private.invalid/selected"]);
  assert.equal(created.items[0].playlist_index, 2);
  assert.equal(created.expandPlaylists, false);
  fixture.assertCleaned();
});

for (const [label, options] of [
  ["IPC rejection", { requestError: new Error("fixture IPC disconnected") }],
  ["page environment failure", { evaluateError: new TypeError("fixture page unavailable") }],
  ["invalid acknowledgement", { reply: {} }],
  ["invalid parse result", { payload: { parseId: "parse-1", ok: "false" } }],
  ["cancelled parse", { payload: { parseId: "parse-1", ok: false, cancelled: true } }],
  ["invalid entries", { payload: { parseId: "parse-1", ok: true, entries: "invalid" } }],
]) {
  test(`${label} is not converted into collection evidence`, async (t) => {
    const fixture = candidateFixture(t, options);
    await assert.rejects(fixture.collect);
    assert.equal(fixture.requests.some(({ method }) => method === "download.createTasks"), false);
    fixture.assertCleaned();
  });
}

for (const mode of ["batch", "resume", "replacement", "other_candidate", "other_target", "exact_url"]) {
  const caseOnly = !["batch", "exact_url"].includes(mode);
  const blocked = ["batch", "resume", "exact_url"].includes(mode);
  test(`default independence preflight handles ${mode} without inventing evidence`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "downany-alias-preflight-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const matrixPath = path.join(root, "matrix.json");
    const rows = JSON.parse(fs.readFileSync(new URL("../docs/acceptance/v0.3.1-reliability-matrix.json", import.meta.url), "utf8"));
    fs.writeFileSync(matrixPath, JSON.stringify(rows));
    const candidateArtifact = path.join(root, "candidate.dmg");
    const executable = path.join(root, "Downany");
    fs.writeFileSync(candidateArtifact, "candidate"); fs.writeFileSync(executable, "fixture");
    const target = process.platform === "darwin" ? "macos-arm64" : process.platform === "win32" ? "windows-x64" : `${process.platform}-${process.arch}`;
    const candidateSha = createHash("sha256").update("candidate").digest("hex");
    const urls = ["https://private.invalid/bv-alias", "https://private.invalid/av-alias"];
    const review = JSON.parse(fs.readFileSync(new URL("../docs/acceptance/v0.3.1-sample-independence-review.json", import.meta.url), "utf8"));
    review.groups[0].sampleSha256s = urls.map((url) => createHash("sha256").update(url).digest("hex"));
    const originalRead = fs.readFileSync;
    t.mock.method(fs, "readFileSync", (file, ...args) => String(file).endsWith("v0.3.1-sample-independence-review.json") ? JSON.stringify(review) : originalRead(file, ...args));
    for (const [index, row] of rows.entries()) {
      const old = process.env[row.urlSource];
      process.env[row.urlSource] = `https://private.invalid/unique-${index}`;
      t.after(() => { if (old === undefined) delete process.env[row.urlSource]; else process.env[row.urlSource] = old; });
    }
    process.env.DOWNANY_BILIBILI_01 = urls[0]; process.env.DOWNANY_BILIBILI_03 = urls[1];
    const resultsPath = path.join(root, "results.json");
    const existing = caseOnly ? [{ target, candidateSha256: candidateSha, id: "bilibili-03", sampleSha256: review.groups[0].sampleSha256s[1], outcome: "completed", artifactPlayable: true }] : [];
    if (mode === "replacement") {
      existing.push({ target, candidateSha256: candidateSha, id: "bilibili-01", sampleSha256: review.groups[0].sampleSha256s[0], outcome: "completed", artifactPlayable: true });
      process.env.DOWNANY_BILIBILI_01 = "https://private.invalid/new-sample-needs-real-rerun";
    }
    if (mode === "other_candidate") existing[0].candidateSha256 = "f".repeat(64);
    if (mode === "other_target") existing[0].target = "another-target";
    if (mode === "exact_url") {
      process.env.DOWNANY_BILIBILI_01 = "https://private.invalid/same-raw-url";
      process.env.DOWNANY_BILIBILI_03 = "https://private.invalid/same-raw-url";
    }
    const originalEvidence = JSON.stringify(existing);
    fs.writeFileSync(resultsPath, originalEvidence);
    // Blocked inputs never load Playwright or call runAttempt. A permitted replacement still
    // reaches the real execution boundary; it cannot acquire new evidence from old rows.
    await assert.rejects(() => runMatrix({ target, executable, candidateArtifact, matrixPath, resultsPath,
      playwrightModule: path.join(root, "never-load-playwright"), cookiesFromBrowser: "chrome", expectedVersion: "0.3.1",
      caseId: caseOnly ? "bilibili-01" : "" }), blocked
        ? /^Error: Sample independence review rejected duplicate content$/ : /Cannot find module 'playwright'/);
    assert.equal(fs.readFileSync(resultsPath, "utf8"), originalEvidence);
    assert.equal(fs.readdirSync(root).some((name) => name.includes(".tmp-") || name.endsWith(".bak")), false);
  });
}
