# Downany Design System Desktop Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立唯一语义 Token 源、可复用桌面基础控件、分离窗口与业务操作层，并将现有下载卡片迁移为保留全部行为的强高斯玻璃 `MediaTaskBanner`。

**Architecture:** 在仓库根建立平台无关的 CSS Token 事实源，由 Electron 样式入口消费；Renderer 新增 `ui`、`shell`、`task` 三个边界明确的组件目录。任务展示逻辑先提炼为纯函数，再让横幅组件组合现有 API 行为，避免视觉重构改写 Sidecar 协议或下载状态机。

**Tech Stack:** Electron 33、React 18、TypeScript 5.7、Vite 5、Zustand 5、Vitest 2、Testing Library、CSS Custom Properties、`backdrop-filter`。

## Global Constraints

- 上位规范：`docs/DESIGN-SYSTEM.md`；桌面细则：`docs/UI-DESIGN-LANGUAGE.md`。
- 产品名称完整形态为 `Downany · 百纳`；Windows 原生标题栏也使用该名称。
- macOS 使用 `hiddenInset + under-window vibrancy`；Windows 保留系统窗口框架和按钮，不模拟交通灯。
- 标题栏、操作栏、筛选栏逻辑高度依次为 `44px / 48px / 36px`。
- 常规控件高度 `32px`，小型图标按钮 `28px`，横向页面边距 `16px`。
- 任务横幅高度 `108px`，紧凑态 `96px`，横幅间距 `8px`，圆角 `10px`。
- 推荐窗口 `1120 × 760px`，最小窗口 `760 × 560px`。
- `Reading Glass` 模糊 `32–40px`、饱和度 `115%–125%`、染色透明度 `0.32–0.48`、宽度 `56%–60%`、右缘羽化 `80–110px`。
- 媒体原图只压暗 `8%–10%`；每张可见横幅最多一个大面积模糊层；不动画 `backdrop-filter`。
- 任务状态只允许 `pending / downloading / paused / completed / failed / cancelled`；运行时未知值显示为“状态未知”，不得崩溃。
- 状态必须同时使用文字或图标；完成态不得显示绿色长线或整卡绿色填充。
- 激活筛选只使用文字提亮和 `2px` 短指示线，不使用胶囊底。
- 所有生产图标使用 `16px` 线性 SVG、约 `1.5px` 描边；不得使用 Emoji 或字体符号冒充图标。
- 不新增运行时依赖；不修改 Sidecar、数据库、Telegram、扩展或 CLI 行为。
- 保留现有粘贴、拖放、搜索、批量操作、右键菜单、重命名、暂停、继续、取消、重试、打开、在文件夹中显示和失败恢复能力。
- 深色、浅色、系统主题、减少动效、减少透明和无 `backdrop-filter` 模式必须可用。
- 每个任务结束时只暂存该任务列出的文件并形成独立提交；不推送远端。

---

## Scope Decomposition

完整设计系统覆盖多个可独立验收的子系统，本计划只处理第一阶段桌面核心：

1. 唯一语义 Token 源与桌面基础样式。
2. 基础按钮、输入框、筛选项和线性图标。
3. 主窗口四层结构。
4. `MediaTaskBanner` 及队列/合集集成。
5. 主窗口空状态与确定性视觉检查页。

以下内容不得混入本计划：

- 设置、历史、Toast、对话框和 Telegram 设置的完整视觉迁移。
- 浏览器抓取窗口、Chrome 扩展弹窗和页内下载按钮。
- 系统菜单、托盘、通知、安装、更新与 CLI 输出。
- 尚未存在于当前仓库的官网实现。

上述四组分别需要独立实施计划，并以本计划产出的 Token 和基础组件为输入。

## Baseline Evidence

2026-08-16 在当前工作区执行：

- `cd desktop && npm test`：27 个测试文件通过、7 个失败；失败来自未安装的 `proxy-from-env` 与既存 Telegram Windows 路径断言。
- `cd desktop && npm run build`：TypeScript 因找不到 `proxy-from-env` 失败。
- `cd desktop && npm ls proxy-from-env --depth=0`：显示 `(empty)`，但 `desktop/package.json` 和锁文件已声明该依赖。

执行本计划时先运行 `npm install` 恢复锁文件声明的依赖。若全量测试仍只剩 Telegram 路径相关失败，记录为既存基线，不得在本 UI 分支修改 Telegram 文件。新增 Renderer 测试、现有 Renderer 测试和 `npm run build` 必须通过。

## File Structure

### Create

- `design-system/tokens.css`：全产品唯一语义 Token 源，暂含旧变量兼容别名。
- `desktop/renderer/styles/tokenContract.test.ts`：Token 名称、主题和旧别名合同测试。
- `desktop/renderer/styles/foundations.css`：字体、焦点、控件基线和降级规则。
- `desktop/renderer/styles/ui.css`：基础控件样式。
- `desktop/renderer/styles/shell.css`：窗口镀铬、操作栏、筛选栏和搜索浮层。
- `desktop/renderer/styles/media-task-banner.css`：任务横幅、阅读玻璃和响应式规则。
- `desktop/renderer/components/ui/Icon.tsx`：穷举式线性 SVG 图标。
- `desktop/renderer/components/ui/Button.tsx`：语义按钮和图标按钮。
- `desktop/renderer/components/ui/TextField.tsx`：带前导图标的紧凑输入框。
- `desktop/renderer/components/ui/FilterTab.tsx`：带数量和单一激活指示的筛选项。
- `desktop/renderer/components/ui/uiPrimitives.test.tsx`：基础控件状态与可访问性测试。
- `desktop/renderer/components/shell/WindowChrome.tsx`：仅 macOS Renderer 使用的产品标题层。
- `desktop/renderer/components/shell/WindowChrome.test.tsx`：平台分支测试。
- `desktop/renderer/components/shell/ActionBar.tsx`：添加、网页识别、搜索、批量操作和设置。
- `desktop/renderer/components/shell/FilterBar.tsx`：任务筛选与数量。
- `desktop/renderer/components/shell/SearchPopover.tsx`：可关闭、可聚焦的搜索浮层。
- `desktop/renderer/components/shell/ActionBar.test.tsx`：操作、搜索和快捷行为测试。
- `desktop/renderer/components/shell/FilterBar.test.tsx`：数量与选择语义测试。
- `desktop/renderer/components/task/taskPresentation.ts`：任务状态、元信息和直接动作纯函数。
- `desktop/renderer/components/task/taskPresentation.test.ts`：六态和未知态测试。
- `desktop/renderer/components/task/useTaskCommands.ts`：现有任务 API 行为封装。
- `desktop/renderer/components/task/TaskActionsMenu.tsx`：行内更多菜单与原生右键模板。
- `desktop/renderer/components/task/MediaTaskBanner.tsx`：媒体横幅视觉组件。
- `desktop/renderer/components/task/MediaTaskBanner.test.tsx`：横幅层级、状态和操作测试。
- `desktop/renderer/components/TaskList.test.tsx`：独立任务与合集密度集成测试。
- `desktop/renderer/components/EmptyState.test.tsx`：单一主操作测试。
- `desktop/renderer/test/taskFixture.ts`：Renderer 测试共用任务快照。
- `desktop/renderer/design-system.html`：仅开发态使用的视觉检查入口。
- `desktop/renderer/design-system-main.tsx`：视觉检查页启动代码和最小 API mock。
- `desktop/renderer/styles/design-system-gallery.css`：只由视觉检查入口加载的画廊布局。
- `desktop/renderer/components/design-system/DesktopCoreGallery.tsx`：六态、双主题和双密度画廊。
- `desktop/renderer/components/design-system/DesktopCoreGallery.test.tsx`：画廊覆盖合同。
- `desktop/electron/windowChrome.test.ts`：窗口选项与尺寸测试。

### Modify

- `desktop/vite.config.ts`：允许消费仓库根 Token，并仅在开发态暴露视觉检查入口。
- `desktop/renderer/styles.css`：改为导入 Token/基础/组件样式，删除已迁移的旧规则。
- `desktop/renderer/components/Shell.tsx`：组合四层结构并更新任务高亮类名。
- `desktop/renderer/components/TaskList.tsx`：使用 `MediaTaskBanner` 并简化空状态。
- `desktop/renderer/components/PlaylistGroupCard.tsx`：组内使用紧凑横幅。
- `desktop/renderer/components/EmptyState.tsx`：移除字体符号和多动作引导。
- `desktop/renderer/components/ToastHost.tsx`：仅将关闭字符替换为线性图标，不迁移 Toast 布局。
- `desktop/renderer/components/NetSearchPanel.tsx`：仅将播放字符替换为线性图标，不迁移结果布局。
- `desktop/renderer/i18n.ts`：增加新增按钮、筛选和空状态文案。
- `desktop/electron/windowChrome.ts`：导出平台可测试的窗口选项与几何常量。
- `desktop/electron/windowState.ts`：使用统一推荐尺寸。
- `desktop/electron/main.ts`：使用完整标题和统一最小尺寸。
- `docs/DESIGN-SYSTEM.md`：记录第一阶段工程状态。
- `docs/UI-DESIGN-LANGUAGE.md`：勾选有证据的桌面核心验收项。

### Delete

- `desktop/renderer/components/TopBar.tsx`：被 `WindowChrome + ActionBar + FilterBar` 替代。
- `desktop/renderer/components/DownloadCard.tsx`：被 `MediaTaskBanner` 替代。

---

### Task 1: Establish the Semantic Token Contract

**Files:**
- Create: `design-system/tokens.css`
- Create: `desktop/renderer/styles/tokenContract.test.ts`
- Create: `desktop/renderer/styles/foundations.css`
- Modify: `desktop/renderer/styles.css:1-67`
- Modify: `desktop/vite.config.ts:35-70`

**Interfaces:**
- Consumes: `docs/DESIGN-SYSTEM.md` 第 5、6、10 节的材质、尺寸、主题和降级规则。
- Produces: CSS 语义变量 `--color-*`、`--space-*`、`--radius-*`、`--motion-*`、`--material-*`；旧变量只作为兼容别名存在。

- [ ] **Step 1: Restore declared dependencies and record the post-install baseline**

Run:

```bash
cd desktop
npm install
npm ls proxy-from-env --depth=0
npm test -- renderer/store/appStore.test.ts renderer/components/NetSearchPanel.test.tsx
```

Expected:

- `proxy-from-env` 出现在顶层依赖树。
- 两个 Renderer 测试文件通过。
- `package-lock.json` 若无依赖事实变化则保持不变；若 `npm install` 改写锁文件，停止并先核对差异，不把无关锁文件改动纳入 UI 提交。

- [ ] **Step 2: Write the failing Token contract test**

```ts
// desktop/renderer/styles/tokenContract.test.ts
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const tokenPath = fileURLToPath(
  new URL("../../../design-system/tokens.css", import.meta.url),
);

const requiredTokens = [
  "--gray-1000",
  "--gray-950",
  "--gray-900",
  "--blue-500",
  "--color-surface-window",
  "--color-surface-chrome",
  "--color-surface-raised",
  "--color-surface-control",
  "--color-text-primary",
  "--color-text-secondary",
  "--color-text-on-media",
  "--color-text-on-media-secondary",
  "--color-text-on-media-tertiary",
  "--color-stroke-subtle",
  "--color-accent",
  "--color-success",
  "--color-warning",
  "--color-danger",
  "--color-focus-ring",
  "--material-task-glass-width",
  "--material-task-glass-blur",
  "--material-task-glass-tint",
  "--material-task-glass-tint-dark",
  "--material-task-glass-tint-medium",
  "--material-task-glass-tint-light",
  "--material-task-glass-lift",
  "--material-task-glass-fallback",
  "--material-task-shade",
  "--material-task-progress-track",
  "--material-action-glass-highlight",
  "--material-media-placeholder-start",
  "--material-media-placeholder-middle",
  "--material-media-placeholder-end",
  "--motion-fast",
  "--motion-normal",
  "--radius-control",
  "--radius-banner",
  "--control-height",
] as const;

describe("design token contract", () => {
  it("has one canonical token source", () => {
    expect(existsSync(tokenPath)).toBe(true);
  });

  it("defines required semantic tokens, both themes and temporary aliases", () => {
    const css = readFileSync(tokenPath, "utf8");
    for (const token of requiredTokens) expect(css).toContain(`${token}:`);
    expect(css).toContain('html[data-theme="dark"]');
    expect(css).toContain('html[data-theme="light"]');
    expect(css).toContain("--bg: var(--color-surface-window)");
    expect(css).toContain("--panel: var(--color-surface-control)");
    expect(css).toContain("--text: var(--color-text-primary)");
  });
});
```

- [ ] **Step 3: Run the Token test and verify the missing source fails**

Run:

```bash
cd desktop
npm test -- renderer/styles/tokenContract.test.ts
```

Expected: FAIL because `design-system/tokens.css` does not exist.

- [ ] **Step 4: Create the canonical Token source**

Create `design-system/tokens.css` with these sections and values:

