const fs = require("node:fs");
const path = require("node:path");

const { assert, waitFor } = require("./verification-utils.cjs");
const { verifyKeyPaths } = require("./key-path-verify.cjs");

const VIEWPORT_WIDTH = 760;
const PRODUCTION_SMALL_HEIGHT = 560;
const PRODUCTION_CONSTRAINED_HEIGHT = 400;
const PRODUCTION_LARGE_WIDTH = 1120;
const PRODUCTION_LARGE_HEIGHT = 760;

function assertOpaqueRgb(color, expected, message, details) {
  const match = color.match(
    /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/,
  );
  const channels = match ? match.slice(1, 4).map(Number) : [];
  const alpha = match?.[4] === undefined ? 1 : Number(match[4]);
  assert(
    channels.length === 3 &&
      channels.every((channel, index) => channel === expected[index]) &&
      alpha === 1,
    message,
    details,
  );
}

async function inspectProductionGeometry(win) {
  return win.webContents.executeJavaScript(
    `(() => {
      const shell = document.querySelector(".window-shell");
      const main = document.querySelector(".window-main");
      const list = main?.querySelector(":scope > .download-list");
      const banners = [...(list?.querySelectorAll(":scope > .media-task-banner") ?? [])];
      const rectOf = (element) => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
        };
      };
      return {
        entryPath: location.pathname,
        fixturePreload: window.api?.__layoutFixture === true,
        platform: window.api?.platform ?? null,
        shellPresent: shell instanceof HTMLElement,
        taskListPresent: list instanceof HTMLElement,
        galleryPresent: Boolean(document.querySelector(".design-system-gallery")),
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          clientWidth: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
        },
        main: main instanceof HTMLElement ? rectOf(main) : null,
        list: list instanceof HTMLElement ? rectOf(list) : null,
        bannerRects: banners.map(rectOf),
        bannerIds: banners.map((banner) => banner.id),
      };
    })()`,
    true,
  );
}

function assertProductionGeometry(geometry, width, height) {
  assert(geometry.entryPath.endsWith("/index.html"), "生产验收没有加载 index.html", geometry);
  assert(geometry.fixturePreload, "生产验收没有接入隔离 preload fixture", geometry);
  assert(geometry.shellPresent, "生产入口没有渲染真实 Shell", geometry);
  assert(geometry.taskListPresent, "生产入口没有渲染真实 TaskList", geometry);
  assert(!geometry.galleryPresent, "生产验收错误加载了 Gallery", geometry);
  assert(geometry.viewport.width === width, `生产视口宽度不是 ${width}px`, geometry);
  assert(geometry.viewport.height === height, `生产视口高度不是 ${height}px`, geometry);
  assert(geometry.viewport.scrollWidth <= geometry.viewport.clientWidth, "生产布局产生横向溢出", geometry);
  assert(geometry.bannerRects.length === 6, "生产 TaskList 未渲染全部 fixture 任务", geometry);
  assert(
    geometry.bannerRects.every(
      (rect) => rect.left >= 0 && rect.right <= geometry.viewport.width,
    ),
    "生产任务横幅超出视口",
    geometry,
  );
}

