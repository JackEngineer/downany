import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyAnonymousLoginTask,
  evaluateLoginEvidence,
  sanitizeLoginEvidence,
} from "./v031_login_evidence.mjs";

const anonymousTime = "2026-09-27T06:00:00.000Z";
const authorizedTime = "2026-09-27T06:01:00.000Z";
const firstInstance = "5dab7a94-1d36-4d3d-9c7a-cec7d051ce75";
const secondInstance = "e3756cff-1fae-4d58-a52d-8b02a875011d";
const registeredMessage = "ERROR: [BiliBili] This video is only available for registered users. Use --cookies-from-browser or --cookies for authentication";
const ageMessage = "ERROR: [youtube] Sign in to confirm your age. Use --cookies-from-browser or --cookies for authentication";
const unverified = { outcome: "unverified", restriction: "none" };

function failedTask(error_message) {
  return { status: "failed", error_code: "need_login", error_message };
}

function evidence() {
  return {
    schemaVersion: 1,
    source: "paired-candidate-runs",
    caseId: "youtube-07",
    target: "windows-x64",
    candidateSha256: "a".repeat(64),
    sampleSha256: "b".repeat(64),
    anonymous: {
      credentialSource: "none",
      instanceId: firstInstance,
      outcome: "authentication_required",
      restriction: "registered_users",
      recordedAt: anonymousTime,
    },
    authorized: {
      credentialSource: "browser",
      instanceId: secondInstance,
      recordedAt: authorizedTime,
      artifactSha256: "c".repeat(64),
    },
  };
}

function result() {
  return {
    id: "youtube-07",
    target: "windows-x64",
    candidateSha256: "a".repeat(64),
    sampleSha256: "b".repeat(64),
    outcome: "completed",
    artifactPlayable: true,
    artifactSha256: "c".repeat(64),
    artifactBytes: 1234,
    recordedAt: authorizedTime,
    loginEvidence: evidence(),
  };
}

test("recognizes the registered-users denial without rejecting the normal Cookie help suffix", () => {
  assert.deepEqual(classifyAnonymousLoginTask(failedTask(registeredMessage)), {
    outcome: "authentication_required", restriction: "registered_users",
  });
});

test("recognizes an explicit sign-in-to-confirm-age denial", () => {
  assert.deepEqual(classifyAnonymousLoginTask(failedTask(ageMessage)), {
    outcome: "authentication_required", restriction: "age_confirmation",
  });
});

test("does not confuse the Bilibili business code with HTTP 403", () => {
  assert.deepEqual(classifyAnonymousLoginTask(failedTask(`${registeredMessage}. Business trueCode=-403`)), {
    outcome: "authentication_required", restriction: "registered_users",
  });
});

test("records completed anonymous downloads as disqualified even with a stale error", () => {
  assert.deepEqual(classifyAnonymousLoginTask({ ...failedTask(ageMessage), status: "completed" }), {
    outcome: "downloaded", restriction: "none",
  });
});

for (const status of ["queued", "downloading", "cancelled", "paused", undefined]) {
  test(`does not classify a non-final-failed task: ${status}`, () => {
    assert.deepEqual(classifyAnonymousLoginTask({ ...failedTask(ageMessage), status }), unverified);
  });
}

test("requires the final need_login code and ignores unrelated log fields", () => {
  assert.deepEqual(classifyAnonymousLoginTask({ ...failedTask(ageMessage), error_code: "unknown" }), unverified);
  assert.deepEqual(classifyAnonymousLoginTask({ ...failedTask("unknown"), stderr: ageMessage }), unverified);
  assert.deepEqual(classifyAnonymousLoginTask(null), unverified);
  assert.deepEqual(classifyAnonymousLoginTask(failedTask({ toString() { throw new Error("must not coerce"); } })), unverified);
});