```css
:root {
  --gray-1000: #0b0d10;
  --gray-950: #101318;
  --gray-900: #15191f;
  --gray-850: #1b2027;
  --gray-700: #343a45;
  --gray-500: #89919d;
  --gray-300: #c5cad2;
  --gray-100: #f4f6f8;
  --blue-500: #5b7cfa;
  --green-500: #5fcb72;
  --amber-500: #d8a54b;
  --red-500: #e56d73;
}

:root,
html[data-theme="dark"] {
  color-scheme: dark;
  --color-surface-window: var(--gray-1000);
  --color-surface-chrome: rgba(16, 19, 24, 0.94);
  --color-surface-raised: var(--gray-900);
  --color-surface-control: rgba(255, 255, 255, 0.035);
  --color-surface-control-hover: rgba(255, 255, 255, 0.065);
  --color-surface-control-pressed: rgba(255, 255, 255, 0.09);
  --color-text-primary: rgba(255, 255, 255, 0.92);
  --color-text-secondary: rgba(255, 255, 255, 0.64);
  --color-text-tertiary: rgba(255, 255, 255, 0.42);
  --color-text-on-media: rgba(255, 255, 255, 0.94);
  --color-stroke-subtle: rgba(255, 255, 255, 0.08);
  --color-stroke-strong: rgba(255, 255, 255, 0.14);
  --color-accent: var(--blue-500);
  --color-accent-soft: rgba(91, 124, 250, 0.16);
  --color-success: var(--green-500);
  --color-warning: var(--amber-500);
  --color-danger: var(--red-500);
  --color-focus-ring: rgba(91, 124, 250, 0.46);
}

html[data-theme="light"] {
  color-scheme: light;
  --color-surface-window: #f2f3f5;
  --color-surface-chrome: rgba(248, 249, 251, 0.96);
  --color-surface-raised: #ffffff;
  --color-surface-control: rgba(17, 19, 23, 0.035);
  --color-surface-control-hover: rgba(17, 19, 23, 0.065);
  --color-surface-control-pressed: rgba(17, 19, 23, 0.095);
  --color-text-primary: rgba(17, 19, 23, 0.92);
  --color-text-secondary: rgba(17, 19, 23, 0.62);
  --color-text-tertiary: rgba(17, 19, 23, 0.42);
  --color-text-on-media: rgba(255, 255, 255, 0.94);
  --color-stroke-subtle: rgba(17, 19, 23, 0.09);
  --color-stroke-strong: rgba(17, 19, 23, 0.15);
  --color-accent: #4f6ee8;
  --color-accent-soft: rgba(79, 110, 232, 0.13);
  --color-success: #3e9f54;
  --color-warning: #a56d16;
  --color-danger: #c84f58;
  --color-focus-ring: rgba(79, 110, 232, 0.38);
}

@media (prefers-color-scheme: light) {
  :root:not([data-theme]) {
    color-scheme: light;
    --color-surface-window: #f2f3f5;
    --color-surface-chrome: rgba(248, 249, 251, 0.96);
    --color-surface-raised: #ffffff;
    --color-surface-control: rgba(17, 19, 23, 0.035);
    --color-surface-control-hover: rgba(17, 19, 23, 0.065);
    --color-surface-control-pressed: rgba(17, 19, 23, 0.095);
    --color-text-primary: rgba(17, 19, 23, 0.92);
    --color-text-secondary: rgba(17, 19, 23, 0.62);
    --color-text-tertiary: rgba(17, 19, 23, 0.42);
    --color-stroke-subtle: rgba(17, 19, 23, 0.09);
    --color-stroke-strong: rgba(17, 19, 23, 0.15);
    --color-accent: #4f6ee8;
    --color-accent-soft: rgba(79, 110, 232, 0.13);
    --color-success: #3e9f54;
    --color-warning: #a56d16;
    --color-danger: #c84f58;
    --color-focus-ring: rgba(79, 110, 232, 0.38);
  }
}

:root {
  --font-ui: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC",
    "Hiragino Sans GB", "Segoe UI", "Microsoft YaHei UI", "Noto Sans SC",
    sans-serif;
  --space-0-5: 2px;
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-8: 32px;
  --space-10: 40px;
  --radius-small: 6px;
  --radius-control: 8px;
  --radius-banner: 10px;
  --radius-popover: 12px;
  --radius-dialog: 14px;
  --control-height-small: 28px;
  --control-height: 32px;
  --motion-fast: 120ms;
  --motion-normal: 180ms;
  --motion-slow: 240ms;
  --ease-standard: cubic-bezier(0.2, 0.8, 0.2, 1);
  --material-task-glass-width: 58%;
  --material-task-glass-blur: 36px;
  --material-task-glass-saturate: 1.2;
  --material-task-glass-tint-dark: rgba(15, 17, 20, 0.32);
  --material-task-glass-tint-medium: rgba(15, 17, 20, 0.4);
  --material-task-glass-tint-light: rgba(15, 17, 20, 0.48);
  --material-task-glass-tint: var(--material-task-glass-tint-medium);
  --material-task-glass-lift: rgba(255, 255, 255, 0.07);
  --material-task-glass-fallback: rgba(15, 17, 20, 0.9);
  --material-task-glass-feather: 96px;
  --material-task-shade: rgba(0, 0, 0, 0.09);
  --material-task-progress-track: rgba(255, 255, 255, 0.12);
  --material-action-glass-blur: 24px;
  --material-action-glass-fill: rgba(255, 255, 255, 0.1);
  --material-action-glass-stroke: rgba(255, 255, 255, 0.14);
  --material-action-glass-highlight: inset 0 1px 0 rgba(255, 255, 255, 0.12);
  --elevation-overlay: 0 14px 36px rgba(0, 0, 0, 0.32);
  --color-text-on-media-secondary: rgba(255, 255, 255, 0.66);
  --color-text-on-media-tertiary: rgba(255, 255, 255, 0.42);
  --material-media-placeholder-start: #252b34;
  --material-media-placeholder-middle: #11151a;
  --material-media-placeholder-end: #303844;

  /* 迁移期间兼容现有页面；组件完成迁移后单独删除。 */
  --bg: var(--color-surface-window);
  --panel: var(--color-surface-control);
  --panel-solid: var(--color-surface-raised);
  --text: var(--color-text-primary);
  --muted: var(--color-text-secondary);
  --line: var(--color-stroke-subtle);
  --accent: var(--color-accent);
  --accent-soft: var(--color-accent-soft);
  --danger: var(--color-danger);
  --hover: var(--color-surface-control-hover);
}
```

- [ ] **Step 5: Wire Token and foundation styles into Vite**

Make `desktop/renderer/styles.css` begin with:

```css
@import "../../design-system/tokens.css";
@import "./styles/foundations.css";
```

Remove the old `:root`, theme and global blocks from `styles.css`. Put the global rules in `foundations.css`:

```css
* {
  box-sizing: border-box;
}

html,
body {
  background: transparent;
}

body {
  margin: 0;
  color: var(--color-text-primary);
  font: 400 13px/18px var(--font-ui);
  -webkit-font-smoothing: antialiased;
}

button,
input,
textarea,
select {
  font: inherit;
}

:where(button, input, textarea, select, summary, [tabindex]):focus-visible {
  outline: 2px solid var(--color-focus-ring);
  outline-offset: 2px;
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    scroll-behavior: auto !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

Add the repository root to Vite's file-system allow list:

```ts
server: {
  fs: {
    allow: [path.resolve(__dirname, "..")],
  },
},
```

- [ ] **Step 6: Verify Token contract and build**

Run:

```bash
cd desktop
npm test -- renderer/styles/tokenContract.test.ts
npm run build
```

Expected: PASS; Vite bundles the root Token CSS without file-system errors.

- [ ] **Step 7: Commit the Token milestone**

```bash
git add design-system/tokens.css desktop/renderer/styles/tokenContract.test.ts desktop/renderer/styles/foundations.css desktop/renderer/styles.css desktop/vite.config.ts
git commit -m "feat(ui): add semantic design tokens"
```

---

### Task 2: Build Accessible UI Primitives

**Files:**
- Create: `desktop/renderer/components/ui/Icon.tsx`
- Create: `desktop/renderer/components/ui/Button.tsx`
- Create: `desktop/renderer/components/ui/TextField.tsx`
- Create: `desktop/renderer/components/ui/FilterTab.tsx`
- Create: `desktop/renderer/components/ui/uiPrimitives.test.tsx`
- Create: `desktop/renderer/styles/ui.css`
- Modify: `desktop/renderer/styles.css:1-4`
- Modify: `desktop/renderer/components/ToastHost.tsx:1-48`
- Modify: `desktop/renderer/components/NetSearchPanel.tsx:1-91`

**Interfaces:**
- Consumes: Task 1 的语义 Token。
- Produces: `IconName`、`Button`、`IconButton`、`TextField`、`FilterTab`；后续 Shell 与任务组件只能消费这些接口，不复制按钮/输入框样式。

- [ ] **Step 1: Write failing primitive behavior tests**

```tsx
// desktop/renderer/components/ui/uiPrimitives.test.tsx
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Button, IconButton } from "./Button";
import { FilterTab } from "./FilterTab";
import { TextField } from "./TextField";

afterEach(cleanup);

