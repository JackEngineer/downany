const assert = require("node:assert/strict");
const test = require("node:test");

const { runBestEffortCleanup } = require("./cleanup.cjs");

test("runBestEffortCleanup 会在单个步骤失败后继续清理", async () => {
  const calls = [];
  const detachError = new Error("debugger detach failed");

  await assert.rejects(
    runBestEffortCleanup([
      {
        label: "分离调试器",
        run: () => {
          calls.push("detach");
          throw detachError;
        },
      },
      {
        label: "销毁窗口",
        run: async () => {
          calls.push("destroy");
        },
      },
      {
        label: "删除临时目录",
        run: () => {
          calls.push("remove-temp");
        },
      },
    ]),
    (error) => {
      assert.equal(error.message, "清理步骤「分离调试器」失败: debugger detach failed");
      assert.equal(error.cause, detachError);
      return true;
    },
  );

  assert.deepEqual(calls, ["detach", "destroy", "remove-temp"]);
});

test("runBestEffortCleanup 汇总多个失败并保留每个步骤的上下文", async () => {
  const calls = [];

  await assert.rejects(
    runBestEffortCleanup([
      {
        label: "销毁窗口",
        run: () => {
          calls.push("destroy");
          throw new Error("window destroy failed");
        },
      },
      {
        label: "恢复用户目录",
        run: async () => {
          calls.push("restore-user-data");
          throw new Error("setPath failed");
        },
      },
      {
        label: "删除临时目录",
        run: () => {
          calls.push("remove-temp");
        },
      },
    ]),
    (error) => {
      assert(error instanceof AggregateError);
      assert.equal(error.message, "2 个清理步骤失败");
      assert.deepEqual(
        error.errors.map((item) => item.message),
        [
          "清理步骤「销毁窗口」失败: window destroy failed",
          "清理步骤「恢复用户目录」失败: setPath failed",
        ],
      );
      return true;
    },
  );

  assert.deepEqual(calls, ["destroy", "restore-user-data", "remove-temp"]);
});
