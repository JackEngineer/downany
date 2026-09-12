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