describe("UI primitives", () => {
  it("keeps a loading button named and disabled", () => {
    render(<Button loading>添加</Button>);
    const button = screen.getByRole("button", { name: "添加" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
  });

  it("gives an icon-only button an accessible name", () => {
    render(<IconButton icon="settings" label="设置" />);
    expect(screen.getByRole("button", { name: "设置" })).toHaveAttribute(
      "title",
      "设置",
    );
  });

  it("exposes a selected filter tab and its count", () => {
    render(
      <FilterTab selected label="进行中" count={2} onSelect={() => undefined} />,
    );
    expect(screen.getByRole("tab", { name: "进行中 2" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("renders a labelled field with a leading icon", () => {
    render(<TextField aria-label="视频链接" leadingIcon="link" />);
    expect(screen.getByRole("textbox", { name: "视频链接" })).toBeInTheDocument();
    expect(document.querySelector('[data-icon="link"]')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run primitive tests and verify imports fail**

Run:

```bash
cd desktop
npm test -- renderer/components/ui/uiPrimitives.test.tsx
```

Expected: FAIL because the four component modules do not exist.

- [ ] **Step 3: Implement the exhaustive icon component**

Use this public API:

```tsx
export type IconName =
  | "link"
  | "plus"
  | "capture"
  | "search"
  | "more"
  | "settings"
  | "open"
  | "pause"
  | "play"
  | "retry"
  | "folder"
  | "close"
  | "download"
  | "check"
  | "chevron-down"
  | "chevron-right";

export interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
}
```

Render a `viewBox="0 0 24 24"`, `fill="none"`, `stroke="currentColor"`, `strokeWidth="1.5"`, `strokeLinecap="round"`, `strokeLinejoin="round"` SVG. Set `className`, `width/height={size}`, `data-icon={name}`, `aria-hidden="true"` and `focusable="false"`; the labelled parent owns accessibility. Use an exhaustive switch with these path definitions:

```tsx
function glyph(name: IconName): JSX.Element {
  switch (name) {
    case "link":
      return <><path d="M10 13a5 5 0 0 0 7.54.54l2-2a5 5 0 0 0-7.07-7.07l-1.15 1.15" /><path d="M14 11a5 5 0 0 0-7.54-.54l-2 2a5 5 0 0 0 7.07 7.07l1.14-1.14" /></>;
    case "plus":
      return <path d="M12 5v14M5 12h14" />;
    case "capture":
      return <><path d="M8 4H5a1 1 0 0 0-1 1v3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" /><path d="M8 12h8" /></>;
    case "search":
      return <><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></>;
    case "more":
      return <><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" /></>;
    case "settings":
      return <><path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h8M16 18h4" /><circle cx="16" cy="6" r="2" /><circle cx="8" cy="12" r="2" /><circle cx="14" cy="18" r="2" /></>;
    case "open":
      return <><path d="M14 5h5v5M19 5l-8 8" /><path d="M18 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></>;
    case "pause":
      return <path d="M9 5v14M15 5v14" />;
    case "play":
      return <path d="m9 5 10 7-10 7Z" />;
    case "retry":
      return <><path d="M20 7v5h-5" /><path d="M19 12a7 7 0 1 0-2 5" /></>;
    case "folder":
      return <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />;
    case "close":
      return <path d="m6 6 12 12M18 6 6 18" />;
    case "download":
      return <><path d="M12 4v11M8 11l4 4 4-4" /><path d="M5 20h14" /></>;
    case "check":
      return <path d="m5 12 4 4L19 6" />;
    case "chevron-down":
      return <path d="m7 9 5 5 5-5" />;
    case "chevron-right":
      return <path d="m9 7 5 5-5 5" />;
    default: {
      const exhaustive: never = name;
      return exhaustive;
    }
  }
}
```

- [ ] **Step 4: Implement Button, IconButton, TextField and FilterTab**

Use these interfaces exactly:

```tsx
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "small" | "regular";

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  leadingIcon?: IconName;
}

export interface IconButtonProps
  extends Omit<ButtonProps, "children" | "leadingIcon"> {
  icon: IconName;
  label: string;
}
```

Implement `Button` with `React.forwardRef<HTMLButtonElement, ButtonProps>` and `IconButton` with `React.forwardRef<HTMLButtonElement, IconButtonProps>` so search can restore focus to its trigger. `Button` defaults `type="button"`, keeps its visible children while loading, sets `disabled={disabled || loading}`, and sets `aria-busy`. `IconButton` forwards the ref and sets both `aria-label` and `title` from `label`.

```tsx
export interface TextFieldProps
  extends React.InputHTMLAttributes<HTMLInputElement> {
  leadingIcon?: IconName;
}

export const TextField = React.forwardRef<HTMLInputElement, TextFieldProps>(
  function TextField({ leadingIcon, className = "", ...props }, ref) {
    return (
      <label className={`ui-text-field ${className}`.trim()}>
        {leadingIcon ? <Icon name={leadingIcon} size={16} /> : null}
        <input ref={ref} {...props} />
      </label>
    );
  },
);
```

```tsx
export interface FilterTabProps {
  label: string;
  count?: number;
  selected: boolean;
  onSelect: () => void;
}
```

`FilterTab` renders a `role="tab"` button with `aria-selected`, label, optional count and an `aria-hidden` indicator span.

- [ ] **Step 5: Add exact primitive styles**

`ui.css` must define:

```css
.ui-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  height: var(--control-height);
  padding: 0 var(--space-3);
  border: 1px solid var(--color-stroke-subtle);
  border-radius: var(--radius-control);
  background: var(--color-surface-control);
  color: var(--color-text-primary);
  cursor: pointer;
  transition: background var(--motion-fast) var(--ease-standard),
    border-color var(--motion-fast) var(--ease-standard),
    color var(--motion-fast) var(--ease-standard);
}

.ui-button--small,
.ui-icon-button {
  height: var(--control-height-small);
}

.ui-icon-button {
  width: var(--control-height-small);
  padding: 0;
}

.ui-button--primary {
  border-color: color-mix(in srgb, var(--color-accent) 42%, transparent);
  background: var(--color-accent-soft);
  color: var(--color-accent);
}

.ui-button--ghost {
  border-color: transparent;
  background: transparent;
}

.ui-button--danger {
  border-color: transparent;
  background: transparent;
  color: var(--color-danger);
}

.ui-button:hover:not(:disabled) {
  background: var(--color-surface-control-hover);
  border-color: var(--color-stroke-strong);
}

.ui-button:active:not(:disabled) {
  background: var(--color-surface-control-pressed);
}

.ui-button:disabled {
  opacity: 0.42;
  cursor: default;
}

.ui-icon {
  display: block;
  flex: 0 0 auto;
}

.ui-text-field {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: var(--control-height);
  padding: 0 var(--space-3);
  border: 1px solid var(--color-stroke-subtle);
  border-radius: var(--radius-control);
  background: var(--color-surface-control);
  color: var(--color-text-secondary);
}

.ui-text-field:focus-within {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 2px var(--color-focus-ring);
}

.ui-text-field input {
  min-width: 0;
  width: 100%;
  border: 0;
  outline: 0;
  padding: 0;
  background: transparent;
  color: var(--color-text-primary);
}

.ui-filter-tab {
  position: relative;
  height: 36px;
  padding: 0 var(--space-3);
  border: 0;
  background: transparent;
  color: var(--color-text-secondary);
}

.ui-filter-tab[aria-selected="true"] {
  color: var(--color-text-primary);
}

.ui-filter-tab__count {
  margin-left: var(--space-1);
  color: var(--color-text-tertiary);
  font-variant-numeric: tabular-nums;
}

.ui-filter-tab__indicator {
  position: absolute;
  left: var(--space-3);
  right: var(--space-3);
  bottom: 0;
  height: 2px;
  border-radius: 2px;
  background: transparent;
}

.ui-filter-tab[aria-selected="true"] .ui-filter-tab__indicator {
  background: var(--color-accent);
}
```

Import `ui.css` after `foundations.css` in `styles.css`.

Replace the close text in `ToastHost` with `<Icon name="close" size={14} />` while retaining its existing button label. Replace the leading `▶` in `NetSearchPanel` with `<Icon name="play" size={14} />`; do not change either component's behavior or layout in this phase.

- [ ] **Step 6: Verify primitives**

Run:

```bash
cd desktop
npm test -- renderer/components/ui/uiPrimitives.test.tsx renderer/components/NetSearchPanel.test.tsx
npm run build
```

Expected: PASS with no accessibility query failures.

- [ ] **Step 7: Commit the primitive milestone**

```bash
git add desktop/renderer/components/ui desktop/renderer/components/ToastHost.tsx desktop/renderer/components/NetSearchPanel.tsx desktop/renderer/styles/ui.css desktop/renderer/styles.css
git commit -m "feat(ui): add reusable desktop controls"
```

---

### Task 3: Define the Native Window Contract

**Files:**
- Create: `desktop/electron/windowChrome.test.ts`
- Create: `desktop/renderer/components/shell/WindowChrome.tsx`
- Create: `desktop/renderer/components/shell/WindowChrome.test.tsx`
- Modify: `desktop/electron/windowChrome.ts:1-20`
- Modify: `desktop/electron/windowState.ts:14-17`
- Modify: `desktop/electron/main.ts:471-487`
- Modify: `desktop/renderer/components/Shell.tsx:132-152`
- Create: `desktop/renderer/styles/shell.css`
- Modify: `desktop/renderer/styles.css:1-5`

**Interfaces:**
- Consumes: `window.api.platform` already exposed by `desktop/electron/preload.ts:33`.
- Produces: `MAIN_WINDOW_GEOMETRY`, `windowChromeOptions(platform?)`, `WindowChrome({ platform? })`.

- [ ] **Step 1: Write failing window contract tests**

```ts
// desktop/electron/windowChrome.test.ts
import { describe, expect, it } from "vitest";

import { MAIN_WINDOW_GEOMETRY, windowChromeOptions } from "./windowChrome";

describe("window chrome contract", () => {
  it("uses hidden inset vibrancy on macOS", () => {
    expect(windowChromeOptions("darwin")).toEqual({
      titleBarStyle: "hiddenInset",
      vibrancy: "under-window",
      transparent: true,
    });
  });

  it("keeps the native Windows frame", () => {
    expect(windowChromeOptions("win32")).toEqual({
      frame: true,
      transparent: false,
    });
  });

  it("publishes approved main-window geometry", () => {
    expect(MAIN_WINDOW_GEOMETRY).toEqual({
      width: 1120,
      height: 760,
      minWidth: 760,
      minHeight: 560,
    });
  });
});
```

```tsx
// desktop/renderer/components/shell/WindowChrome.test.tsx
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { WindowChrome } from "./WindowChrome";

afterEach(cleanup);

describe("WindowChrome", () => {
  it("renders only the product title on macOS", () => {
    render(<WindowChrome platform="darwin" />);
    expect(screen.getByText("Downany · 百纳")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("defers to the native title bar on Windows", () => {
    const { container } = render(<WindowChrome platform="win32" />);
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 2: Run window tests and verify missing exports/components fail**

Run:

```bash
cd desktop
npm test -- electron/windowChrome.test.ts renderer/components/shell/WindowChrome.test.tsx
```

Expected: FAIL because geometry, platform injection and Renderer component do not exist.

- [ ] **Step 3: Implement platform-testable window options and geometry**

```ts
export const MAIN_WINDOW_GEOMETRY = {
  width: 1120,
  height: 760,
  minWidth: 760,
  minHeight: 560,
} as const;

export function windowChromeOptions(
  platform: NodeJS.Platform = process.platform,
): WindowChromeOptions {
  if (platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset",
      vibrancy: "under-window",
      transparent: true,
    };
  }
  return { frame: true, transparent: false };
}
```

Use `MAIN_WINDOW_GEOMETRY.width/height` only for `windowState.ts` defaults so persisted user geometry remains authoritative. Use `MAIN_WINDOW_GEOMETRY.minWidth/minHeight` in `main.ts`, and change `title` to `Downany · 百纳`.

- [ ] **Step 4: Implement and integrate WindowChrome**

```tsx
interface WindowChromeProps {
  platform?: NodeJS.Platform;
}

export function WindowChrome({
  platform = window.api.platform,
}: WindowChromeProps) {
  if (platform !== "darwin") return null;
  return (
    <header className="window-chrome">
      <span className="window-chrome__title">Downany · 百纳</span>
    </header>
  );
}
```

Render `<WindowChrome />` before the existing `<TopBar />` in `Shell`. Add `data-platform={window.api.platform}` to `.window-shell`.

Add to `shell.css`:

```css
.window-chrome {
  position: relative;
  display: grid;
  place-items: center;
  height: 44px;
  flex: 0 0 44px;
  border-bottom: 1px solid var(--color-stroke-subtle);
  background: var(--color-surface-chrome);
  -webkit-app-region: drag;
}

.window-chrome__title {
  color: var(--color-text-secondary);
  font-size: 13px;
  font-weight: 500;
  line-height: 18px;
}

.window-shell[data-platform="darwin"] .topbar {
  padding-top: 0;
  padding-left: 16px;
  -webkit-app-region: no-drag;
}
```

Import `shell.css` after `ui.css`.

- [ ] **Step 5: Verify window behavior**

Run:

```bash
cd desktop
npm test -- electron/windowChrome.test.ts renderer/components/shell/WindowChrome.test.tsx
npm run build
```

Expected: PASS; build keeps Windows native framing and macOS hidden inset options.

- [ ] **Step 6: Commit the window contract**

```bash
git add desktop/electron/windowChrome.ts desktop/electron/windowChrome.test.ts desktop/electron/windowState.ts desktop/electron/main.ts desktop/renderer/components/shell/WindowChrome.tsx desktop/renderer/components/shell/WindowChrome.test.tsx desktop/renderer/components/Shell.tsx desktop/renderer/styles/shell.css desktop/renderer/styles.css
git commit -m "feat(ui): separate window chrome from actions"
```

---

### Task 4: Split ActionBar and FilterBar

**Files:**
- Create: `desktop/renderer/components/shell/ActionBar.tsx`
- Create: `desktop/renderer/components/shell/FilterBar.tsx`
- Create: `desktop/renderer/components/shell/SearchPopover.tsx`
- Create: `desktop/renderer/components/shell/ActionBar.test.tsx`
- Create: `desktop/renderer/components/shell/FilterBar.test.tsx`
- Modify: `desktop/renderer/components/Shell.tsx:1-152`
- Modify: `desktop/renderer/i18n.ts:9-53`
- Modify: `desktop/renderer/styles/shell.css`
- Modify: `desktop/renderer/styles.css:69-321`
- Delete: `desktop/renderer/components/TopBar.tsx`

**Interfaces:**
- Consumes: `Button`, `IconButton`, `TextField`, `FilterTab`, Zustand store, current `submitAddText`, `request`, `openExtractWindow`, `NetSearchPanel`.
- Produces: `ActionBar` with unchanged add/search/batch/settings behavior; `FilterBar` with exact counts; `SearchPopover` controlled by `open/onClose`.

- [ ] **Step 1: Write failing FilterBar tests**

```tsx
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useAppStore } from "../../store/appStore";
import { taskFixture } from "../../test/taskFixture";
import { FilterBar } from "./FilterBar";

afterEach(cleanup);

beforeEach(() => {
  localStorage.clear();
  useAppStore.setState({
    filter: "all",
    tasks: [
      taskFixture({ id: "1", status: "downloading" }),
      taskFixture({ id: "2", status: "paused" }),
      taskFixture({ id: "3", status: "completed" }),
    ],
  });
});

describe("FilterBar", () => {
  it("shows counts and a single selected tab", () => {
    render(<FilterBar />);
    expect(screen.getByRole("tab", { name: "全部 3" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "进行中 2" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "已完成 1" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "下载记录" })).toBeInTheDocument();
  });

  it("changes the store filter", () => {
    render(<FilterBar />);
    fireEvent.click(screen.getByRole("tab", { name: "进行中 2" }));
    expect(useAppStore.getState().filter).toBe("active");
  });
});
```

Create the shared fixture before either shell test:

```ts
// desktop/renderer/test/taskFixture.ts
import type { TaskSnapshot } from "../lib/types";

export function taskFixture(
  overrides: Partial<TaskSnapshot> = {},
): TaskSnapshot {
  return {
    id: "task-1",
    url: "https://example.com/video",
    title: "示例视频",
    platform: "youtube",
    thumbnail_url: "",
    status: "pending",
    progress: 0,
    downloaded_bytes: 0,
    total_bytes: 0,
    speed: "—",
    eta: "—",
    file_path: "",
    error_message: "",
    created_at: "2026-08-16T10:00:00Z",
    started_at: null,
    completed_at: null,
    quality: "best",
    format_id: null,
    audio_only: false,
    postprocessing: "none",
    priority: 0,
    queue_order: 0,
    ...overrides,
  };
}
```

- [ ] **Step 2: Write failing ActionBar tests**

Use explicit module and bridge mocks before the tests:

```tsx
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DesktopApi } from "../../../electron/preload";
import { useAppStore } from "../../store/appStore";
import { ActionBar } from "./ActionBar";

const submitAddTextMock = vi.fn();
const requestMock = vi.fn();
const openExtractWindowMock = vi.fn();
const openSettingsMock = vi.fn();

vi.mock("../../lib/addFlow", () => ({
  submitAddText: (...args: unknown[]) => submitAddTextMock(...args),
}));

vi.mock("../../lib/api", () => ({
  request: (...args: unknown[]) => requestMock(...args),
  openExtractWindow: (...args: unknown[]) => openExtractWindowMock(...args),
}));

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  requestMock.mockResolvedValue({ tasks: [], settings: null });
  openExtractWindowMock.mockResolvedValue(undefined);
  openSettingsMock.mockResolvedValue(undefined);
  useAppStore.setState({
    connection: "connected",
    searchMode: "filter",
    searchQuery: "",
    toasts: [],
  });
  window.api = ({
    platform: "darwin",
    openSettings: openSettingsMock,
  } satisfies Partial<DesktopApi>) as DesktopApi;
});
```

```tsx
it("submits the link from the explicit Add action", async () => {
  submitAddTextMock.mockResolvedValue(["https://example.com/video"]);
  render(<ActionBar />);
  fireEvent.change(screen.getByRole("textbox", { name: "添加下载链接" }), {
    target: { value: "https://example.com/video" },
  });
  fireEvent.click(screen.getByRole("button", { name: "添加" }));
  await waitFor(() =>
    expect(submitAddTextMock).toHaveBeenCalledWith("https://example.com/video"),
  );
});

it("opens and closes the search popover with focus restoration", () => {
  render(<ActionBar />);
  const trigger = screen.getByRole("button", { name: "搜索" });
  fireEvent.click(trigger);
  expect(screen.getByRole("dialog", { name: "搜索任务" })).toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole("dialog", { name: "搜索任务" }), {
    key: "Escape",
  });
  expect(screen.queryByRole("dialog", { name: "搜索任务" })).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

it("requires a URL before opening webpage recognition", () => {
  render(<ActionBar />);
  fireEvent.click(screen.getByRole("button", { name: "网页识别" }));
  expect(useAppStore.getState().toasts.at(-1)?.title).toBe(
    "请先输入要识别的页面链接",
  );
  expect(openExtractWindowMock).not.toHaveBeenCalled();
});

it("opens settings from the dedicated icon action", () => {
  render(<ActionBar />);
  fireEvent.click(screen.getByRole("button", { name: "设置" }));
  expect(openSettingsMock).toHaveBeenCalledOnce();
});
```

- [ ] **Step 3: Run shell tests and verify missing modules fail**

Run:

```bash
cd desktop
npm test -- renderer/components/shell/ActionBar.test.tsx renderer/components/shell/FilterBar.test.tsx
```

Expected: FAIL because the split components and fixture do not exist.

- [ ] **Step 4: Implement FilterBar and approved copy**

Use this fixed filter definition:

```ts
const FILTERS: Array<{ key: ListFilter; labelKey: string }> = [
  { key: "all", labelKey: "nav.all" },
  { key: "active", labelKey: "nav.active" },
  { key: "completed", labelKey: "nav.completed" },
  { key: "history", labelKey: "nav.history" },
];
```

Counts are `tasks.length`, active status count, completed count, and `undefined` for history. Change Chinese `nav.history` to `下载记录`; English remains `History`.

Add these keys to both dictionaries in `i18n.ts`:

```ts
// zhCN
"action.add": "添加",
"action.recognize": "网页识别",
"action.search": "搜索",
"action.batch": "批量操作",
"search.network.placeholder": "搜索网络视频",

// en
"action.add": "Add",
"action.recognize": "Recognize page",
"action.search": "Search",
"action.batch": "Batch actions",
"search.network.placeholder": "Search online videos",
```

```tsx
export function FilterBar() {
  const tasks = useAppStore((state) => state.tasks);
  const filter = useAppStore((state) => state.filter);
  const setFilter = useAppStore((state) => state.setFilter);
  const [locale, setLocaleState] = useState<Locale>(() => getLocale());

  useEffect(() => {
    const updateLocale = () => setLocaleState(getLocale());
    window.addEventListener("downany:locale", updateLocale);
    return () => window.removeEventListener("downany:locale", updateLocale);
  }, []);

  const counts: Partial<Record<ListFilter, number>> = {
    all: tasks.length,
    active: tasks.filter((task) => isActiveStatus(task.status)).length,
    completed: tasks.filter((task) => task.status === "completed").length,
  };

  return (
    <nav className="filter-bar" role="tablist" aria-label="任务筛选">
      {FILTERS.map((item) => (
        <FilterTab
          key={item.key}
          label={t(item.labelKey, locale)}
          count={counts[item.key]}
          selected={filter === item.key}
          onSelect={() => setFilter(item.key)}
        />
      ))}
    </nav>
  );
}
```

- [ ] **Step 5: Implement SearchPopover**

Use this interface:

```tsx
interface SearchPopoverProps {
  open: boolean;
  mode: SearchMode;
  query: string;
  platform: string;
  locale: Locale;
  inputRef: React.RefObject<HTMLInputElement>;
  onModeChange: (mode: SearchMode) => void;
  onQueryChange: (query: string) => void;
  onPlatformChange: (platform: string) => void;
  onSubmitNetwork: () => void;
  onClose: () => void;
}
```

Implement the controlled popover with the existing two modes and three platforms:

```tsx
const SEARCH_MODES: Array<{ key: SearchMode; labelKey: string }> = [
  { key: "filter", labelKey: "search.filter" },
  { key: "network", labelKey: "search.network" },
];

const SEARCH_PLATFORMS = [
  { key: "youtube", label: "YouTube" },
  { key: "bilibili", label: "Bilibili" },
  { key: "pornhub", label: "Pornhub" },
] as const;

export function SearchPopover(props: SearchPopoverProps) {
  useEffect(() => {
    if (props.open) queueMicrotask(() => props.inputRef.current?.focus());
  }, [props.inputRef, props.open]);

  if (!props.open) return null;
  return (
    <div
      className="search-popover"
      role="dialog"
      aria-label="搜索任务"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          props.onClose();
        }
      }}
    >
      <div className="search-popover__modes" role="group" aria-label="搜索模式">
        {SEARCH_MODES.map((mode) => (
          <Button
            key={mode.key}
            size="small"
            variant={props.mode === mode.key ? "primary" : "ghost"}
            aria-pressed={props.mode === mode.key}
            onClick={() => props.onModeChange(mode.key)}
          >
            {t(mode.labelKey, props.locale)}
          </Button>
        ))}
      </div>
      {props.mode === "network" ? (
        <select
          aria-label="搜索平台"
          value={props.platform}
          onChange={(event) => props.onPlatformChange(event.target.value)}
        >
          {SEARCH_PLATFORMS.map((platform) => (
            <option key={platform.key} value={platform.key}>
              {platform.label}
            </option>
          ))}
        </select>
      ) : null}
      <TextField
        ref={props.inputRef}
        leadingIcon="search"
        type="search"
        aria-label="搜索任务"
        placeholder={
          props.mode === "network"
            ? t("search.network.placeholder", props.locale)
            : t("search.placeholder", props.locale)
        }
        value={props.query}
        onChange={(event) => props.onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && props.mode === "network") {
            event.preventDefault();
            props.onSubmitNetwork();
          }
        }}
      />
      <IconButton icon="close" label="关闭搜索" onClick={props.onClose} />
    </div>
  );
}
```

- [ ] **Step 6: Implement ActionBar by moving existing behavior, not copying state**

Keep the existing Zustand fields and handlers, adding only the controlled popover state and trigger ref:

```tsx
export function ActionBar() {
  const connection = useAppStore((state) => state.connection);
  const searchQuery = useAppStore((state) => state.searchQuery);
  const setSearchQuery = useAppStore((state) => state.setSearchQuery);
  const searchMode = useAppStore((state) => state.searchMode);
  const setSearchMode = useAppStore((state) => state.setSearchMode);
  const addFocusSignal = useAppStore((state) => state.addFocusSignal);
  const pushToast = useAppStore((state) => state.pushToast);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [netPlatform, setNetPlatform] = useState("youtube");
  const [locale, setLocaleState] = useState<Locale>(() => getLocale());
  const addRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchTriggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDetailsElement>(null);
  const disabled = connection !== "connected";

  useEffect(() => {
    const updateLocale = () => setLocaleState(getLocale());
    window.addEventListener("downany:locale", updateLocale);
    return () => window.removeEventListener("downany:locale", updateLocale);
  }, []);

  useEffect(() => {
    if (addFocusSignal > 0) addRef.current?.focus();
  }, [addFocusSignal]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey) return;
      if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        addRef.current?.focus();
      } else if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const onToggle = () => {
      if (menu.open) {
        window.dispatchEvent(
          new CustomEvent<string>("downany:task-menu-open", {
            detail: "action-bar",
          }),
        );
      }
    };
    const closeForOtherMenu = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== "action-bar") menu.open = false;
    };
    menu.addEventListener("toggle", onToggle);
    window.addEventListener("downany:task-menu-open", closeForOtherMenu);
    return () => {
      menu.removeEventListener("toggle", onToggle);
      window.removeEventListener("downany:task-menu-open", closeForOtherMenu);
    };
  }, []);

  const addUrls = async (raw: string) => {
    setBusy(true);
    try {
      const urls = await submitAddText(raw);
      if (urls.length > 0) setText("");
    } finally {
      setBusy(false);
    }
  };

  const runNetSearch = async () => {
    const query = searchQuery.trim();
    if (!query) return;
    try {
      const response = await request<{ searchId: string }>("search.query", {
        query,
        platform: netPlatform,
        maxResults: 12,
      });
      useAppStore.getState().startNetSearch(response.searchId);
    } catch (error) {
      pushToast({ kind: "error", title: "搜索失败", detail: String(error) });
    }
  };

  const batch = async (method: string, successTitle: string) => {
    if (menuRef.current) menuRef.current.open = false;
    try {
      await request(method, {});
      const snapshot = await request<AppSnapshot>("app.getSnapshot");
      useAppStore.getState().hydrateSnapshot(snapshot);
      pushToast({ kind: "success", title: successTitle });
    } catch (error) {
      pushToast({ kind: "error", title: "操作失败", detail: String(error) });
    }
  };

  const openExtract = async () => {
    const candidate = text.trim();
    if (!candidate) {
      pushToast({ kind: "info", title: "请先输入要识别的页面链接" });
      addRef.current?.focus();
      return;
    }
    try {
      await openExtractWindow(candidate);
    } catch (error) {
      pushToast({
        kind: "error",
        title: "无法打开网页识别",
        detail: String(error),
      });
    }
  };

  return (
    <section className="action-bar" aria-label="下载操作">
  <TextField
    ref={addRef}
    leadingIcon="link"
    aria-label="添加下载链接"
    placeholder={t("add.placeholder", locale)}
    value={text}
    disabled={disabled || busy}
    onChange={(event) => setText(event.target.value)}
    onKeyDown={(event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void addUrls(text);
      }
    }}
  />
  <Button
    variant="primary"
    loading={busy}
    leadingIcon="plus"
    onClick={() => void addUrls(text)}
  >
    {t("action.add", locale)}
  </Button>
  <Button
    className="action-bar__recognize"
    variant="ghost"
    leadingIcon="capture"
    aria-label={t("action.recognize", locale)}
    disabled={disabled}
    onClick={() => void openExtract()}
  >
    <span className="action-bar__recognize-label">
      {t("action.recognize", locale)}
    </span>
  </Button>
  <IconButton
    ref={searchTriggerRef}
    icon="search"
    label={t("action.search", locale)}
    onClick={() => setSearchOpen(true)}
  />
  <details className="action-bar__menu" ref={menuRef}>
    <summary aria-label={t("action.batch", locale)}>
      <Icon name="more" size={16} />
    </summary>
    <div className="action-bar__menu-list" role="menu">
      <button
        type="button"
        role="menuitem"
        disabled={disabled}
        onClick={() => void batch("download.pauseAll", "已全部暂停")}
      >
        全部暂停
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={disabled}
        onClick={() => void batch("download.resumeAll", "已全部恢复")}
      >
        全部恢复
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={disabled}
        onClick={() => void batch("download.clearFinished", "已清除完成项")}
      >
        清除已完成
      </button>
    </div>
  </details>
  <IconButton
    icon="settings"
    label={t("settings.open", locale)}
    onClick={() => void window.api.openSettings()}
  />
  <SearchPopover
    open={searchOpen}
    mode={searchMode}
    query={searchQuery}
    platform={netPlatform}
    locale={locale}
    inputRef={searchInputRef}
    onModeChange={setSearchMode}
    onQueryChange={setSearchQuery}
    onPlatformChange={setNetPlatform}
    onSubmitNetwork={() => void runNetSearch()}
    onClose={() => {
      setSearchOpen(false);
      searchTriggerRef.current?.focus();
    }}
  />
    </section>
  );
}
```

Preserve `CmdOrCtrl+N`, `CmdOrCtrl+F`, Enter-to-add, network search, pause all, resume all and clear finished. Rename visible `浏览器抓取` to `网页识别`; do not rename internal API methods.

- [ ] **Step 7: Compose the four-layer Shell and remove TopBar**

Use this exact order:

```tsx
<div className="window-shell" data-platform={window.api.platform}>
  <WindowChrome />
  <ActionBar />
  <FilterBar />
  <NetSearchPanel />
  <main className="window-main" id="main">
    {filter === "history" ? <HistorySection /> : <TaskList />}
  </main>
  <AddConfirmDialog />
  <ToastHost />