async function openProductionMenu(win, bannerSelector) {
  return win.webContents.executeJavaScript(
    `(() => {
      const trigger = document.querySelector(
        ${JSON.stringify(`${bannerSelector} .task-actions-menu button[aria-label="更多操作"]`)},
      );
      if (!(trigger instanceof HTMLButtonElement)) {
        throw new Error(${JSON.stringify(`找不到 ${bannerSelector} 的更多操作按钮`)});
      }
      const waitTwoFrames = (callback) => {
        requestAnimationFrame(() => requestAnimationFrame(callback));
      };
      const inspect = (resolve) => {
        const menu = document.body.querySelector(
          ':scope > .task-actions-menu__panel[role="menu"]',
        );
        const menuRect = menu?.getBoundingClientRect();
        const triggerRect = trigger.getBoundingClientRect();
        resolve({
          trigger: {
            left: triggerRect.left,
            top: triggerRect.top,
            right: triggerRect.right,
            bottom: triggerRect.bottom,
          },
          menu: menuRect
            ? {
                parentIsBody: menu.parentElement === document.body,
                taskId: menu.dataset.taskId,
                placement: menu.dataset.placement,
                position: getComputedStyle(menu).position,
                visibility: getComputedStyle(menu).visibility,
                left: menuRect.left,
                top: menuRect.top,
                right: menuRect.right,
                bottom: menuRect.bottom,
                height: menuRect.height,
                clientHeight: menu.clientHeight,
                scrollHeight: menu.scrollHeight,
                maxHeight: getComputedStyle(menu).maxHeight,
              }
            : null,
        });
      };
      return new Promise((resolve) => {
        const expanded = document.querySelector(
          '.task-actions-menu button[aria-expanded="true"]',
        );
        if (expanded === trigger) {
          waitTwoFrames(() => inspect(resolve));
          return;
        }
        const openTarget = () => {
          trigger.click();
          waitTwoFrames(() => inspect(resolve));
        };
        if (expanded instanceof HTMLButtonElement) {
          expanded.click();
          waitTwoFrames(openTarget);
          return;
        }
        openTarget();
      });
    })()`,
    true,
  );
}

function assertProductionMenu(
  menu,
  expectedPlacement,
  viewportWidth = VIEWPORT_WIDTH,
  viewportHeight = PRODUCTION_SMALL_HEIGHT,
) {
  assert(menu.menu?.parentIsBody, "生产任务菜单没有 Portal 到 body", menu);
  assert(menu.menu?.position === "fixed", "生产任务菜单不是 fixed overlay", menu);
  assert(menu.menu?.visibility === "visible", "生产任务菜单不可见", menu);
  assert(menu.menu?.placement === expectedPlacement, `生产任务菜单没有向${expectedPlacement === "top" ? "上" : "下"}定位`, menu);
  assert(
    menu.menu &&
      menu.menu.left >= 0 &&
      menu.menu.top >= 0 &&
      menu.menu.right <= viewportWidth &&
      menu.menu.bottom <= viewportHeight,
    "生产任务菜单超出小视口",
    menu,
  );
  if (expectedPlacement === "top") {
    assert(menu.menu.bottom <= menu.trigger.top, "向上菜单与触发器重叠", menu);
  } else {
    assert(menu.menu.top >= menu.trigger.bottom, "向下菜单与触发器重叠", menu);
  }
}

async function inspectProductionPseudoState(win, forcedPseudoClasses) {
  const targetSelector =
    "#task-layout-bright .media-task-banner__primary-action";
  if (!win.webContents.debugger.isAttached()) {
    win.webContents.debugger.attach("1.3");
    await win.webContents.debugger.sendCommand("DOM.enable");
    await win.webContents.debugger.sendCommand("CSS.enable");
  }
  const documentNode = await win.webContents.debugger.sendCommand(
    "DOM.getDocument",
  );
  const targetNode = await win.webContents.debugger.sendCommand(
    "DOM.querySelector",
    { nodeId: documentNode.root.nodeId, selector: targetSelector },
  );
  assert(targetNode.nodeId > 0, "无法定位生产亮图媒体动作按钮");
  await win.webContents.debugger.sendCommand("CSS.forcePseudoState", {
    nodeId: targetNode.nodeId,
    forcedPseudoClasses,
  });
  return win.webContents.executeJavaScript(
    `new Promise((resolve) => {
      requestAnimationFrame(() => setTimeout(() => {
        const action = document.querySelector(${JSON.stringify(targetSelector)});
        if (!(action instanceof HTMLButtonElement)) {
          throw new Error("找不到生产亮图媒体动作按钮");
        }
        const style = getComputedStyle(action);
        resolve({
          pseudo: ${JSON.stringify(forcedPseudoClasses)},
          backgroundColor: style.backgroundColor,
          backdropFilter: style.backdropFilter,
          outlineStyle: style.outlineStyle,
          outlineWidth: style.outlineWidth,
          outlineColor: style.outlineColor,
          boxShadow: style.boxShadow,
        });
      }, 100));
    })`,
    true,
  );
}

