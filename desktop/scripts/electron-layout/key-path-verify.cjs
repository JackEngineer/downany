const path = require("node:path");
const { assert, waitFor } = require("./verification-utils.cjs");
const { createFixtureSnapshot } = require("./fixture.cjs");

function assertActionable(action) {
  const { rect, viewport } = action;
  assert(action.enabled && action.hit, `关键操作不可用: ${action.name}`, action);
  assert(rect.width >= 20 && rect.height >= 20 && rect.left >= 0 && rect.top >= 0 &&
    rect.right <= viewport.width + 0.5 && rect.bottom <= viewport.height + 0.5,
  `关键操作被裁切: ${action.name}`, action);
  assert(viewport.scrollWidth <= viewport.clientWidth + 1, "关键路径出现横向溢出", action);
  assert(action.overflowingContainers.length === 0, "关键容器需要横向滚动", action);
}

async function inspectAction(win, selector, name, click = false) {
  const action = await win.webContents.executeJavaScript(`(async () => {
    const target = [...document.querySelectorAll(${JSON.stringify(selector)})].find(
      (node) => (node.getAttribute("aria-label") || node.textContent || "").trim() === ${JSON.stringify(name)},
    );
    if (!(target instanceof HTMLElement)) throw new Error(${JSON.stringify(`找不到操作: ${name}`)});
    target.scrollIntoView({ block: "center", inline: "nearest" });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rect = target.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const shell = document.querySelector(".settings-shell");
    const value = {
      name: ${JSON.stringify(name)}, enabled: !target.disabled,
      overflowingContainers: [...document.querySelectorAll(".settings-shell, .settings-tabs, .action-bar")]
        .filter((node) => node.scrollWidth > node.clientWidth + 1).map((node) => node.className),
      hit: hit === target || target.contains(hit),
      rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
      viewport: { width: innerWidth, height: innerHeight, clientWidth: document.documentElement.clientWidth,
        scrollWidth: Math.max(document.documentElement.scrollWidth, shell?.scrollWidth || 0) },
    };
    if (${JSON.stringify(click)}) target.click();
    return value;
  })()`, true);
  assertActionable(action);
  return action;
}

async function english(win) {
  await win.webContents.executeJavaScript(`localStorage.setItem("downany.locale", "en");
    window.dispatchEvent(new StorageEvent("storage", { key: "downany.locale" }));`, true);
}

async function verifyKeyPaths(win, harness) {
  // Outer Windows minimum sizes, including the native frame, not just CSS width.
  win.setSize(760, 560);
  await english(win);
  await waitFor(win, 'document.querySelector(".action-bar button")?.textContent.trim() === "Add"', "英文主操作");
  const actions = [];
  for (const name of ["Add", "Recognize page", "Search", "Settings"]) {
    actions.push(await inspectAction(win, ".action-bar button", name));
  }
  const base = createFixtureSnapshot(harness.tempDir).tasks[0];
  for (const task of [
    { ...base, id: "key-failed", title: "我的失败任务", status: "failed", error_code: "network", queue_order: -2 },
    { ...base, id: "key-group", title: "我的视频", status: "paused", group_id: "key-group", group_title: "我的合集", queue_order: -1 },
  ]) win.webContents.send("layout-fixture:event", { event: "task.created", payload: { task } });
  await waitFor(win, 'document.querySelector("#task-key-failed") && document.querySelector(".playlist-group-actions")', "英文恢复与合集");
  actions.push(await inspectAction(win, "#task-key-failed button", "Retry"));
  actions.push(await inspectAction(win, "#task-key-failed button", "Network settings"));
  actions.push(await inspectAction(win, ".playlist-group-actions button", "Resume"));
  actions.push(await inspectAction(win, ".playlist-group-actions button", "Delete", true));
  await waitFor(win, 'document.querySelector(".playlist-group-delete")', "合集删除确认");
  actions.push(await inspectAction(win, ".playlist-group-delete button", "Confirm deletion"));
  actions.push(await inspectAction(win, ".playlist-group-delete button", "Back", true));

  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('.action-bar input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "http://127.0.0.1/layout-video.mp4");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  })()`, true);
  await waitFor(win, 'document.querySelector(".action-bar input")?.value.includes("layout-video")', "添加链接");
  await inspectAction(win, ".action-bar button", "Add", true);
  await waitFor(win, 'document.querySelector(".dialog-wide") && document.body.textContent.includes("Layout video")', "下载确认");
  actions.push(await inspectAction(win, ".dialog-wide button", "Start download"));
  actions.push(await inspectAction(win, ".dialog-wide button", "Cancel", true));

  // Load the real settings entry with the same isolated preload; no installed app.
  win.setSize(540, 480);
  await win.loadFile(path.join(__dirname, "..", "..", "dist", "settings.html"));
  await english(win);
  await waitFor(win, 'document.querySelector(".settings-tabs") && document.body.textContent.includes("Export diagnostics")', "英文设置");
  for (const name of ["General", "Quality", "Processing", "Appearance", "Telegram"]) {
    actions.push(await inspectAction(win, ".settings-tabs button", name));
  }
  actions.push(await inspectAction(win, ".settings-control button", "Choose…"));
  actions.push(await inspectAction(win, ".settings-control button", "Check app updates"));
  actions.push(await inspectAction(win, ".settings-control button", "Export diagnostics"));
  return { locale: "en", outerMain: [760, 560], outerSettings: [540, 480], actions };
}

module.exports = { assertActionable, verifyKeyPaths };