</div>
```

Delete `TopBar.tsx`. Remove `.topbar*`, `.segments` and `.segment` rules; preserve `.net-*` rules by moving them into `shell.css` under `.window-shell`.

- [ ] **Step 8: Implement the approved shell dimensions**

```css
.action-bar {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 48px;
  flex: 0 0 48px;
  padding: 0 var(--space-4);
  border-bottom: 1px solid var(--color-stroke-subtle);
  background: var(--color-surface-chrome);
  -webkit-app-region: no-drag;
}

.action-bar .ui-text-field {
  flex: 1 1 auto;
  min-width: 180px;
}

.filter-bar {
  display: flex;
  align-items: flex-end;
  height: 36px;
  flex: 0 0 36px;
  padding: 0 var(--space-4);
  border-bottom: 1px solid var(--color-stroke-subtle);
  background: var(--color-surface-chrome);
}

.action-bar__menu {
  position: relative;
}

.action-bar__menu > summary {
  display: grid;
  width: var(--control-height-small);
  height: var(--control-height-small);
  place-items: center;
  border: 1px solid transparent;
  border-radius: var(--radius-control);
  color: var(--color-text-secondary);
  cursor: pointer;
  list-style: none;
}

.action-bar__menu > summary::-webkit-details-marker {
  display: none;
}

.action-bar__menu[open] > summary,
.action-bar__menu > summary:hover {
  border-color: var(--color-stroke-subtle);
  background: var(--color-surface-control-hover);
  color: var(--color-text-primary);
}

.action-bar__menu-list {
  position: absolute;
  top: calc(100% + var(--space-2));
  right: 0;
  z-index: 46;
  display: grid;
  min-width: 160px;
  padding: var(--space-1);
  border: 1px solid var(--color-stroke-strong);
  border-radius: var(--radius-control);
  background: var(--color-surface-raised);
  box-shadow: var(--elevation-overlay);
}

.action-bar__menu-list button {
  min-height: 28px;
  border: 0;
  border-radius: var(--radius-small);
  padding: 0 var(--space-2);
  background: transparent;
  color: var(--color-text-primary);
  text-align: left;
}

.action-bar__menu-list button:hover:not(:disabled) {
  background: var(--color-surface-control-hover);
}

.search-popover {
  position: absolute;
  top: calc(100% + var(--space-2));
  right: 72px;
  z-index: 45;
  width: min(320px, calc(100vw - 32px));
  padding: var(--space-3);
  border: 1px solid var(--color-stroke-strong);
  border-radius: var(--radius-popover);
  background: var(--color-surface-raised);
  box-shadow: var(--elevation-overlay);
}

.search-popover {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--space-2);
}

.search-popover__modes {
  display: flex;
  grid-column: 1 / -1;
  gap: var(--space-1);
}

.search-popover > select {
  grid-column: 1 / -1;
  height: var(--control-height-small);
  border: 1px solid var(--color-stroke-subtle);
  border-radius: var(--radius-small);
  padding: 0 var(--space-2);
  background: var(--color-surface-control);
  color: var(--color-text-primary);
}

.window-main {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-4) var(--space-4) var(--space-8);
}

@media (max-width: 900px) {
  .action-bar__recognize {
    width: var(--control-height-small);
    padding: 0;
  }

  .action-bar__recognize-label {
    display: none;
  }
}
```

At `max-width: 900px`, this hides only the visible text inside the webpage-recognition button while preserving its translated `aria-label`; the action remains available.

- [ ] **Step 9: Verify shell behavior and build**

Run:

```bash
cd desktop
npm test -- renderer/components/shell/ActionBar.test.tsx renderer/components/shell/FilterBar.test.tsx renderer/components/NetSearchPanel.test.tsx
npm run build
```

Expected: PASS; no `TopBar` import remains.

- [ ] **Step 10: Commit the shell split**

```bash
git add desktop/renderer/components/shell desktop/renderer/components/Shell.tsx desktop/renderer/components/TopBar.tsx desktop/renderer/i18n.ts desktop/renderer/test/taskFixture.ts desktop/renderer/styles/shell.css desktop/renderer/styles.css
git commit -m "feat(ui): split desktop action and filter layers"
```

---

### Task 5: Define the Task Presentation Model

**Files:**
- Create: `desktop/renderer/components/task/taskPresentation.ts`
- Create: `desktop/renderer/components/task/taskPresentation.test.ts`
- Modify: `desktop/renderer/lib/format.ts:9-30`

**Interfaces:**
- Consumes: `TaskSnapshot`, `formatBytes`, `friendlyErrorMessage`, `platformLabel`.
- Produces: `TaskVisualState`, `TaskTone`, `TaskPrimaryAction`, `TaskPresentation`, `presentTask(task, now?)`, `toTaskVisualState(status)`.

- [ ] **Step 1: Write failing six-state presentation tests**

```ts
import { describe, expect, it } from "vitest";

import { taskFixture } from "../../test/taskFixture";
import { presentTask, toTaskVisualState } from "./taskPresentation";

describe("task presentation", () => {
  it.each([
    ["pending", "等待中", "neutral", null],
    ["downloading", "下载中", "active", "pause"],
    ["paused", "已暂停", "warning", "resume"],
    ["completed", "已完成", "success", "open"],
    ["failed", "下载失败", "danger", "retry"],
    ["cancelled", "已取消", "neutral", "retry"],
  ] as const)("maps %s", (status, label, tone, primaryAction) => {
    const result = presentTask(
      taskFixture({ status, file_path: status === "completed" ? "/tmp/a.mp4" : "" }),
      new Date("2026-08-16T12:00:00Z"),
    );
    expect(result).toMatchObject({ status, label, tone, primaryAction });
  });

  it("falls back safely for an unknown runtime state", () => {
    expect(toTaskVisualState("mystery")).toBe("unknown");
    expect(presentTask(taskFixture({ status: "mystery" })).label).toBe("状态未知");
  });

  it("builds completed metadata without a progress line", () => {
    const result = presentTask(
      taskFixture({
        status: "completed",
        quality: "1080p",
        total_bytes: 128_600_000,
        completed_at: "2026-08-16T11:32:00Z",
        file_path: "/tmp/a.mp4",
      }),
      new Date("2026-08-16T12:00:00Z"),
    );
    expect(result.meta).toEqual(
      expect.arrayContaining(["YouTube", "1080p", "122.6 MB"]),
    );
    expect(result.showProgress).toBe(false);
  });
});
```

- [ ] **Step 2: Run and verify missing presentation module fails**

Run:

```bash
cd desktop
npm test -- renderer/components/task/taskPresentation.test.ts
```

Expected: FAIL because `taskPresentation.ts` does not exist.

- [ ] **Step 3: Implement a total presentation mapping**

Use these exact types:

```ts
export type TaskVisualState =
  | "pending"
  | "downloading"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

