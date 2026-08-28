const test = require("node:test");
const assert = require("node:assert/strict");
const { assertActionable } = require("./key-path-verify.cjs");

const valid = {
  name: "Export diagnostics", enabled: true, hit: true,
  overflowingContainers: [],
  rect: { left: 20, top: 40, right: 200, bottom: 70, width: 180, height: 30 },
  viewport: { width: 524, height: 441, clientWidth: 524, scrollWidth: 524 },
};
test("accepts an enabled, visible, hittable key action", () => {
  assert.doesNotThrow(() => assertActionable(valid));
});
for (const [name, change] of [
  ["disabled", { enabled: false }],
  ["covered", { hit: false }],
  ["clipped", { rect: { ...valid.rect, right: 525 } }],
  ["no size", { rect: { ...valid.rect, width: 0 } }],
  ["horizontal overflow", { viewport: { ...valid.viewport, scrollWidth: 600 } }],
  ["inner horizontal overflow", { overflowingContainers: ["settings-tabs"] }],
]) {
  test(`rejects a ${name} key action`, () => assert.throws(() => assertActionable({ ...valid, ...change })));
}
