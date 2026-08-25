import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DIAGNOSTIC_ZIP_MEMBERS,
  assertBridgeUnused,
  assertDiagnosticZipMembers,
  assertSmokeTaskVisible,
  enqueueSmokeTask,
  listZipEntries,
  waitForBridgeReady,
} from "./package_smoke_helpers.mjs";

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

function refused() {
  return Object.assign(new TypeError("fetch failed"), {
    cause: { code: "ECONNREFUSED" },
  });
}

function zipFixture(entries, { encrypted = false } = {}) {
  const locals = [];
  const centrals = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.isBuffer(entry) ? entry : Buffer.from(entry, "utf8");
    const flags = 0x0800 | (encrypted ? 0x0001 : 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centrals.push(central, name);
    localOffset += local.length + name.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...locals, centralDirectory, end]);
}

test("bridge preflight accepts only a refused local connection", async () => {
  await assert.doesNotReject(() =>
    assertBridgeUnused(async () => {
      throw refused();
    }),
  );
  await assert.rejects(
    () => assertBridgeUnused(async () => jsonResponse(200, { ok: true })),
    /already responding/i,
  );
  await assert.rejects(
    () =>
      assertBridgeUnused(async () => {
        throw new Error("certificate failure");
      }),
    /could not prove.*unused/i,
  );
});

test("waits through connection refusal and sidecar startup until bridge is ready", async () => {
  const responses = [
    refused(),
    jsonResponse(200, {
      ok: true,
      service: "downany-bridge",
      sidecarReady: false,
    }),
    jsonResponse(200, {
      ok: true,
      service: "downany-bridge",
      sidecarReady: true,
    }),
  ];
  const health = await waitForBridgeReady({
    fetchImpl: async () => {
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    child: { exitCode: null, signalCode: null },
    timeoutMs: 1_000,
    pollIntervalMs: 0,
    sleep: async () => undefined,
    getStderr: () => "",
  });

  assert.equal(health.sidecarReady, true);
  assert.equal(responses.length, 0);
});

test("stops waiting when packaged Electron exits before bridge readiness", async () => {
  await assert.rejects(
    () =>
      waitForBridgeReady({
        fetchImpl: async () => {
          throw refused();
        },
        child: { exitCode: 9, signalCode: null },
        timeoutMs: 1_000,
        pollIntervalMs: 0,
        sleep: async () => undefined,
        getStderr: () => "fixture stderr",
      }),
    /exited.*9.*fixture stderr/i,
  );
});

test("enqueue and task lookup prove the same non-unknown task", async () => {
  const requests = [];
  const taskId = await enqueueSmokeTask({
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return jsonResponse(200, { ok: true, count: 1, taskIds: ["task-1"] });
    },
  });
  await assertSmokeTaskVisible({
    taskId,
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return jsonResponse(200, {
        ok: true,
        tasks: [{ id: "task-1", status: "pending", progress: 0 }],
      });
    },
  });

  assert.equal(taskId, "task-1");
  assert.equal(requests[0].url, "http://127.0.0.1:17888/enqueue");
  assert.equal(requests[0].options.method, "POST");
  const payload = JSON.parse(requests[0].options.body);
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].url, "https://example.com/downany-package-smoke");
  assert.equal(
    requests[1].url,
    "http://127.0.0.1:17888/tasks?ids=task-1",
  );
});

test("task lookup rejects unknown or mismatched tasks", async () => {
  await assert.rejects(
    () =>
      assertSmokeTaskVisible({
        taskId: "task-1",
        fetchImpl: async () =>
          jsonResponse(200, {
            ok: true,
            tasks: [{ id: "task-1", status: "unknown" }],
          }),
      }),
    /unknown/i,
  );
  await assert.rejects(
    () =>
      assertSmokeTaskVisible({
        taskId: "task-1",
        fetchImpl: async () =>
          jsonResponse(200, {
            ok: true,
            tasks: [{ id: "other", status: "pending" }],
          }),
      }),
    /task-1/i,
  );
});

test("reads the exact privacy-safe diagnostic ZIP members", () => {
  const archive = zipFixture(DIAGNOSTIC_ZIP_MEMBERS);
  assert.deepEqual(listZipEntries(archive), DIAGNOSTIC_ZIP_MEMBERS);
  assert.deepEqual(assertDiagnosticZipMembers(archive), DIAGNOSTIC_ZIP_MEMBERS);
  assert.throws(
    () => assertDiagnosticZipMembers(zipFixture(DIAGNOSTIC_ZIP_MEMBERS.slice(1))),
    /diagnostic ZIP members.*environment\.json/i,
  );
  assert.throws(
    () => assertDiagnosticZipMembers(zipFixture([...DIAGNOSTIC_ZIP_MEMBERS, "raw.log"])),
    /diagnostic ZIP members.*raw\.log/i,
  );
});

test("rejects truncated, duplicate, encrypted, invalid UTF-8, and overflowing ZIP metadata", () => {
  const valid = zipFixture(DIAGNOSTIC_ZIP_MEMBERS);
  assert.throws(() => listZipEntries(valid.subarray(0, valid.length - 5)), /end record/i);
  assert.throws(
    () => listZipEntries(zipFixture(["privacy.json", "privacy.json"])),
    /duplicate/i,
  );
  assert.throws(
    () => listZipEntries(zipFixture(["privacy.json"], { encrypted: true })),
    /encrypted/i,
  );
  assert.throws(
    () => listZipEntries(zipFixture([Buffer.from([0xff])])),
    /UTF-8/i,
  );

  const overflowing = Buffer.from(valid);
  overflowing.writeUInt32LE(0xfffffffe, overflowing.length - 10);
  assert.throws(() => listZipEntries(overflowing), /bounds/i);

  const mismatchedLocalName = zipFixture(["privacy.json"]);
  mismatchedLocalName[30] = "x".charCodeAt(0);
  assert.throws(() => listZipEntries(mismatchedLocalName), /local.*name/i);
});