export type TaskTone = "neutral" | "active" | "warning" | "success" | "danger";
export type TaskPrimaryAction = "pause" | "resume" | "open" | "retry" | null;

export interface TaskPresentation {
  status: TaskVisualState;
  label: string;
  tone: TaskTone;
  meta: string[];
  detail: string;
  primaryAction: TaskPrimaryAction;
  primaryLabel: string;
  showProgress: boolean;
  progress: number;
}
```

Implement the mapping as a total function. Keep `statusLabel` in `lib/format.ts` as the only label table, change `failed` to `下载失败`, and make its default return `状态未知`; `presentTask` must call it instead of declaring another label map.

```ts
import {
  formatBytes,
  friendlyErrorMessage,
  platformLabel,
  statusLabel,
} from "../../lib/format";
import type { TaskSnapshot } from "../../lib/types";

const STATE_VIEW = {
  pending: { tone: "neutral", primaryAction: null, primaryLabel: "" },
  downloading: { tone: "active", primaryAction: "pause", primaryLabel: "暂停" },
  paused: { tone: "warning", primaryAction: "resume", primaryLabel: "继续" },
  completed: { tone: "success", primaryAction: "open", primaryLabel: "打开" },
  failed: { tone: "danger", primaryAction: "retry", primaryLabel: "重试" },
  cancelled: { tone: "neutral", primaryAction: "retry", primaryLabel: "重新下载" },
  unknown: { tone: "neutral", primaryAction: null, primaryLabel: "" },
} as const satisfies Record<
  TaskVisualState,
  {
    tone: TaskTone;
    primaryAction: TaskPrimaryAction;
    primaryLabel: string;
  }
>;

export function toTaskVisualState(status: string): TaskVisualState {
  switch (status) {
    case "pending":
    case "downloading":
    case "paused":
    case "completed":
    case "failed":
    case "cancelled":
      return status;
    default:
      return "unknown";
  }
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function completedLabel(value: string, now: Date): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  return sameDay
    ? `今天 ${time}`
    : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

export function presentTask(
  task: TaskSnapshot,
  now = new Date(),
): TaskPresentation {
  const status = toTaskVisualState(task.status);
  const stateView = STATE_VIEW[status];
  const bytes = formatBytes(task.total_bytes || task.downloaded_bytes);
  const meta = [platformLabel(task.platform)];
  if (task.quality && task.quality !== "best") meta.push(task.quality);
  if (bytes !== "—") meta.push(bytes);
  if (status === "completed" && task.completed_at) {
    const completed = completedLabel(task.completed_at, now);
    if (completed) meta.push(completed);
  }

  const transferDetail = [
    `${formatBytes(task.downloaded_bytes)} / ${formatBytes(task.total_bytes)}`,
    task.speed,
    task.eta,
  ]
    .filter((item) => item && item !== "—")
    .join(" · ");
  const detail =
    status === "failed"
      ? friendlyErrorMessage(task.error_message)
      : status === "downloading" || status === "paused"
        ? transferDetail
        : "";
  const progress = Number.isFinite(Number(task.progress))
    ? Math.min(100, Math.max(0, Number(task.progress)))
    : 0;
  const canOpen = status !== "completed" || Boolean(task.file_path);

  return {
    status,
    label: statusLabel(status),
    tone: stateView.tone,
    meta,
    detail,
    primaryAction: canOpen ? stateView.primaryAction : null,
    primaryLabel: canOpen ? stateView.primaryLabel : "",
    showProgress: status === "downloading" || status === "paused",
    progress,
  };
}
```

This keeps unknown runtime values safe, clamps progress to `0–100`, suppresses `open` when a completed task has no `file_path`, and formats same-day completion as `今天 HH:mm` or otherwise `YYYY-MM-DD HH:mm`.

- [ ] **Step 4: Verify presentation model**

Run:

```bash
cd desktop
npm test -- renderer/components/task/taskPresentation.test.ts renderer/store/appStore.test.ts
```

Expected: PASS; existing store behavior unchanged.

- [ ] **Step 5: Commit the presentation model**

```bash
git add desktop/renderer/components/task/taskPresentation.ts desktop/renderer/components/task/taskPresentation.test.ts desktop/renderer/lib/format.ts
git commit -m "refactor(ui): define task presentation states"
```

---

### Task 6: Build MediaTaskBanner Without Losing Task Behavior

**Files:**
- Create: `desktop/renderer/components/task/useTaskCommands.ts`
- Create: `desktop/renderer/components/task/TaskActionsMenu.tsx`
- Create: `desktop/renderer/components/task/MediaTaskBanner.tsx`
- Create: `desktop/renderer/components/task/MediaTaskBanner.test.tsx`

**Interfaces:**
- Consumes: Task 2 primitives, Task 5 presentation model, existing `request/openPath/openSettings/openExtractWindow`, `window.api.showItemInFolder`, `window.api.showTaskContextMenu`.
- Produces: `TaskCommands`, `useTaskCommands(task)`, `buildTaskContextTemplate(task)`, `MediaTaskBanner({ task, density? })`.

- [ ] **Step 1: Write failing banner structure and action tests**

```tsx
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAppStore } from "../../store/appStore";
import { taskFixture } from "../../test/taskFixture";
import { MediaTaskBanner } from "./MediaTaskBanner";

const requestMock = vi.fn();
const openPathMock = vi.fn();
const openSettingsMock = vi.fn();
const openExtractWindowMock = vi.fn();
const showItemInFolderMock = vi.fn();
const showTaskContextMenuMock = vi.fn();

vi.mock("../../lib/api", () => ({
  request: (...args: unknown[]) => requestMock(...args),
  openPath: (...args: unknown[]) => openPathMock(...args),
  openSettings: (...args: unknown[]) => openSettingsMock(...args),
  openExtractWindow: (...args: unknown[]) => openExtractWindowMock(...args),
}));

afterEach(cleanup);

beforeEach(() => {
  requestMock.mockReset();
  requestMock.mockResolvedValue({ tasks: [], settings: null });
  openPathMock.mockReset();
  openSettingsMock.mockReset();
  openSettingsMock.mockResolvedValue(undefined);
  openExtractWindowMock.mockReset();
  openExtractWindowMock.mockResolvedValue(undefined);
  showItemInFolderMock.mockReset();
  showItemInFolderMock.mockResolvedValue(undefined);
  showTaskContextMenuMock.mockReset();
  showTaskContextMenuMock.mockResolvedValue(null);
  useAppStore.setState({ tasks: [], settings: null, toasts: [] });
  (window as unknown as { api: Record<string, unknown> }).api = {
    platform: "darwin",
    showItemInFolder: showItemInFolderMock,
    showTaskContextMenu: showTaskContextMenuMock,
  };
});

describe("MediaTaskBanner", () => {
  it("renders artwork, shade, one reading glass and content layers", () => {
    const { container } = render(
      <MediaTaskBanner
        task={taskFixture({ thumbnail_url: "https://example.com/thumb.jpg" })}
      />,
    );
    expect(container.querySelectorAll(".media-task-banner__artwork")).toHaveLength(1);
    expect(container.querySelectorAll(".media-task-banner__shade")).toHaveLength(1);
    expect(container.querySelectorAll(".media-task-banner__glass")).toHaveLength(1);
    expect(container.querySelectorAll(".media-task-banner__content")).toHaveLength(1);
    expect(container.querySelector(".media-task-banner")).toHaveAttribute(
      "data-artwork-tone",
      "medium",
    );
  });

  it("accepts an explicit artwork tone", () => {
    const { container } = render(
      <MediaTaskBanner task={taskFixture()} artworkTone="light" />,
    );
    expect(container.querySelector(".media-task-banner")).toHaveAttribute(
      "data-artwork-tone",
      "light",
    );
  });

  it.each([
    ["downloading", "暂停", "download.pause"],
    ["paused", "继续", "download.resume"],
    ["failed", "重试", "download.retry"],
    ["cancelled", "重新下载", "download.retry"],
  ] as const)("runs the direct %s action", async (status, label, method) => {
    render(<MediaTaskBanner task={taskFixture({ status })} />);
    fireEvent.click(screen.getByRole("button", { name: label }));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(method, { taskId: "task-1" }),
    );
  });

  it("opens a completed file and does not show a green progress line", () => {
    const { container } = render(
      <MediaTaskBanner
        task={taskFixture({ status: "completed", file_path: "/tmp/video.mp4" })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "打开" }));
    expect(openPathMock).toHaveBeenCalledWith("/tmp/video.mp4");
    expect(container.querySelector(".media-task-banner__progress")).toBeNull();
  });

  it("exposes a clamped accessible progress value", () => {
    render(
      <MediaTaskBanner task={taskFixture({ status: "downloading", progress: 130 })} />,
    );
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
  });
});
```

- [ ] **Step 2: Run banner tests and verify the module fails**

Run:

```bash
cd desktop
npm test -- renderer/components/task/MediaTaskBanner.test.tsx
```

Expected: FAIL because the banner and command modules do not exist.

- [ ] **Step 3: Implement TaskCommands around existing APIs**

Use this interface:

```ts
export interface TaskCommands {
  run: (
    method: "download.pause" | "download.resume" | "download.cancel" |
      "download.retry" | "download.remove",
  ) => Promise<void>;
  update: (patch: Record<string, unknown>) => Promise<void>;
  open: () => Promise<void>;
  reveal: () => Promise<void>;
  recognizePage: () => Promise<void>;
  openSettings: () => Promise<void>;
}
```

Implement the hook with the existing error copy and one shared refresh path:

```ts
import { useCallback, useMemo } from "react";

import {
  openExtractWindow,
  openPath,
  openSettings as openSettingsWindow,
  request,
} from "../../lib/api";
import type { AppSnapshot, TaskSnapshot } from "../../lib/types";
import { useAppStore } from "../../store/appStore";

export function useTaskCommands(task: TaskSnapshot): TaskCommands {
  const pushToast = useAppStore((state) => state.pushToast);

  const refresh = useCallback(async () => {
    const snapshot = await request<AppSnapshot>("app.getSnapshot");
    useAppStore.getState().hydrateSnapshot(snapshot);
  }, []);

  const run = useCallback<TaskCommands["run"]>(
    async (method) => {
      try {
        await request(method, { taskId: task.id });
        await refresh();
      } catch (error) {
        pushToast({ kind: "error", title: "操作失败", detail: String(error) });
      }
    },
    [pushToast, refresh, task.id],
  );

  const update = useCallback<TaskCommands["update"]>(
    async (patch) => {
      try {
        await request("download.updateTask", { taskId: task.id, ...patch });
        await refresh();
      } catch (error) {
        pushToast({ kind: "error", title: "更新失败", detail: String(error) });
      }
    },
    [pushToast, refresh, task.id],
  );

  return useMemo(
    () => ({
      run,
      update,
      open: async () => {
        if (task.file_path) await openPath(task.file_path);
      },
      reveal: async () => {
        if (task.file_path) await window.api.showItemInFolder(task.file_path);
      },
      recognizePage: () => openExtractWindow(task.url),
      openSettings: () => openSettingsWindow(),
    }),
    [run, task.file_path, task.url, update],
  );
}
```

- [ ] **Step 4: Move the complete action matrix into TaskActionsMenu**

The action matrix is fixed:

| State | Inline primary | More/context actions |
|---|---|---|
| pending | none | rename, webpage recognition, priority, audio, postprocessing, cancel |
| downloading | pause | rename, webpage recognition, priority, pause, cancel; audio/postprocessing disabled |
| paused | resume | rename, webpage recognition, priority, audio, postprocessing, resume, cancel |
| completed | open | rename, webpage recognition, open, reveal, remove |
| failed | retry | rename, webpage recognition, priority, audio, postprocessing, retry, remove |
| cancelled | retry | rename, webpage recognition, retry, remove |

Use generic visible copy `在文件夹中显示`, not `在访达中显示`, so Windows does not receive macOS wording. The more trigger must be `<IconButton icon="more" label="更多操作" />`; menu check state uses `<Icon name="check" />`, not `✓`.

Export the native template builder and make it deterministic:

```ts
import type { ContextMenuTemplateItem } from "../../../electron/preload";

const POSTPROCESSING_OPTIONS = [
  { value: "none", label: "无后处理" },
  { value: "mp4", label: "转换为 MP4" },
  { value: "mp3", label: "提取音频 (MP3)" },
  { value: "script", label: "自定义脚本" },
] as const;

export function buildTaskContextTemplate(
  task: TaskSnapshot,
): ContextMenuTemplateItem[] {
  const status = toTaskVisualState(task.status);
  const showDownloadOptions =
    status === "pending" ||
    status === "downloading" ||
    status === "paused" ||
    status === "failed";
  const optionEditable = status !== "downloading";
  const items: ContextMenuTemplateItem[] = [
    { id: "rename", label: "重命名" },
    { id: "extract", label: "网页识别" },
  ];

  if (showDownloadOptions) {
    items.push(
      { id: "separator-download", label: "", type: "separator" },
      {
        id: (task.priority ?? 0) > 0 ? "priority-normal" : "priority-high",
        label: (task.priority ?? 0) > 0 ? "取消高优先级" : "设为高优先级",
      },
      {
        id: "audio-toggle",
        label: task.audio_only ? "取消仅音频" : "仅音频 (MP3)",
        enabled: optionEditable,
      },
      ...POSTPROCESSING_OPTIONS.map((option) => ({
        id: `pp:${option.value}`,
        label: option.label,
        enabled: optionEditable,
      })),
    );
  }
  if (status === "downloading") items.push({ id: "pause", label: "暂停" });
  if (status === "paused") items.push({ id: "resume", label: "继续" });
  if (status === "pending" || status === "downloading" || status === "paused") {
    items.push({ id: "cancel", label: "取消下载" });
  }
  if (status === "failed" || status === "cancelled") {
    items.push({ id: "retry", label: status === "failed" ? "重试" : "重新下载" });
  }
  if (status === "completed" && task.file_path) {
    items.push(
      { id: "open", label: "打开" },
      { id: "reveal", label: "在文件夹中显示" },
    );
  }
  if (status === "completed" || status === "failed" || status === "cancelled") {
    items.push({ id: "remove", label: "移除" });
  }
  return items;
}
```

Use the same dispatcher for the visible and native menus:

```ts
export async function dispatchTaskAction(
  actionId: string,
  task: TaskSnapshot,
  commands: TaskCommands,
  startRename: () => void,
): Promise<void> {
  switch (actionId) {
    case "rename":
      startRename();
      return;
    case "extract":
      return commands.recognizePage();
    case "priority-high":
      return commands.update({ priority: 1 });
    case "priority-normal":
      return commands.update({ priority: 0 });
    case "audio-toggle":
      return commands.update({ audio_only: !task.audio_only });
    case "pause":
      return commands.run("download.pause");
    case "resume":
      return commands.run("download.resume");
    case "cancel":
      return commands.run("download.cancel");
    case "retry":
      return commands.run("download.retry");
    case "remove":
      return commands.run("download.remove");
    case "open":
      return commands.open();
    case "reveal":
      return commands.reveal();
    default:
      if (actionId.startsWith("pp:")) {
        return commands.update({ postprocessing: actionId.slice(3) });
      }
      throw new Error(`Unknown task action: ${actionId}`);
  }
}
```

`TaskActionsMenu` renders these ids as `role="menuitem"` buttons. It adds `<Icon name="check" size={14} />` before the active postprocessing label. Its `IconButton` sets `aria-haspopup="menu"` and `aria-expanded={open}`. Coordinate open menus with a `downany:task-menu-open` `CustomEvent<string>` carrying `task.id`; listeners close when the event detail differs from their id. While open, attach document listeners that close on outside `pointerdown` or `Escape`; Escape restores focus to the trigger. Render the menu only while open and set `data-task-id={task.id}` on `role="menu"`.

```tsx
useEffect(() => {
  if (!open) return;
  const closeForOutsidePointer = (event: PointerEvent) => {
    if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
  };
  const closeForEscape = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    setOpen(false);
    triggerRef.current?.focus();
  };
  document.addEventListener("pointerdown", closeForOutsidePointer);
  document.addEventListener("keydown", closeForEscape);
  return () => {
    document.removeEventListener("pointerdown", closeForOutsidePointer);
    document.removeEventListener("keydown", closeForEscape);
  };
}, [open]);
```

- [ ] **Step 5: Implement the banner layers and direct action dispatch**

Use this public interface:

```tsx
export type ArtworkTone = "dark" | "medium" | "light";

