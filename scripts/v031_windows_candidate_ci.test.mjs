import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
const workflow = fs.readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8").replaceAll("\r\n", "\n");
function step(name) {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  assert.ok(start >= 0, `Missing workflow step: ${name}`);
  const next = workflow.indexOf("      - name:", start + 10);
  return workflow.slice(start, next < 0 ? undefined : next);
}
test("release packaging binds app, lock, protocol, tag and candidate manifest versions", () => {
  const versions = step("Read locked release versions");
  assert.match(versions, /lock\.packages\[''\]\.version !== app\.version/);
  assert.match(versions, /protocol !== app\.version/);
  assert.match(versions, /GITHUB_REF_NAME !== `v\$\{app\.version\}`/);
  for (const name of ["Record Windows release candidate", "Record macOS release candidate"]) {
    const record = step(name);
    assert.match(record, /--expected-version=\$\{\{ steps\.release_versions\.outputs\.version \}\}/);
    assert.match(record, /--expected-extension-version=\$\{\{ steps\.release_versions\.outputs\.extension \}\}/);
    assert.doesNotMatch(record, /Downany-0\.3\.1/);
  }
});
test("tag packaging executes the original installer and upgrade gate before publishing the artifact", () => {
  for (const name of ["Install Windows upgrade gate runtime", "Download official v0.3.0 Windows installer", "Verify official v0.3.0 Windows installation and upgrade"]) {
    const gate = step(name);
    assert.match(gate, /if: matrix\.target == 'win32-x64'/);
    assert.doesNotMatch(gate, /github\.event_name == 'workflow_dispatch'/);
  }
  assert.match(step("Download official v0.3.0 Windows installer"), /db2c3df75e9097573c3525c58e7a1c98ba276c29ad60faa22d6d7fef9adaa8cb/);
  const upgrade = step("Verify official v0.3.0 Windows installation and upgrade");
  assert.match(upgrade, /run_v031_windows_upgrade\.mjs/);
  assert.match(upgrade, /--candidate-version=\$\{\{ steps\.release_versions\.outputs\.version \}\}/);
  assert.ok(workflow.indexOf(upgrade) < workflow.indexOf('      - name: Upload verified installer'));
});
