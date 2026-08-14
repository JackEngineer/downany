const assert = require("node:assert");

require("./shared.js");

const { fetchWithTimeout } = globalThis.VideoDlShared;

async function main() {
  const startedAt = Date.now();
  const response = await fetchWithTimeout(
    "http://127.0.0.1:17888/enqueue",
    { method: "POST" },
    undefined,
    (_url, options) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ ok: true }), 2600);
        options.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("bridge request aborted too early"));
          },
          { once: true },
        );
      }),
  );

  assert.strictEqual(response.ok, true);
  assert.ok(Date.now() - startedAt >= 2500);
  console.log("bridge enqueue timeout test passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