export interface MediaTaskBannerProps {
  task: TaskSnapshot;
  density?: "normal" | "compact";
  artworkTone?: ArtworkTone;
}
```

The root remains an `li`, is not a large button, retains `id={`task-${task.id}`}`, and uses this complete layer order. `TaskActionsMenu` receives the same `startRename` callback used by the native context menu.

```tsx
<li
  id={`task-${task.id}`}
  className={`media-task-banner media-task-banner--${density} status-${view.status}`}
  data-artwork-tone={artworkTone}
  onContextMenu={(event) => {
    event.preventDefault();
    void window.api
      .showTaskContextMenu(buildTaskContextTemplate(task))
      .then((picked) => {
        if (picked) {
          void dispatchTaskAction(picked, task, commands, startRename);
        }
      });
  }}
>
  <div className="media-task-banner__artwork" aria-hidden>
    {task.thumbnail_url && !thumbnailBroken ? (
      <img
        src={task.thumbnail_url}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setThumbnailBroken(true)}
      />
    ) : (
      <div className="media-task-banner__artwork-placeholder">{initial}</div>
    )}
  </div>
  <div className="media-task-banner__shade" aria-hidden />
  <div className="media-task-banner__glass" aria-hidden />
  <div className="media-task-banner__content">
    {editing ? (
      <input
        ref={editRef}
        className="media-task-banner__title-input"
        aria-label="重命名任务"
        value={draftTitle}
        onChange={(event) => setDraftTitle(event.target.value)}
        onBlur={() => void submitRename()}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void submitRename();
          } else if (event.key === "Escape") {
            setDraftTitle(task.title);
            setEditing(false);
          }
        }}
      />
    ) : (
      <strong
        className="media-task-banner__title"
        title={`${task.title || task.url}（双击重命名）`}
        onDoubleClick={startRename}
      >
        {task.title || task.url}
      </strong>
    )}
    <div className="media-task-banner__meta">
      <span className={`media-task-banner__status tone-${view.tone}`}>
        <span className="media-task-banner__status-dot" aria-hidden />
        {view.label}
      </span>
      {view.meta.map((item) => (
        <span className="media-task-banner__meta-item" key={item}>
          <span className="media-task-banner__separator" aria-hidden>·</span>
          {item}
        </span>
      ))}
    </div>
    {view.detail ? (
      <div className="media-task-banner__detail" title={task.error_message || undefined}>
        {view.detail}
      </div>
    ) : null}
  </div>
  <div className="media-task-banner__actions">
    {view.primaryAction ? (
      <Button
        className="media-task-banner__primary-action"
        size="small"
        onClick={() => void runPrimaryAction(view.primaryAction!, commands)}
      >
        {view.primaryLabel}
      </Button>
    ) : null}
    <FailureRecoveryActions task={task} commands={commands} />
    <TaskActionsMenu task={task} commands={commands} onRename={startRename} />
  </div>
  {view.showProgress ? (
    <div
      className="media-task-banner__progress"
      role="progressbar"
      aria-label="下载进度"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={view.progress}
    >
      <span style={{ width: `${view.progress}%` }} />
    </div>
  ) : null}
</li>
```

Default `density` to `normal` and `artworkTone` to `medium`. The component supports all three approved tint variants, while production uses the deterministic medium fallback in this phase to avoid unreliable cross-origin canvas analysis. Preserve lazy thumbnail loading, referrer policy, broken-image fallback, double-click rename, Enter submit and Escape cancel.

Direct action dispatch must use this exhaustive switch; `null` renders no direct button:

```ts
function runPrimaryAction(
  action: Exclude<TaskPrimaryAction, null>,
  commands: TaskCommands,
): Promise<void> {
  switch (action) {
    case "pause":
      return commands.run("download.pause");
    case "resume":
      return commands.run("download.resume");
    case "open":
      return commands.open();
    case "retry":
      return commands.run("download.retry");
    default: {
      const exhaustive: never = action;
      return Promise.reject(new Error(`Unhandled task action: ${exhaustive}`));
    }
  }
}
```

Implement the local recovery component explicitly. These are normal compact buttons, not text hidden in the more menu.

```tsx
function FailureRecoveryActions({
  task,
  commands,
}: {
  task: TaskSnapshot;
  commands: TaskCommands;
}) {
  const pushToast = useAppStore((state) => state.pushToast);
  if (toTaskVisualState(task.status) !== "failed") return null;

  if (task.error_code === "need_login") {
    return (
      <>
        <Button
          className="media-task-banner__recovery-action"
          size="small"
          variant="ghost"
          leadingIcon="settings"
          aria-label="导入浏览器登录状态"
          title="导入浏览器登录状态"
          onClick={() => void commands.openSettings()}
        >
          <span className="media-task-banner__recovery-label">导入浏览器登录状态</span>
        </Button>
        <Button
          className="media-task-banner__recovery-action"
          size="small"
          variant="ghost"
          leadingIcon="capture"
          aria-label="网页识别"
          title="网页识别"
          onClick={() => void commands.recognizePage()}
        >
          <span className="media-task-banner__recovery-label">网页识别</span>
        </Button>
      </>
    );
  }

  return (
    <>
      {task.error_code === "geo_blocked" ? (
        <Button
          className="media-task-banner__recovery-action"
          size="small"
          variant="ghost"
          leadingIcon="settings"
          aria-label="检查代理"
          title="检查代理"
          onClick={() => {
            pushToast({
              kind: "info",
              title: "地区受限",
              detail: "请在设置中启用代理并填写代理地址后重试。",
            });
            void commands.openSettings();
          }}
        >
          <span className="media-task-banner__recovery-label">检查代理</span>
        </Button>
      ) : null}
      {task.error_code === "ytdlp_outdated" ? (
        <Button
          className="media-task-banner__recovery-action"
          size="small"
          variant="ghost"
          leadingIcon="settings"
          aria-label="打开设置"
          title="打开设置"
          onClick={() => void commands.openSettings()}
        >
          <span className="media-task-banner__recovery-label">打开设置</span>
        </Button>
      ) : null}
      <Button
        className="media-task-banner__recovery-action"
        size="small"
        variant="ghost"
        leadingIcon="capture"
        aria-label="网页识别"
        title="网页识别"
        onClick={() => void commands.recognizePage()}
      >
        <span className="media-task-banner__recovery-label">网页识别</span>
      </Button>
    </>
  );
}
```

- [ ] **Step 6: Add behavior regression tests**

Append these concrete cases to `MediaTaskBanner.test.tsx`:

```tsx
it("falls back after a broken thumbnail", () => {
  const { container } = render(
    <MediaTaskBanner
      task={taskFixture({ thumbnail_url: "https://example.com/broken.jpg" })}
    />,
  );
  const image = container.querySelector(".media-task-banner__artwork img");
  expect(image).not.toBeNull();
  fireEvent.error(image as HTMLImageElement);
  expect(container.querySelector(".media-task-banner__artwork img")).toBeNull();
  expect(
    container.querySelector(".media-task-banner__artwork-placeholder"),
  ).toHaveTextContent("Y");
});

it("offers the exact login-recovery actions", async () => {
  render(
    <MediaTaskBanner
      task={taskFixture({ status: "failed", error_code: "need_login" })}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await waitFor(() =>
    expect(requestMock).toHaveBeenCalledWith("download.retry", {
      taskId: "task-1",
    }),
  );

  fireEvent.click(
    screen.getByRole("button", { name: "导入浏览器登录状态" }),
  );
  expect(openSettingsMock).toHaveBeenCalledWith();

  fireEvent.click(screen.getByRole("button", { name: "网页识别" }));
  expect(openExtractWindowMock).toHaveBeenCalledWith(
    "https://example.com/video",
  );
});

it("renames on double click and submits the exact update payload", async () => {
  render(<MediaTaskBanner task={taskFixture()} />);
  fireEvent.doubleClick(screen.getByText("示例视频"));
  const input = screen.getByRole("textbox", { name: "重命名任务" });
  fireEvent.change(input, { target: { value: "新的标题" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() =>
    expect(requestMock).toHaveBeenCalledWith("download.updateTask", {
      taskId: "task-1",
      title: "新的标题",
    }),
  );
});

it("sends the exact pending template to the native context menu", () => {
  const { container } = render(<MediaTaskBanner task={taskFixture()} />);
  fireEvent.contextMenu(container.querySelector("#task-task-1") as HTMLElement);
  expect(showTaskContextMenuMock).toHaveBeenCalledWith([
    { id: "rename", label: "重命名" },
    { id: "extract", label: "网页识别" },
    { id: "separator-download", label: "", type: "separator" },
    { id: "priority-high", label: "设为高优先级" },
    { id: "audio-toggle", label: "仅音频 (MP3)", enabled: true },
    { id: "pp:none", label: "无后处理", enabled: true },
    { id: "pp:mp4", label: "转换为 MP4", enabled: true },
    { id: "pp:mp3", label: "提取音频 (MP3)", enabled: true },
    { id: "pp:script", label: "自定义脚本", enabled: true },
    { id: "cancel", label: "取消下载" },
  ]);
});

it("dispatches the action returned by the native context menu", async () => {
  showTaskContextMenuMock.mockResolvedValueOnce("cancel");
  const { container } = render(<MediaTaskBanner task={taskFixture()} />);
  fireEvent.contextMenu(container.querySelector("#task-task-1") as HTMLElement);
  await waitFor(() =>
    expect(requestMock).toHaveBeenCalledWith("download.cancel", {
      taskId: "task-1",
    }),
  );
});

it("reveals a completed file from the more menu", async () => {
  render(
    <MediaTaskBanner
      task={taskFixture({ status: "completed", file_path: "/tmp/video.mp4" })}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "在文件夹中显示" }));
  await waitFor(() =>
    expect(showItemInFolderMock).toHaveBeenCalledWith("/tmp/video.mp4"),
  );
});

it("does not invent a direct action for a pending task", () => {
  const { container } = render(<MediaTaskBanner task={taskFixture()} />);
  expect(
    container.querySelector(".media-task-banner__primary-action"),
  ).toBeNull();
});

it("keeps only one task menu open", () => {
  render(
    <ul>
      <MediaTaskBanner task={taskFixture({ id: "one" })} />
      <MediaTaskBanner task={taskFixture({ id: "two" })} />
    </ul>,
  );
  const triggers = screen.getAllByRole("button", { name: "更多操作" });
  fireEvent.click(triggers[0]);
  expect(screen.getAllByRole("menu")).toHaveLength(1);
  fireEvent.click(triggers[1]);
  expect(screen.getAllByRole("menu")).toHaveLength(1);
  expect(screen.getByRole("menu")).toHaveAttribute("data-task-id", "two");
});
```

- [ ] **Step 7: Verify the behavior-complete banner**

Run:

```bash
cd desktop
npm test -- renderer/components/task/taskPresentation.test.ts renderer/components/task/MediaTaskBanner.test.tsx
npm run build
```

Expected: PASS with all six states and unknown state covered.

- [ ] **Step 8: Commit the banner component**

```bash
git add desktop/renderer/components/task
git commit -m "feat(ui): add behavior-complete media task banner"
```

---

### Task 7: Integrate MediaTaskBanner and Reading Glass

**Files:**
- Create: `desktop/renderer/styles/media-task-banner.css`
- Create: `desktop/renderer/components/TaskList.test.tsx`
- Modify: `desktop/renderer/components/TaskList.tsx:1-117`
- Modify: `desktop/renderer/components/PlaylistGroupCard.tsx:1-260`
- Modify: `desktop/renderer/components/Shell.tsx:78-87`
- Modify: `desktop/renderer/styles.css:323-680`
- Delete: `desktop/renderer/components/DownloadCard.tsx`

**Interfaces:**
- Consumes: `MediaTaskBanner({ task, density })`.
- Produces: all standalone tasks at `normal`, playlist children at `compact`, one shared reading-glass implementation.

- [ ] **Step 1: Write failing integration tests**

```tsx
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useAppStore } from "../store/appStore";
import { taskFixture } from "../test/taskFixture";
import { TaskList } from "./TaskList";

afterEach(cleanup);

beforeEach(() => {
  useAppStore.setState({
    tasks: [],
    filter: "all",
    searchQuery: "",
    searchMode: "filter",
  });
});

describe("TaskList media density", () => {
  it("renders standalone tasks as normal media banners", () => {
    useAppStore.setState({
      tasks: [taskFixture({ id: "solo", group_id: undefined })],
    });
    const { container } = render(<TaskList />);
    expect(container.querySelector("#task-solo")).toHaveClass(
      "media-task-banner--normal",
    );
  });

  it("renders playlist children as compact media banners", () => {
    useAppStore.setState({
      tasks: [
        taskFixture({ id: "grouped", group_id: "g1", group_title: "合集" }),
      ],
    });
    const { container } = render(<TaskList />);
    expect(container.querySelector("#task-grouped")).toHaveClass(
      "media-task-banner--compact",
    );
  });
});
```

- [ ] **Step 2: Run and verify integration still renders DownloadCard**

Run:

```bash
cd desktop
npm test -- renderer/components/TaskList.test.tsx
```

Expected: FAIL because `TaskList` and `PlaylistGroupCard` still import `DownloadCard`.

- [ ] **Step 3: Replace both DownloadCard usages**

- `TaskList`: render `<MediaTaskBanner task={item.task} density="normal" />`.
- `PlaylistGroupCard`: render `<MediaTaskBanner task={task} density="compact" />`.
- `PlaylistGroupCard`: replace `▾ / ▸` with `<Icon name={expanded ? "chevron-down" : "chevron-right"} size={14} />`.
- `Shell`: change temporary highlight class from `card-flash` to `media-task-banner--flash`.
- Delete `DownloadCard.tsx` only after `rg -n "DownloadCard|download-card|card-thumb" desktop/renderer` returns no live component references.

- [ ] **Step 4: Implement exact Reading Glass CSS**

```css
.download-list,
.playlist-group-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  list-style: none;
  margin: 0;
  padding: 0;
}