async function inspectProductionMediaStates(win) {
  await win.webContents.executeJavaScript(
    `(() => {
      document.documentElement.dataset.theme = "light";
      document.documentElement.dataset.reduceTransparency = "true";
      const action = document.querySelector(
        "#task-layout-bright .media-task-banner__primary-action",
      );
      if (!(action instanceof HTMLButtonElement)) {
        throw new Error("找不到生产亮图媒体动作按钮");
      }
      action.focus();
    })()`,
    true,
  );
  const normal = await inspectProductionPseudoState(win, []);
  const hover = await inspectProductionPseudoState(win, ["hover"]);
  const active = await inspectProductionPseudoState(win, ["hover", "active"]);
  const focus = await inspectProductionPseudoState(win, ["focus", "focus-visible"]);
  return { normal, hover, active, focus };
}

function assertProductionMediaStates(states) {
  const expectedBackgrounds = {
    normal: [24, 28, 34],
    hover: [32, 38, 48],
    active: [17, 21, 26],
  };
  for (const state of ["normal", "hover", "active"]) {
    assertOpaqueRgb(
      states[state].backgroundColor,
      expectedBackgrounds[state],
      `减少透明的 ${state} 状态不是不透明实底`,
      states,
    );
    assert(states[state].backdropFilter === "none", `减少透明的 ${state} 状态仍启用模糊`, states);
  }
  assert(states.focus.outlineStyle === "solid", "生产媒体动作缺少实线外焦点环", states);
  assert(states.focus.outlineWidth === "2px", "生产媒体动作外焦点环宽度错误", states);
  assert(states.focus.outlineColor === "rgb(91, 124, 250)", "生产媒体动作外焦点环颜色错误", states);
  assert(states.focus.boxShadow.includes("rgb(11, 13, 16)"), "生产媒体动作缺少深色内焦点环", states);
  assert(states.focus.boxShadow.includes("inset"), "生产媒体动作 focus 冲掉了内高光", states);
  assert(states.focus.backdropFilter === "none", "减少透明的 focus 状态仍启用模糊", states);
}

async function openNetworkSearchWorkspace(win) {
  const openResult = await win.webContents.executeJavaScript(
    `new Promise((resolve) => {
      const trigger = [...document.querySelectorAll(
        ".action-bar button",
      )].find(
        (button) => button.querySelector('[data-icon="search"]'),
      );
      if (!(trigger instanceof HTMLButtonElement)) {
        resolve({ triggerFound: false, modeLabels: [] });
        return;
      }
      trigger.click();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const modes = [...document.querySelectorAll(
          '.search-popover__modes button',
        )];
        const networkMode = modes[1];
        if (!(networkMode instanceof HTMLButtonElement)) {
          resolve({
            triggerFound: true,
            modeLabels: modes.map((button) => button.textContent?.trim() || ""),
          });
          return;
        }
        networkMode.click();
        requestAnimationFrame(() => requestAnimationFrame(() => resolve({
          triggerFound: true,
          modeLabels: modes.map((button) => button.textContent?.trim() || ""),
          networkModeFound: true,
        })));
      }));
    })`,
    true,
  );
  assert(openResult.triggerFound, "找不到搜索入口", openResult);
  assert(openResult.networkModeFound, "找不到网络搜索模式", openResult);
  await waitFor(
    win,
    'document.querySelector(".window-main--search > .net-search-workspace") && !document.querySelector(".filter-bar") && !document.querySelector(".download-list")',
    "独立网络搜索工作区",
  );
}

