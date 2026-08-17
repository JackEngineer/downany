const nodeAssert = require("node:assert/strict");
const test = require("node:test");

const {
  assert: assertVerification,
  waitFor,
} = require("./verification-utils.cjs");

test("assert 会在失败消息中附带结构化上下文", () => {
  nodeAssert.doesNotThrow(() => assertVerification(true, "无需抛错"));
  nodeAssert.throws(
    () => assertVerification(false, "布局越界", { width: 761, limit: 760 }),
    (error) => {
      nodeAssert.equal(
        error.message,
        '布局越界\n{\n  "width": 761,\n  "limit": 760\n}',
      );
      return true;
    },
  );
});

test("waitFor 将表达式交给页面并等待两端确认", async () => {
  const calls = [];
  const win = {
    webContents: {
      executeJavaScript: async (source, userGesture) => {
        calls.push({ source, userGesture });
        return true;
      },
    },
  };

  await waitFor(win, "window.__layoutReady === true", "生产布局");

  nodeAssert.equal(calls.length, 1);
  nodeAssert.match(calls[0].source, /if \(window\.__layoutReady === true\)/);
  nodeAssert.match(calls[0].source, /等待 生产布局 超时/);
  nodeAssert.equal(calls[0].userGesture, true);
});

test("waitFor 会拒绝页面未确认的结果", async () => {
  const win = {
    webContents: {
      executeJavaScript: async () => false,
    },
  };

  await nodeAssert.rejects(
    waitFor(win, "false", "任务列表"),
    /任务列表 未就绪/,
  );
});