.media-task-banner {
  position: relative;
  isolation: isolate;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  min-height: 108px;
  overflow: hidden;
  border: 1px solid var(--color-stroke-subtle);
  border-radius: var(--radius-banner);
  color: var(--color-text-on-media);
  contain: layout paint style;
  content-visibility: auto;
  contain-intrinsic-size: auto 108px;
}

.media-task-banner--compact {
  min-height: 96px;
  contain-intrinsic-size: auto 96px;
}

.media-task-banner__artwork,
.media-task-banner__artwork img,
.media-task-banner__shade {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.media-task-banner__artwork img {
  object-fit: cover;
}

.media-task-banner__artwork-placeholder {
  display: grid;
  width: 100%;
  height: 100%;
  place-items: center;
  background: linear-gradient(
    120deg,
    var(--material-media-placeholder-start),
    var(--material-media-placeholder-middle) 58%,
    var(--material-media-placeholder-end)
  );
  color: var(--color-text-on-media-tertiary);
  font-size: 28px;
  font-weight: 600;
}

.media-task-banner__shade {
  z-index: 1;
  background: var(--material-task-shade);
}

.media-task-banner[data-artwork-tone="dark"] {
  --task-glass-tint: var(--material-task-glass-tint-dark);
}

.media-task-banner[data-artwork-tone="medium"] {
  --task-glass-tint: var(--material-task-glass-tint-medium);
}

.media-task-banner[data-artwork-tone="light"] {
  --task-glass-tint: var(--material-task-glass-tint-light);
}

.media-task-banner__glass {
  position: absolute;
  z-index: 2;
  inset: 0 auto 0 0;
  width: var(--material-task-glass-width);
  background-color: var(--task-glass-tint, var(--material-task-glass-tint));
  background-image: linear-gradient(
    var(--material-task-glass-lift),
    var(--material-task-glass-lift)
  );
  backdrop-filter: blur(var(--material-task-glass-blur))
    saturate(var(--material-task-glass-saturate));
  -webkit-backdrop-filter: blur(var(--material-task-glass-blur))
    saturate(var(--material-task-glass-saturate));
  mask-image: linear-gradient(
    90deg,
    #000 0,
    #000 calc(100% - var(--material-task-glass-feather)),
    transparent 100%
  );
  -webkit-mask-image: linear-gradient(
    90deg,
    #000 0,
    #000 calc(100% - var(--material-task-glass-feather)),
    transparent 100%
  );
}

.media-task-banner__content {
  position: relative;
  z-index: 3;
  min-width: 0;
  padding: var(--space-4) 18px;
}

.media-task-banner__title {
  overflow: hidden;
  color: var(--color-text-on-media);
  font-size: 15px;
  font-weight: 600;
  line-height: 21px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.media-task-banner__title-input {
  width: min(560px, 100%);
  height: 28px;
  border: 1px solid var(--material-action-glass-stroke);
  border-radius: var(--radius-small);
  outline: 0;
  padding: 0 var(--space-2);
  background: var(--task-glass-tint, var(--material-task-glass-tint));
  color: var(--color-text-on-media);
}

.media-task-banner__meta {
  display: flex;
  gap: var(--space-2);
  align-items: center;
  margin-top: var(--space-2);
  color: var(--color-text-on-media-secondary);
  font-size: 12px;
  line-height: 18px;
  font-variant-numeric: tabular-nums;
}

.media-task-banner__status,
.media-task-banner__meta-item {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}

.media-task-banner__status-dot {
  width: 6px;
  height: 6px;
  flex: 0 0 6px;
  border-radius: 50%;
  background: currentColor;
}

.media-task-banner__status.tone-neutral { color: var(--color-text-on-media-secondary); }
.media-task-banner__status.tone-active { color: var(--color-accent); }
.media-task-banner__status.tone-warning { color: var(--color-warning); }
.media-task-banner__status.tone-success { color: var(--color-success); }
.media-task-banner__status.tone-danger { color: var(--color-danger); }

.media-task-banner__separator {
  color: var(--color-text-on-media-tertiary);
}

.media-task-banner__detail {
  overflow: hidden;
  margin-top: var(--space-1);
  color: var(--color-text-on-media-secondary);
  font-size: 12px;
  line-height: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.media-task-banner__actions {
  position: relative;
  z-index: 4;
  display: flex;
  gap: var(--space-2);
  align-items: center;
  padding-right: 18px;
}

.media-task-banner__actions .ui-button {
  border-color: var(--material-action-glass-stroke);
  background: var(--material-action-glass-fill);
  color: var(--color-text-on-media);
  backdrop-filter: blur(var(--material-action-glass-blur));
  -webkit-backdrop-filter: blur(var(--material-action-glass-blur));
  box-shadow: var(--material-action-glass-highlight);
}

.task-actions-menu {
  position: relative;
}

.task-actions-menu__popover {
  position: absolute;
  top: calc(100% + var(--space-2));
  right: 0;
  z-index: 20;
  display: grid;
  min-width: 190px;
  padding: var(--space-1);
  border: 1px solid var(--color-stroke-strong);
  border-radius: var(--radius-control);
  background: var(--color-surface-raised);
  box-shadow: var(--elevation-overlay);
}

.task-actions-menu__popover button {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 28px;
  border: 0;
  border-radius: var(--radius-small);
  padding: 0 var(--space-2);
  background: transparent;
  color: var(--color-text-primary);
  text-align: left;
}

.task-actions-menu__popover button:hover:not(:disabled) {
  background: var(--color-surface-control-hover);
}

.task-actions-menu__popover button:disabled {
  color: var(--color-text-tertiary);
}

.media-task-banner__progress {
  position: absolute;
  z-index: 5;
  right: 0;
  bottom: 0;
  left: 0;
  height: 2px;
  background: var(--material-task-progress-track);
}

.media-task-banner__progress > span {
  display: block;
  height: 100%;
  background: var(--color-accent);
  transition: width var(--motion-normal) var(--ease-standard);
}

.media-task-banner--flash {
  animation: media-task-flash 1.8s var(--ease-standard);
}

@keyframes media-task-flash {
  0%, 60% { border-color: var(--color-accent); }
  100% { border-color: var(--color-stroke-subtle); }
}

@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .media-task-banner__glass {
    background-color: var(--material-task-glass-fallback);
    background-image: none;
  }
}

html[data-reduce-transparency="true"] .media-task-banner__glass,
html[data-reduce-transparency="true"] .media-task-banner__actions .ui-button {
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}

html[data-reduce-transparency="true"] .media-task-banner__glass {
  background-color: var(--material-task-glass-fallback);
  background-image: none;
}

@media (prefers-reduced-transparency: reduce) {
  .media-task-banner__glass,
  .media-task-banner__actions .ui-button {
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }

  .media-task-banner__glass {
    background-color: var(--material-task-glass-fallback);
    background-image: none;
  }
}

@media (max-width: 900px) {
  .media-task-banner__glass {
    width: 68%;
  }

  .media-task-banner__recovery-action {
    width: var(--control-height-small);
    padding: 0;
  }

  .media-task-banner__recovery-label {
    display: none;
  }
}
```

Status dots use the semantic success/warning/danger/accent colors plus visible labels. Do not create state-colored card fills.

- [ ] **Step 5: Update playlist selectors and remove dead card CSS**

- Replace `.playlist-group-list .download-card` with `.playlist-group-list .media-task-banner`.
- Remove `.download-card`, `.card-thumb`, `.card-main`, `.card-title`, `.card-subtitle`, `.card-meta`, `.card-actions`, `.card-badges`, `.badge`, `.card-menu` and `.progress-bar` rules after their consumers migrate.
- Keep playlist group container styles in `styles.css`; only task-child presentation moves.

- [ ] **Step 6: Verify integration, dead-code removal and build**

Run:

```bash
cd desktop
npm test -- renderer/components/TaskList.test.tsx renderer/components/task/MediaTaskBanner.test.tsx renderer/components/task/taskPresentation.test.ts
npm run build
rg -n "DownloadCard|download-card|card-thumb|card-flash" renderer
```

Expected: tests/build PASS; `rg` returns no matches.

- [ ] **Step 7: Commit the product integration**

```bash
git add desktop/renderer/components/TaskList.tsx desktop/renderer/components/TaskList.test.tsx desktop/renderer/components/PlaylistGroupCard.tsx desktop/renderer/components/Shell.tsx desktop/renderer/components/DownloadCard.tsx desktop/renderer/styles/media-task-banner.css desktop/renderer/styles.css
git commit -m "feat(ui): adopt media task banners"
```

---

### Task 8: Reduce the Main Empty State to One Action

**Files:**
- Create: `desktop/renderer/components/EmptyState.test.tsx`
- Modify: `desktop/renderer/components/EmptyState.tsx:1-51`
- Modify: `desktop/renderer/components/TaskList.tsx:1-100`
- Modify: `desktop/renderer/i18n.ts:19-47`
- Modify: `desktop/renderer/styles.css:706-785`

**Interfaces:**
- Consumes: `Icon`, `Button`, `useAppStore.requestAddFocus`.
- Produces: deterministic empty state with one primary action and no persistence branch.

- [ ] **Step 1: Write the failing empty-state test**

```tsx
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useAppStore } from "../store/appStore";
import { EmptyState } from "./EmptyState";

afterEach(cleanup);

beforeEach(() => {
  localStorage.clear();
  useAppStore.setState({ addFocusSignal: 0 });
});

describe("EmptyState", () => {
  it("offers one primary action that focuses link intake", () => {
    render(<EmptyState />);
    expect(screen.getAllByRole("button")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "粘贴视频链接" }));
    expect(useAppStore.getState().addFocusSignal).toBe(1);
    expect(document.querySelector('[data-icon="download"]')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run and verify the current two-action state fails**

Run:

```bash
cd desktop
npm test -- renderer/components/EmptyState.test.tsx
```

Expected: FAIL because current EmptyState has two buttons and a font symbol.

- [ ] **Step 3: Implement the single-action empty state**

Render:

```tsx
export function EmptyState() {
  const requestAddFocus = useAppStore((state) => state.requestAddFocus);
  const [locale, setLocaleState] = useState<Locale>(() => getLocale());

  useEffect(() => {
    const updateLocale = () => setLocaleState(getLocale());
    window.addEventListener("downany:locale", updateLocale);
    return () => window.removeEventListener("downany:locale", updateLocale);
  }, []);

  return (
    <div className="empty-state">
      <Icon name="download" size={32} />
      <h2 className="empty-state-title">{t("empty.title", locale)}</h2>
      <p className="empty-state-copy">{t("empty.copy", locale)}</p>
      <Button variant="primary" leadingIcon="link" onClick={requestAddFocus}>
        {t("empty.action", locale)}
      </Button>
    </div>
  );
}
```

Add exact dictionary entries:

```ts
// zhCN
"empty.title": "添加第一个下载任务",
"empty.copy": "粘贴视频链接，或从浏览器扩展发送当前页面。",
"empty.action": "粘贴视频链接",

// en
"empty.title": "Add your first download",
"empty.copy": "Paste a video URL, or send the current page from the browser extension.",
"empty.action": "Paste video URL",
```

Remove `isOnboardingDismissed`, its localStorage writes, the obsolete onboarding keys, and the `drop-hint` branch in `TaskList`. Keep locale updates and drag-and-drop behavior in `Shell` unchanged.

- [ ] **Step 4: Apply compact empty-state styles**

Use a maximum copy width of `360px`, `32px` icon, `18/24px` title, no illustration, and no second action. Remove `.drop-hint*`, `.empty-state-steps` and `.empty-state-actions` rules.

- [ ] **Step 5: Verify empty state and queue tests**

Run:

```bash
cd desktop
npm test -- renderer/components/EmptyState.test.tsx renderer/components/TaskList.test.tsx
npm run build
```

Expected: PASS.

- [ ] **Step 6: Commit the empty-state milestone**

```bash
git add desktop/renderer/components/EmptyState.tsx desktop/renderer/components/EmptyState.test.tsx desktop/renderer/components/TaskList.tsx desktop/renderer/i18n.ts desktop/renderer/styles.css
git commit -m "feat(ui): simplify the desktop empty state"
```

---

### Task 9: Add a Deterministic Visual Inspection Gallery

**Files:**
- Create: `desktop/renderer/design-system.html`
- Create: `desktop/renderer/design-system-main.tsx`
- Create: `desktop/renderer/styles/design-system-gallery.css`
- Create: `desktop/renderer/components/design-system/DesktopCoreGallery.tsx`
- Create: `desktop/renderer/components/design-system/DesktopCoreGallery.test.tsx`
- Modify: `desktop/vite.config.ts:35-75`

**Interfaces:**
- Consumes: real `WindowChrome`, `ActionBar`, `FilterBar`, `MediaTaskBanner`, semantic Token and `taskFixture` shape.
- Produces: development-only `/design-system.html` with six task states, three artwork tones, normal/compact density, dark/light and reduced-transparency toggles.

- [ ] **Step 1: Write the failing gallery coverage test**

```tsx
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DesktopCoreGallery,
  installGalleryApiMock,
} from "./DesktopCoreGallery";

afterEach(cleanup);
beforeEach(installGalleryApiMock);

describe("DesktopCoreGallery", () => {
  it("renders all canonical task states", () => {
    const { container } = render(<DesktopCoreGallery />);
    for (const label of ["等待中", "下载中", "已暂停", "已完成", "下载失败", "已取消"])
      expect(screen.getByText(label)).toBeInTheDocument();
    expect(container.querySelectorAll(".media-task-banner")).toHaveLength(6);
    for (const tone of ["dark", "medium", "light"])
      expect(
        container.querySelector(`[data-artwork-tone="${tone}"]`),
      ).not.toBeNull();
  });

  it("provides deterministic theme and transparency controls", () => {
    render(<DesktopCoreGallery />);
    fireEvent.click(screen.getByRole("button", { name: "浅色" }));
    expect(document.documentElement.dataset.theme).toBe("light");
    fireEvent.click(screen.getByRole("button", { name: "减少透明" }));
    expect(document.documentElement.dataset.reduceTransparency).toBe("true");
  });
});
```

- [ ] **Step 2: Run and verify the gallery module fails**

Run:

```bash
cd desktop
npm test -- renderer/components/design-system/DesktopCoreGallery.test.tsx
```

Expected: FAIL because the gallery does not exist.

- [ ] **Step 3: Implement six deterministic gallery tasks**

Implement `DesktopCoreGallery.tsx` with local data rather than importing a test fixture:

```tsx
import { useEffect, useState } from "react";

import type { DesktopApi } from "../../../electron/preload";
import type { TaskSnapshot } from "../../lib/types";
import { useAppStore } from "../../store/appStore";
import { ActionBar } from "../shell/ActionBar";
import { FilterBar } from "../shell/FilterBar";
import { WindowChrome } from "../shell/WindowChrome";
import {
  MediaTaskBanner,
  type ArtworkTone,
} from "../task/MediaTaskBanner";

const ARTWORK_COLORS: Record<ArtworkTone, [string, string, string]> = {
  dark: ["#11151b", "#242c36", "#090b0e"],
  medium: ["#314050", "#8c765b", "#1d242c"],
  light: ["#d7d0c1", "#8797a3", "#4d5660"],
};

function galleryArtwork(title: string, tone: ArtworkTone): string {
  const [start, middle, end] = ARTWORK_COLORS[tone];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="240" viewBox="0 0 1200 240">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${start}"/>
      <stop offset="0.55" stop-color="${middle}"/>
      <stop offset="1" stop-color="${end}"/>
    </linearGradient></defs>
    <rect width="1200" height="240" fill="url(#g)"/>
    <circle cx="930" cy="70" r="130" fill="rgba(255,255,255,.12)"/>
    <path d="M0 190 C220 120 390 230 610 160 S940 110 1200 170 V240 H0Z" fill="rgba(0,0,0,.24)"/>
    <text x="880" y="208" fill="rgba(255,255,255,.72)" font-size="28" font-family="sans-serif">${title}</text>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function galleryTask(
  status: TaskSnapshot["status"],
  tone: ArtworkTone,
  progress: number,
  overrides: Partial<TaskSnapshot> = {},
): TaskSnapshot {
  return {
    id: status,
    url: `https://example.com/${status}`,
    title: `Downany ${status} 状态示例`,
    platform: "youtube",
    thumbnail_url: galleryArtwork(status, tone),
    status,
    progress,
    downloaded_bytes: Math.round(128_600_000 * progress / 100),
    total_bytes: 128_600_000,
    speed: "8.4 MB/s",
    eta: "00:18",
    file_path: "",
    error_message: "",
    created_at: "2026-08-16T10:00:00Z",
    started_at: "2026-08-16T10:01:00Z",
    completed_at: null,
    quality: "1080p",
    format_id: null,
    audio_only: false,
    postprocessing: "none",
    priority: 0,
    queue_order: 0,
    ...overrides,
  };
}

export const GALLERY_TASKS: TaskSnapshot[] = [
  galleryTask("pending", "dark", 0),
  galleryTask("downloading", "medium", 58),
  galleryTask("paused", "light", 42),
  galleryTask("completed", "medium", 100, {
    downloaded_bytes: 128_600_000,
    file_path: "/gallery/completed.mp4",
    completed_at: "2026-08-16T11:32:00Z",
  }),
  galleryTask("failed", "dark", 31, {
    error_code: "need_login",
    error_message: "Sign in to confirm your age",
  }),
  galleryTask("cancelled", "light", 0),
];

const GALLERY_TONES: Record<string, ArtworkTone> = {
  pending: "dark",
  downloading: "medium",
  paused: "light",
  completed: "medium",
  failed: "dark",
  cancelled: "light",
};

export function installGalleryApiMock(): void {
  const mock = {
    platform: "darwin",
    request: async (method: string) => {
      if (method === "search.query") return { searchId: "gallery-search" };
      if (method === "download.createTasks") return { taskIds: [] };
      if (method === "app.getSnapshot") {
        return { tasks: GALLERY_TASKS, settings: null };
      }
      return {};
    },
    openPath: async (target: string) => target,
    showItemInFolder: async () => undefined,
    openSettings: async () => undefined,
    openExtractWindow: async () => undefined,
    showTaskContextMenu: async () => null,
  } satisfies Partial<DesktopApi>;

  Object.defineProperty(window, "api", {
    configurable: true,
    writable: true,
    value: mock as DesktopApi,
  });
}

export function DesktopCoreGallery() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [reduceTransparency, setReduceTransparency] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth);

  useEffect(() => {
    useAppStore.setState({
      connection: "connected",
      filter: "all",
      searchMode: "filter",
      searchQuery: "",
      tasks: GALLERY_TASKS,
      settings: null,
      toasts: [],
    });
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    document.documentElement.dataset.reduceTransparency = String(
      reduceTransparency,
    );
  }, [reduceTransparency]);

  useEffect(() => {
    const updateWidth = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", updateWidth);
    return () => window.removeEventListener("resize", updateWidth);
  }, []);

  return (
    <div className="design-system-gallery">
      <aside className="design-system-gallery__controls" aria-label="视觉检查控制">
        <span>{viewportWidth}px</span>
        <button
          type="button"
          aria-pressed={theme === "dark"}
          onClick={() => setTheme("dark")}
        >
          深色
        </button>
        <button
          type="button"
          aria-pressed={theme === "light"}
          onClick={() => setTheme("light")}
        >
          浅色
        </button>
        <button
          type="button"
          aria-pressed={reduceTransparency}
          onClick={() => setReduceTransparency((value) => !value)}
        >
          减少透明
        </button>
      </aside>

      <div className="window-shell design-system-gallery__window" data-platform="darwin">
        <WindowChrome platform="darwin" />
        <ActionBar />
        <FilterBar />
        <main className="window-main design-system-gallery__main">
          <section aria-labelledby="normal-density-title">
            <h2 id="normal-density-title">标准密度</h2>
            <ul className="download-list">
              {GALLERY_TASKS.slice(0, 3).map((task) => (
                <MediaTaskBanner
                  key={task.id}
                  task={task}
                  density="normal"
                  artworkTone={GALLERY_TONES[task.id]}
                />
              ))}
            </ul>
          </section>
          <section aria-labelledby="compact-density-title">
            <h2 id="compact-density-title">紧凑密度</h2>
            <ul className="download-list">
              {GALLERY_TASKS.slice(3).map((task) => (
                <MediaTaskBanner
                  key={task.id}
                  task={task}
                  density="compact"
                  artworkTone={GALLERY_TONES[task.id]}
                />
              ))}
            </ul>
          </section>
        </main>
      </div>
    </div>
  );
}
```

Create `design-system-main.tsx` and `design-system.html`:

```tsx
// desktop/renderer/design-system-main.tsx
import { createRoot } from "react-dom/client";