for (const reason of [
  "Fresh cookies (not necessarily logged in) are needed",
  "HTTP Error 403: Forbidden", "HTTP Error 429: Too Many Requests", "403 Forbidden",
  "HTTPError 403", "HTTP/1.1 403", "HTTP/2 429", "Response status: 403",
  "HTTP Error 503: Service Unavailable", "[Errno 8] nodename nor servname provided, or not known",
  "0 bytes read, 1024 more expected",
  "The request timed out", "Network failure", "Connection reset", "TLS handshake failed",
  "SSL certificate verification failed", "Proxy connection failed", "ECONNRESET",
  "Captcha challenge", "Sign in to confirm you are not a bot", "机器人检查", "安全验证",
  "Please verify you are human", "Confirm you're human",
  "Verification challenge", "This session has been rate-limited", "PO Token required", "gvs_po missing",
  "CookieLoadError", "Failed to decrypt with DPAPI", "database is locked",
  "could not find firefox cookies database", "Could not copy Chrome cookie database",
  "Failed to read cookies", "Unable to load cookies", "Permission denied: Cookies",
  "Only preview format is available",
]) {
  test(`rejects mixed authentication text when the failure also contains ${reason}`, () => {
    assert.deepEqual(classifyAnonymousLoginTask(failedTask(`${ageMessage}. ${reason}`)), unverified);
  });
}

for (const message of [
  "Sign in to watch", "login required", "Please provide cookies for authentication",
  "This video is age-restricted; some formats may be missing without authentication",
  "This video is for premium members only", "Private video", "This video is not available in your country",
]) {
  test(`does not promote an unsupported restriction or generic hint: ${message}`, () => {
    assert.deepEqual(classifyAnonymousLoginTask(failedTask(message)), unverified);
  });
}

test("sanitizes paired evidence by copying only schema-approved fields", () => {
  const value = evidence();
  value.url = "https://secret.invalid/video";
  value.error_message = "Cookie: secret";
  value.anonymous.rawError = "Cookie: anonymous-secret";
  value.anonymous.taskId = "private-task";
  value.authorized.cookiefile = "/private/cookies.txt";
  const sanitized = sanitizeLoginEvidence(value);
  assert.deepEqual(sanitized, evidence());
  assert.notEqual(sanitized, value);
  assert.notEqual(sanitized.anonymous, value.anonymous);
  assert.doesNotMatch(JSON.stringify(sanitized), /secret|private|Cookie|rawError|taskId/);
});

for (const outcome of ["downloaded", "unverified"]) {
  test(`retains ${outcome} anonymous diagnostics with no authorized attempt`, () => {
    const value = evidence();
    value.anonymous.outcome = outcome;
    value.anonymous.restriction = "none";
    value.authorized = null;
    assert.deepEqual(sanitizeLoginEvidence(value), value);
    assert.equal(evaluateLoginEvidence({ ...result(), loginEvidence: value }), false);
  });
}

test("retains an authorized failure without a usable artifact hash but does not pass it", () => {
  for (const hash of [undefined, "", "https://secret.invalid", { toString() { throw new Error("must not coerce"); } }]) {
    const value = evidence();
    value.authorized.artifactSha256 = hash;
    const expected = evidence();
    delete expected.authorized.artifactSha256;
    assert.deepEqual(sanitizeLoginEvidence(value), expected);
    assert.equal(evaluateLoginEvidence({ ...result(), loginEvidence: value }), false);
  }
});

const malformedEvidence = [
  ["schema", (v) => { v.schemaVersion = "1"; }],
  ["source", (v) => { v.source = "manual"; }],
  ["missing case ID", (v) => { delete v.caseId; }],
  ["unsafe case ID", (v) => { v.caseId = "https://secret.invalid"; }],
  ["out-of-range case ID", (v) => { v.caseId = "youtube-11"; }],
  ["zero case ID", (v) => { v.caseId = "douyin-00"; }],
  ["unsupported case platform", (v) => { v.caseId = "other-01"; }],
  ["target", (v) => { v.target = "https://secret.invalid"; }],
  ["candidate hash", (v) => { v.candidateSha256 = "secret"; }],
  ["sample hash", (v) => { v.sampleSha256 = { toString() { throw new Error("must not coerce"); } }; }],
  ["anonymous credentials", (v) => { v.anonymous.credentialSource = "browser"; }],
  ["anonymous UUID", (v) => { v.anonymous.instanceId = "/private/profile"; }],
  ["authorized UUID", (v) => { v.authorized.instanceId = "00000000-0000-0000-0000-000000000000"; }],
  ["anonymous outcome", (v) => { v.anonymous.outcome = "Cookie: secret"; }],
  ["unsupported membership", (v) => { v.anonymous.restriction = "members_only"; }],
  ["missing restriction", (v) => { v.anonymous.restriction = "none"; }],
  ["contradictory restriction", (v) => { v.anonymous.outcome = "downloaded"; }],
  ["unsafe anonymous time", (v) => { v.anonymous.recordedAt = "2026-09-27T06:00:00.000Z Cookie: secret"; }],
  ["impossible date", (v) => { v.anonymous.recordedAt = "2026-02-30T06:00:00.000Z"; }],
  ["unsafe authorized time", (v) => { v.authorized.recordedAt = "https://secret.invalid"; }],
  ["authorized credentials", (v) => { v.authorized.credentialSource = "none"; }],
  ["missing authorized object", (v) => { delete v.authorized; }],
];
for (const [name, mutate] of malformedEvidence) {
  test(`rejects malformed evidence without string coercion or partial leaks: ${name}`, () => {
    const value = evidence();
    mutate(value);
    assert.equal(sanitizeLoginEvidence(value), undefined);
    assert.equal(evaluateLoginEvidence({ ...result(), loginEvidence: value }), false);
  });
}

