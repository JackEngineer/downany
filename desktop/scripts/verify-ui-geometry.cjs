const path = require("node:path");

const { app, BrowserWindow } = require("electron");
const {
  runBestEffortCleanup,
} = require("./electron-layout/cleanup.cjs");
const {
  createProductionLayoutHarness,
} = require("./electron-layout/production-harness.cjs");
const {
  verifyProductionPath,
} = require("./electron-layout/production-verify.cjs");
const {
  assert,
  waitFor,
} = require("./electron-layout/verification-utils.cjs");

const VIEWPORT_WIDTH = 760;
const VIEWPORT_HEIGHT = 760;

async function inspectGeometry(win) {
  return win.webContents.executeJavaScript(
    `(() => {
      const banners = [...document.querySelectorAll(
        ".design-system-gallery__product-queue > .media-task-banner",
      )];
      const trigger = banners[0]?.querySelector(
        '.task-actions-menu button[aria-label="更多操作"]',
      );
      if (!(trigger instanceof HTMLButtonElement)) {
        throw new Error("找不到任务更多操作触发器");
      }
      trigger.click();
      return new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const menu = document.body.querySelector(
            ':scope > .task-actions-menu__panel[role="menu"]',
          );
          const menuRect = menu?.getBoundingClientRect();
          resolve({
            viewport: {
              width: window.innerWidth,
              height: window.innerHeight,
              clientWidth: document.documentElement.clientWidth,
              scrollWidth: document.documentElement.scrollWidth,
            },
            bannerRects: banners.map((banner) => {
              const rect = banner.getBoundingClientRect();
              return { left: rect.left, right: rect.right, width: rect.width };
            }),
            menu: menuRect
              ? {
                  parentIsBody: menu.parentElement === document.body,
                  position: getComputedStyle(menu).position,
                  visibility: getComputedStyle(menu).visibility,
                  left: menuRect.left,
                  top: menuRect.top,
                  right: menuRect.right,
                  bottom: menuRect.bottom,
                  width: menuRect.width,
                  height: menuRect.height,
                }
              : null,
          });
        }));
      });
    })()`,
    true,
  );
}

async function inspectReducedTransparencyFocus(win) {
  await win.webContents.executeJavaScript(
    `(() => {
      const controls = [...document.querySelectorAll(
        ".design-system-gallery__controls button",
      )];
      const lightButton = controls.find(
        (button) => button.textContent?.trim() === "浅色",
      );
      const reduceButton = controls.find(
        (button) => button.textContent?.trim() === "减少透明",
      );
      if (!(lightButton instanceof HTMLButtonElement) ||
          !(reduceButton instanceof HTMLButtonElement)) {
        throw new Error("找不到视觉检查控制");
      }
      if (lightButton.getAttribute("aria-pressed") !== "true") {
        lightButton.click();
      }
      if (reduceButton.getAttribute("aria-pressed") !== "true") {
        reduceButton.click();
      }
      const openTrigger = document.querySelector(
        '.task-actions-menu button[aria-expanded="true"]',
      );
      if (openTrigger instanceof HTMLButtonElement) openTrigger.click();
    })()`,
    true,
  );

  await waitFor(
    win,
    'document.documentElement.dataset.theme === "light" && document.documentElement.dataset.reduceTransparency === "true" && !document.querySelector(".task-actions-menu__panel")',
    "浅色减少透明状态",
  );

  await win.webContents.executeJavaScript(
    `(() => {
      document.documentElement.dataset.theme = "light";
      document.documentElement.dataset.reduceTransparency = "true";
      const banners = document.querySelectorAll(
        ".design-system-gallery__product-queue > .media-task-banner",
      );
      const action = [...(banners[2]?.querySelectorAll("button") ?? [])].find(
        (button) => button.textContent?.trim() === "打开",
      );
      if (!(action instanceof HTMLButtonElement)) {
        throw new Error("找不到亮图任务的打开按钮");
      }
      action.focus();
    })()`,
    true,
  );

  win.webContents.debugger.attach("1.3");
  await win.webContents.debugger.sendCommand("DOM.enable");
  await win.webContents.debugger.sendCommand("CSS.enable");
  const documentNode = await win.webContents.debugger.sendCommand(
    "DOM.getDocument",
  );
  const targetNode = await win.webContents.debugger.sendCommand(
    "DOM.querySelector",
    {
      nodeId: documentNode.root.nodeId,
      selector:
        ".design-system-gallery__product-queue > .media-task-banner:nth-child(3) .media-task-banner__primary-action",
    },
  );
  assert(targetNode.nodeId > 0, "无法定位媒体动作按钮的 DOM 节点");
  await win.webContents.debugger.sendCommand("CSS.forcePseudoState", {
    nodeId: targetNode.nodeId,
    forcedPseudoClasses: ["focus", "focus-visible"],
  });

  return win.webContents.executeJavaScript(
    `new Promise((resolve) => {
      const banners = document.querySelectorAll(
        ".design-system-gallery__product-queue > .media-task-banner",
      );
      const action = [...(banners[2]?.querySelectorAll("button") ?? [])].find(
        (button) => button.textContent?.trim() === "打开",
      );
      if (!(action instanceof HTMLButtonElement)) {
        throw new Error("找不到亮图任务的打开按钮");
      }
      setTimeout(() => {
        const style = getComputedStyle(action);
        resolve({
          theme: document.documentElement.dataset.theme,
          reduceTransparency:
            document.documentElement.dataset.reduceTransparency,
          activeElement: document.activeElement?.textContent?.trim() ?? null,
          focusVisibleForced: true,
          backgroundColor: style.backgroundColor,
          color: style.color,
          borderColor: style.borderColor,
          backdropFilter: style.backdropFilter,
          outlineStyle: style.outlineStyle,
          outlineWidth: style.outlineWidth,
          outlineOffset: style.outlineOffset,
          boxShadow: style.boxShadow,
        });
      }, 250);
    })`,
    true,
  );
}

