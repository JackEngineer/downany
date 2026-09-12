import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const workflow = fs.readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

test("Windows packaging records the exact v0.3.1 candidate before upload", () => {
  assert.match(workflow, /name: Record v0\.3\.1 Windows candidate/);
  assert.match(workflow, /--target=windows-x64/);
  assert.match(workflow, /--artifact=desktop\\release\\Downany-0\.3\.1-win-x64\.exe/);
  assert.match(workflow, /docs\/acceptance\/v0\.3\.1-candidate-artifacts\.json/);
});

test("Windows packaging runs the v0.3.0 to v0.3.1 upgrade gate before upload", () => {
  assert.match(workflow, /name: Download official v0\.3\.0 Windows installer/);
  assert.match(workflow, /db2c3df75e9097573c3525c58e7a1c98ba276c29ad60faa22d6d7fef9adaa8cb/);
  assert.match(workflow, /name: Verify v0\.3\.0 to v0\.3\.1 Windows upgrade/);
  assert.match(workflow, /run_v031_windows_upgrade\.mjs/);
  assert.match(workflow, /v0\.3\.1-windows-upgrade-results\.json/);
});