import {
  DesktopCoreGallery,
  installGalleryApiMock,
} from "./components/design-system/DesktopCoreGallery";
import "./styles.css";
import "./styles/design-system-gallery.css";

installGalleryApiMock();
const root = document.getElementById("root");
if (root) createRoot(root).render(<DesktopCoreGallery />);
```

```html
<!-- desktop/renderer/design-system.html -->
<!doctype html>
<html lang="zh-CN" data-theme="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Downany Desktop Core Gallery</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/design-system-main.tsx"></script>
  </body>
</html>
```

Add deterministic gallery-only layout in `design-system-gallery.css`:

```css
html,
body,
#root,
.design-system-gallery {
  min-height: 100%;
}

.design-system-gallery {
  min-width: 760px;
  background: var(--color-surface-window);
}

.design-system-gallery__controls {
  position: fixed;
  right: 12px;
  bottom: 12px;
  z-index: 100;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1);
  border: 1px solid var(--color-stroke-strong);
  border-radius: var(--radius-control);
  background: var(--color-surface-raised);
  box-shadow: var(--elevation-overlay);
}

.design-system-gallery__controls span,
.design-system-gallery__controls button {
  min-height: 28px;
  border: 0;
  border-radius: var(--radius-small);
  padding: 0 var(--space-2);
  background: transparent;
  color: var(--color-text-secondary);
}

.design-system-gallery__controls button[aria-pressed="true"] {
  background: var(--color-accent-soft);
  color: var(--color-accent);
}

.design-system-gallery__window {
  width: 100%;
  min-height: 100vh;
}

.design-system-gallery__main {
  display: grid;
  align-content: start;
  gap: var(--space-4);
}

.design-system-gallery__main h2 {
  margin: 0 0 var(--space-2);
  color: var(--color-text-secondary);
  font-size: 12px;
  font-weight: 500;
  line-height: 18px;
}
```

- [ ] **Step 4: Expose the gallery only in development mode**

Convert `defineConfig` to callback form and add the input only when `mode === "development"`:

```ts
export default defineConfig(({ mode }) => ({
  root: path.resolve(__dirname, "renderer"),
  server: {
    fs: {
      allow: [path.resolve(__dirname, "..")],
    },
  },
  plugins: [
    react(),
    electron({
      main: {
        entry: path.resolve(__dirname, "electron/main.ts"),
        vite: {
          build: {
            outDir: path.resolve(__dirname, "dist-electron"),
            rollupOptions: { external: ["electron"] },
          },
          plugins: [buildExtractAssets()],
        },
      },
      preload: {
        input: path.resolve(__dirname, "electron/preload.ts"),
        vite: {
          build: { outDir: path.resolve(__dirname, "dist-electron") },
        },
      },
      renderer: {},
    }),
  ],
  build: {
    outDir: path.resolve(__dirname, "dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "renderer/index.html"),
        settings: path.resolve(__dirname, "renderer/settings.html"),
        ...(mode === "development"
          ? { designSystem: path.resolve(__dirname, "renderer/design-system.html") }
          : {}),
      },
    },
  },
}));
```

Production `npm run build` must not emit `design-system.html`.

- [ ] **Step 5: Verify gallery test and production exclusion**

Run:

```bash
cd desktop
npm test -- renderer/components/design-system/DesktopCoreGallery.test.tsx
npm run build
test ! -e dist/design-system.html
```

Expected: PASS and no production gallery artifact.

- [ ] **Step 6: Commit the visual harness**

```bash
git add desktop/renderer/design-system.html desktop/renderer/design-system-main.tsx desktop/renderer/components/design-system desktop/renderer/styles/design-system-gallery.css desktop/vite.config.ts
git commit -m "test(ui): add deterministic desktop visual gallery"
```

---

### Task 10: Run Visual, Regression and Documentation Gates

**Files:**
- Modify: `docs/DESIGN-SYSTEM.md:1-8,757-784`
- Modify: `docs/UI-DESIGN-LANGUAGE.md:1-8,481-494`

**Interfaces:**
- Consumes: all prior task outputs and approved visual baseline `docs/assets/downany-main-window-glass-v1.png`.
- Produces: evidence-backed Phase 1 status; no unchecked item is marked complete.

- [ ] **Step 1: Run all new and existing Renderer tests**

Run:

```bash
cd desktop
npm test -- renderer/styles/tokenContract.test.ts renderer/components/ui/uiPrimitives.test.tsx renderer/components/shell/WindowChrome.test.tsx renderer/components/shell/ActionBar.test.tsx renderer/components/shell/FilterBar.test.tsx renderer/components/task/taskPresentation.test.ts renderer/components/task/MediaTaskBanner.test.tsx renderer/components/TaskList.test.tsx renderer/components/EmptyState.test.tsx renderer/components/design-system/DesktopCoreGallery.test.tsx renderer/components/NetSearchPanel.test.tsx renderer/store/appStore.test.ts
```

Expected: all listed Renderer tests PASS.

- [ ] **Step 2: Run build and static checks**

Run:

```bash
cd desktop
npm run build
cd ..
git diff --check
rg -n "⚙|⇩|⋯|✓|▾|▸|▶|×" desktop/renderer --glob '!design-system-main.tsx'
rg -n "DownloadCard|download-card|card-thumb|card-flash|topbar|segment active" desktop/renderer
```

Expected:

- build and `git diff --check` PASS;
- both `rg` commands return no production UI matches;
- production build contains no `design-system.html`.

- [ ] **Step 3: Run the full desktop suite and compare against baseline**

Run:

```bash
cd desktop
npm test
```

Expected:

- no new Renderer or window chrome failures;
- if Telegram path tests remain red with the same baseline signatures, record them separately;
- any new failure introduced by this branch blocks completion.

- [ ] **Step 4: Inspect the deterministic gallery in a real browser**

Run:

```bash
cd desktop
npm run dev -- --host 127.0.0.1
```

Open `http://127.0.0.1:5173/design-system.html` with the Codex browser. Capture and inspect these viewports in both themes:

- `1120 × 760`
- `900 × 650`
- `760 × 560`

Verify:

- title layer contains no business actions;
- action and filter layers remain visually distinct;
- active filter uses only text plus a `2px` indicator;
- controls remain `28–32px` and do not become oversized;
- glass is visibly strong only on the left reading region;
- image center/right remains sharp;
- glass edge feathers without a hard rectangle;
- completed state has a small green marker and no green long line;
- loading and paused tasks keep a `2px` blue progress line;
- no horizontal overflow at `760 × 560`;
- light theme keeps media text on dark reading glass;
- reduced transparency remains readable.

- [ ] **Step 5: Inspect the actual Electron window**

With the same development process running, inspect the Electron main window on macOS. Verify traffic-light clearance, draggable title strip, link intake, search popover, context menu, direct task actions and persisted window geometry. Windows frame verification remains unapproved until run on a Windows machine and must stay unchecked in documentation.

- [ ] **Step 6: Present screenshots for user visual approval**

Show the dark `1120 × 760` and compact `760 × 560` gallery screenshots to the user. Do not mark the visual checklist complete until the user explicitly approves. If rejected, change only the relevant Token/CSS/component task, rerun Steps 1–5, and present new screenshots.

- [ ] **Step 7: Update documentation with only verified facts**

After approval:

- change Desktop Profile status to `桌面核心阶段已实现；设置、历史、抓取窗口与跨载体迁移待后续阶段`;
- mark title/action/filter separation, media banner, reading glass, completed marker, active filter and checked viewport sizes complete only when evidence exists;
- leave Windows, extension, settings/history and full-system completion claims incomplete;
- update `DESIGN-SYSTEM.md` status to `Phase 1 桌面核心已实现；全产品工程迁移进行中`.

- [ ] **Step 8: Commit validation documentation**

Before committing, inspect `git status --short`, `git diff --cached --stat`, `git diff --cached`, and `git log --oneline -10`.

```bash
git add docs/DESIGN-SYSTEM.md docs/UI-DESIGN-LANGUAGE.md
git commit -m "docs: record desktop design system phase one"
```

- [ ] **Step 9: Final clean-tree report**

Run:

```bash
git status --short --branch
git log --oneline -10
```

Expected: clean worktree on the implementation branch, local commits present, no push performed.