test("rejects non-object evidence", () => {
  for (const value of [null, undefined, true, "secret", [], 1]) {
    assert.equal(sanitizeLoginEvidence(value), undefined);
    assert.equal(evaluateLoginEvidence(value), false);
  }
});

test("accepts a complete bound pair for either authorized credential source", () => {
  for (const source of ["browser", "cookiefile"]) {
    const value = result();
    value.loginEvidence.authorized.credentialSource = source;
    assert.equal(evaluateLoginEvidence(value), true);
  }
});

test("accepts the other supported target and explicit age confirmation", () => {
  const value = result();
  value.target = value.loginEvidence.target = "macos-arm64";
  value.loginEvidence.anonymous.restriction = "age_confirmation";
  assert.equal(evaluateLoginEvidence(value), true);
});

const invalidResult = [
  ["legacy result", (v) => { delete v.loginEvidence; }],
  ["missing outer case ID", (v) => { delete v.id; }],
  ["case mismatch", (v) => { v.id = "youtube-06"; }],
  ["candidate mismatch", (v) => { v.candidateSha256 = "d".repeat(64); }],
  ["sample mismatch", (v) => { v.sampleSha256 = "d".repeat(64); }],
  ["target mismatch", (v) => { v.target = "macos-arm64"; }],
  ["not completed", (v) => { v.outcome = "failed"; }],
  ["not playable", (v) => { v.artifactPlayable = false; }],
  ["coerced playable", (v) => { v.artifactPlayable = "true"; }],
  ["missing artifact hash", (v) => { delete v.artifactSha256; }],
  ["unsafe artifact hash", (v) => { v.artifactSha256 = "Cookie: secret"; }],
  ["artifact mismatch", (v) => { v.artifactSha256 = "d".repeat(64); }],
  ["empty artifact", (v) => { v.artifactBytes = 0; }],
  ["non-numeric bytes", (v) => { v.artifactBytes = "1234"; }],
  ["infinite bytes", (v) => { v.artifactBytes = Infinity; }],
  ["fractional bytes", (v) => { v.artifactBytes = 1.5; }],
  ["reused instance", (v) => { v.loginEvidence.authorized.instanceId = firstInstance; }],
  ["reused UUID with other casing", (v) => { v.loginEvidence.authorized.instanceId = firstInstance.toUpperCase(); }],
  ["recorded time mismatch", (v) => { v.recordedAt = "2026-09-27T06:02:00.000Z"; }],
  ["simultaneous attempts", (v) => { v.loginEvidence.anonymous.recordedAt = authorizedTime; }],
  ["reverse attempt order", (v) => { v.loginEvidence.anonymous.recordedAt = "2026-09-27T06:02:00.000Z"; }],
  ["more than three hours", (v) => { v.recordedAt = v.loginEvidence.authorized.recordedAt = "2026-09-27T09:00:00.001Z"; }],
];
for (const [name, mutate] of invalidResult) {
  test(`does not qualify a result with ${name}`, () => {
    const value = result();
    mutate(value);
    assert.equal(evaluateLoginEvidence(value), false);
  });
}

test("accepts a pair exactly three hours apart", () => {
  const value = result();
  value.recordedAt = value.loginEvidence.authorized.recordedAt = "2026-09-27T09:00:00.000Z";
  assert.equal(evaluateLoginEvidence(value), true);
});

test("accepts all supported case platforms and boundary numbers", () => {
  for (const platform of ["youtube", "bilibili", "douyin"]) {
    for (const number of ["01", "10"]) {
      const value = result();
      value.id = value.loginEvidence.caseId = `${platform}-${number}`;
      assert.equal(evaluateLoginEvidence(value), true);
    }
  }
});