async function submitFixtureNetworkSearch(win) {
  const submitResult = await win.webContents.executeJavaScript(
    `(() => {
      const input = document.querySelector(
        '.net-search-form input[aria-label="搜索网络视频"]',
      );
      const form = input?.closest("form");
      const submit = form?.querySelector('button[type="submit"]');
      if (!(input instanceof HTMLInputElement) ||
          !(form instanceof HTMLFormElement) ||
          !(submit instanceof HTMLButtonElement)) {
        return {
          inputFound: input instanceof HTMLInputElement,
          formFound: form instanceof HTMLFormElement,
          submitFound: submit instanceof HTMLButtonElement,
        };
      }
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setValue?.call(input, "AI workflow");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      form.requestSubmit(submit);
      return { inputFound: true, formFound: true, submitFound: true };
    })()`,
    true,
  );
  assert(
    submitResult.inputFound && submitResult.formFound && submitResult.submitFound,
    "网络搜索表单不完整",
    submitResult,
  );
  await waitFor(
    win,
    'document.querySelectorAll(".net-result-row").length === 12 && document.querySelector(".net-results-summary")?.textContent?.includes("12 个结果")',
    "网络搜索快速结果",
  );
}

async function inspectNetworkSearchGeometry(win) {
  return win.webContents.executeJavaScript(
    `(() => {
      const main = document.querySelector(".window-main--search");
      const workspace = document.querySelector(".net-search-workspace");
      const header = document.querySelector(".net-search-workspace__header");
      const body = document.querySelector(".net-search-workspace__body");
      const list = document.querySelector(".net-results-list");
      const rows = [...document.querySelectorAll(".net-result-row")];
      const controls = [...document.querySelectorAll(
        ".net-search-workspace__header button, .net-search-workspace__header input, .net-search-workspace__header select",
      )];
      if (!(main instanceof HTMLElement) ||
          !(workspace instanceof HTMLElement) ||
          !(header instanceof HTMLElement) ||
          !(body instanceof HTMLElement)) {
        throw new Error("网络搜索工作区结构不完整");
      }
      const rectOf = (element) => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
        };
      };
      return {
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          clientWidth: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
          scrollHeight: document.documentElement.scrollHeight,
        },
        main: {
          ...rectOf(main),
          clientHeight: main.clientHeight,
          scrollHeight: main.scrollHeight,
          overflowY: getComputedStyle(main).overflowY,
        },
        header: rectOf(header),
        controlRects: controls.map(rectOf),
        rowRects: rows.map(rectOf),
        nestedOverflowY: {
          workspace: getComputedStyle(workspace).overflowY,
          body: getComputedStyle(body).overflowY,
          list: list instanceof HTMLElement
            ? getComputedStyle(list).overflowY
            : "visible",
        },
      };
    })()`,
    true,
  );
}

function assertNetworkSearchGeometry(geometry, expectedColumns) {
  assert(
    geometry.viewport.scrollWidth <= geometry.viewport.clientWidth,
    "网络搜索产生页面级横向溢出",
    geometry,
  );
  assert(geometry.rowRects.length === 12, "网络搜索没有呈现全部结果", geometry);
  assert(
    geometry.controlRects.every(
      (rect) =>
        rect.left >= 0 &&
        rect.right <= geometry.viewport.width &&
        rect.top >= geometry.main.top &&
        rect.bottom <= geometry.viewport.height,
    ),
    "网络搜索主控件超出首屏",
    geometry,
  );
  assert(geometry.main.overflowY === "auto", "主工作区不是唯一滚动容器", geometry);
  assert(
    Object.values(geometry.nestedOverflowY).every(
      (overflow) => overflow === "visible",
    ),
    "网络结果内部形成了第二滚动区",
    geometry,
  );
  const first = geometry.rowRects[0];
  const second = geometry.rowRects[1];
  if (expectedColumns === 2) {
    assert(
      Math.abs(first.top - second.top) < 1 && second.left > first.left,
      "宽视口没有形成双列结果布局",
      geometry,
    );
  } else {
    assert(
      second.top > first.top && Math.abs(second.left - first.left) < 1,
      "窄视口没有保持单列结果布局",
      geometry,
    );
  }
}

