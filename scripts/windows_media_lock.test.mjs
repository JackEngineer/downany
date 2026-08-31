import assert from "node:assert/strict";
import test from "node:test";

const retainedLock = {
  schemaVersion: 1,
  repository: "BtbN/FFmpeg-Builds",
  tag: "autobuild-2026-07-31-14-10",
  retentionClass: "monthly-final",
  asset: "ffmpeg-n7.1.5-12-g1fdbca85aa-win64-gpl-7.1.zip",
  url:
    "https://github.com/BtbN/FFmpeg-Builds/releases/download/" +
    "autobuild-2026-07-31-14-10/ffmpeg-n7.1.5-12-g1fdbca85aa-win64-gpl-7.1.zip",
  sha256: "c067a1ca58f4fc4449f4bab0890fbcd65cbb3e5f46e066cf9c768e06c0c1d4d9",
};

async function loadLockModule() {
  try {
    return await import("./windows_media_lock.mjs");
  } catch (error) {
    assert.fail(`Windows media lock module is unavailable: ${error}`);
  }
}

function githubAsset(lock = retainedLock) {
  return {
    id: 1001,
    name: lock.asset,
    label: null,
    state: "uploaded",
    content_type: "application/zip",
    size: 158697002,
    digest: `sha256:${lock.sha256}`,
    browser_download_url:
      `https://github.com/${lock.repository}/releases/download/${lock.tag}/${lock.asset}`,
    url: `https://api.github.com/repos/${lock.repository}/releases/assets/1001`,
  };
}

test("rejects a daily Windows media lock that is not covered by monthly retention", async () => {
  const { validateWindowsMediaLock } = await loadLockModule();

  assert.throws(
    () => validateWindowsMediaLock({ ...retainedLock, retentionClass: "daily" }),
    /monthly-final/,
  );
});

test("keeps the normalized lock valid for the command-line verification pass", async () => {
  const { validateWindowsMediaLock } = await loadLockModule();

  const normalized = validateWindowsMediaLock(retainedLock);

  assert.doesNotThrow(() => validateWindowsMediaLock(normalized));
});

test("verifies the retained GitHub asset and its published SHA-256 digest", async () => {
  const { verifyWindowsMediaLock } = await loadLockModule();
  const asset = githubAsset();
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push([String(url), init.method ?? "GET"]);
    if (String(url).startsWith("https://api.github.com/")) {
      return new Response(
        JSON.stringify({
          id: 2001,
          tag_name: retainedLock.tag,
          draft: false,
          prerelease: false,
          assets: [asset],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(null, { status: 200 });
  };

  const result = await verifyWindowsMediaLock(retainedLock, { fetchImpl });

  assert.deepEqual(result, {
    url: asset.browser_download_url,
    sha256: retainedLock.sha256,
    asset: retainedLock.asset,
  });
  assert.deepEqual(calls, [
    [
      `https://api.github.com/repos/${retainedLock.repository}/releases/tags/${retainedLock.tag}`,
      "GET",
    ],
    [asset.browser_download_url, "HEAD"],
  ]);
});

test("reports a pruned upstream release before packaging starts", async () => {
  const { verifyWindowsMediaLock } = await loadLockModule();
  const fetchImpl = async () =>
    new Response(JSON.stringify({ message: "Not Found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });

  await assert.rejects(
    verifyWindowsMediaLock(retainedLock, { fetchImpl }),
    /release tag .* is unavailable \(HTTP 404\)/,
  );
});