async function run() {
  const productionHarness = createProductionLayoutHarness();
  let win = null;
  try {
    await app.whenReady();
    win = new BrowserWindow({
      width: VIEWPORT_WIDTH,
      height: VIEWPORT_HEIGHT,
      frame: false,
      show: false,
      backgroundColor: "#0b0d10",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    await win.loadFile(path.join(__dirname, "..", "dist", "design-system.html"));
    await waitFor(
      win,
      'document.querySelectorAll(".design-system-gallery__product-queue > .media-task-banner").length === 3',
      "产品横幅",
    );

    const geometry = await inspectGeometry(win);
    assert(geometry.viewport.width === VIEWPORT_WIDTH, "测试视口宽度不是 760px", geometry);
    assert(
      geometry.viewport.scrollWidth <= geometry.viewport.clientWidth,
      "760px settled 布局产生横向溢出",
      geometry,
    );
    assert(
      geometry.bannerRects.every(
        (rect) => rect.left >= 0 && rect.right <= geometry.viewport.width,
      ),
      "任务横幅超出 760px 视口",
      geometry,
    );
    assert(geometry.menu?.parentIsBody, "任务菜单没有通过 Portal 挂到 body", geometry);
    assert(geometry.menu?.position === "fixed", "任务菜单不是 fixed overlay", geometry);
    assert(geometry.menu?.visibility === "visible", "任务菜单不可见", geometry);
    assert(
      geometry.menu &&
        geometry.menu.left >= 0 &&
        geometry.menu.top >= 0 &&
        geometry.menu.right <= geometry.viewport.width &&
        geometry.menu.bottom <= geometry.viewport.height,
      "任务菜单被视口或横幅裁切",
      geometry,
    );

    const focus = await inspectReducedTransparencyFocus(win);
    assert(
      focus.backgroundColor === "rgb(24, 28, 34)",
      "浅色主题减少透明时媒体动作未使用深色实底",
      focus,
    );
    assert(focus.focusVisibleForced, "媒体动作未强制进入 focus-visible 验收状态", focus);
    assert(
      focus.outlineStyle === "solid" && focus.outlineWidth === "2px",
      "媒体动作缺少可见外焦点环",
      focus,
    );
    assert(focus.boxShadow.includes("inset"), "媒体动作缺少内高光", focus);
    assert(focus.backdropFilter === "none", "减少透明时仍启用了 backdrop-filter", focus);

    const production = await verifyProductionPath(productionHarness);

    process.stdout.write(
      `${JSON.stringify({ ok: true, gallery: { geometry, focus }, production }, null, 2)}\n`,
    );
  } finally {
    await runBestEffortCleanup([
      {
        label: "分离 Gallery 调试器",
        run: () => {
          if (win?.webContents.debugger.isAttached()) {
            win.webContents.debugger.detach();
          }
        },
      },
      {
        label: "销毁 Gallery 窗口",
        run: () => {
          if (win && !win.isDestroyed()) win.destroy();
        },
      },
      {
        label: "释放生产路径验收资源",
        run: () => productionHarness.dispose(),
      },
    ]);
  }
}

run()
  .then(() => app.quit())
  .catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    app.exit(1);
  });