async function inspectStickySearchHeader(win) {
  return win.webContents.executeJavaScript(
    `new Promise((resolve) => {
      const main = document.querySelector(".window-main--search");
      const header = document.querySelector(".net-search-workspace__header");
      if (!(main instanceof HTMLElement) || !(header instanceof HTMLElement)) {
        throw new Error("找不到网络搜索滚动结构");
      }
      main.scrollTop = Math.min(180, main.scrollHeight - main.clientHeight);
      main.dispatchEvent(new Event("scroll", { bubbles: true }));
      requestAnimationFrame(() => requestAnimationFrame(() => {
        resolve({
          mainTop: main.getBoundingClientRect().top,
          headerTop: header.getBoundingClientRect().top,
          scrollTop: main.scrollTop,
        });
      }));
    })`,
    true,
  );
}

async function returnToDownloadList(win) {
  await win.webContents.executeJavaScript(
    `(() => {
      const back = [...document.querySelectorAll(
        ".net-search-workspace__header button",
      )].find((button) => button.textContent?.trim() === "返回下载列表");
      if (!(back instanceof HTMLButtonElement)) {
        throw new Error("找不到返回下载列表按钮");
      }
      back.click();
    })()`,
    true,
  );
  await waitFor(
    win,
    'document.querySelector(".filter-bar") && document.querySelector(".download-list") && !document.querySelector(".net-search-workspace")',
    "返回下载列表",
  );
}

async function verifyNetworkSearchWorkspace(win, screenshotPath) {
  await openNetworkSearchWorkspace(win);
  const initial = await inspectNetworkSearchGeometry(win);
  assert(initial.rowRects.length === 0, "初始搜索工作区出现了旧结果", initial);

  await submitFixtureNetworkSearch(win);
  const large = await inspectNetworkSearchGeometry(win);
  assertNetworkSearchGeometry(large, 2);

  let savedScreenshot = "";
  if (screenshotPath) {
    await win.webContents.executeJavaScript(
      "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      true,
    );
    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    fs.writeFileSync(screenshotPath, (await win.capturePage()).toPNG());
    savedScreenshot = screenshotPath;
  }

  const sticky = await inspectStickySearchHeader(win);
  assert(sticky.scrollTop > 0, "结果数量不足以验证主滚动", sticky);
  assert(
    Math.abs(sticky.headerTop - sticky.mainTop) < 1,
    "滚动后搜索栏没有固定在主工作区顶部",
    sticky,
  );

  await returnToDownloadList(win);
  return { initial, large, sticky, screenshotPath: savedScreenshot };
}

async function verifyProductionPath(harness, options = {}) {
  const win = await harness.open(VIEWPORT_WIDTH, PRODUCTION_SMALL_HEIGHT);
  await waitFor(
    win,
    'window.api?.__layoutFixture === true && document.querySelector(".window-shell") && document.querySelectorAll(".window-main > .download-list > .media-task-banner").length === 6',
    "生产 Shell 与任务横幅",
  );

  const small = await inspectProductionGeometry(win);
  assertProductionGeometry(small, VIEWPORT_WIDTH, PRODUCTION_SMALL_HEIGHT);

  const brightMenu = await openProductionMenu(win, "#task-layout-bright");
  assertProductionMenu(brightMenu, "top");

  await harness.resize(VIEWPORT_WIDTH, PRODUCTION_CONSTRAINED_HEIGHT);
  const pendingMenu = await openProductionMenu(win, "#task-layout-pending");
  assertProductionMenu(
    pendingMenu,
    "bottom",
    VIEWPORT_WIDTH,
    PRODUCTION_CONSTRAINED_HEIGHT,
  );
  assert(
    pendingMenu.menu.scrollHeight > pendingMenu.menu.clientHeight,
    "受限视口没有形成可验证的菜单滚动区",
    pendingMenu,
  );

  await harness.resize(PRODUCTION_LARGE_WIDTH, PRODUCTION_LARGE_HEIGHT);
  const large = await inspectProductionGeometry(win);
  assertProductionGeometry(large, PRODUCTION_LARGE_WIDTH, PRODUCTION_LARGE_HEIGHT);
  const expandedMenu = await openProductionMenu(win, "#task-layout-pending");
  assert(expandedMenu.menu?.visibility === "visible", "扩容后菜单不可见", expandedMenu);
  assert(
    expandedMenu.menu && expandedMenu.menu.height > pendingMenu.menu.height,
    "扩容后菜单仍被旧 maxHeight 压缩",
    { pendingMenu, expandedMenu },
  );
  assert(
    expandedMenu.menu && expandedMenu.menu.top >= expandedMenu.trigger.bottom,
    "扩容后菜单读取压缩高度导致重叠",
    expandedMenu,
  );

  await harness.resize(VIEWPORT_WIDTH, PRODUCTION_SMALL_HEIGHT);
  await openProductionMenu(win, "#task-layout-pending");
  const offscreen = await win.webContents.executeJavaScript(
    `new Promise((resolve) => {
      const main = document.querySelector(".window-main");
      if (!(main instanceof HTMLElement)) throw new Error("找不到生产滚动容器");
      main.scrollTop = main.scrollHeight;
      main.dispatchEvent(new Event("scroll", { bubbles: true }));
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const trigger = document.querySelector(
          '#task-layout-pending .task-actions-menu button[aria-label="更多操作"]',
        );
        const rect = trigger?.getBoundingClientRect();
        resolve({
          menuOpen: Boolean(document.querySelector(".task-actions-menu__panel")),
          triggerTop: rect?.top ?? null,
          triggerBottom: rect?.bottom ?? null,
          scrollTop: main.scrollTop,
        });
      }));
    })`,
    true,
  );
  assert(offscreen.triggerBottom <= 0, "滚动后触发器没有完全离开视口", offscreen);
  assert(!offscreen.menuOpen, "触发器完全离开视口后菜单仍保持打开", offscreen);

  await win.webContents.executeJavaScript(
    `new Promise((resolve) => {
      const main = document.querySelector(".window-main");
      if (!(main instanceof HTMLElement)) throw new Error("找不到生产滚动容器");
      main.scrollTop = 0;
      main.dispatchEvent(new Event("scroll", { bubbles: true }));
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    })`,
    true,
  );
  const states = await inspectProductionMediaStates(win);
  assertProductionMediaStates(states);

  await harness.resize(PRODUCTION_LARGE_WIDTH, PRODUCTION_LARGE_HEIGHT);
  const networkSearch = await verifyNetworkSearchWorkspace(
    win,
    options.networkSearchScreenshotPath,
  );

  await harness.resize(VIEWPORT_WIDTH, PRODUCTION_SMALL_HEIGHT);
  await openNetworkSearchWorkspace(win);
  await submitFixtureNetworkSearch(win);
  const narrowNetworkSearch = await inspectNetworkSearchGeometry(win);
  assertNetworkSearchGeometry(narrowNetworkSearch, 1);
  await returnToDownloadList(win);

  const keyPaths = await verifyKeyPaths(win, harness);
  return {
    small,
    large,
    pendingMenu,
    brightMenu,
    expandedMenu,
    offscreen,
    states,
    networkSearch,
    narrowNetworkSearch,
    keyPaths,
  };
}

module.exports = { verifyProductionPath };
