# Downany Official Website Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在仓库内交付一个可本地运行、响应式、按 GitHub Release 事实降级的 Downany · 百纳单页官网，忠实实现已确认的“深色媒体舞台”方案。

**Architecture:** 在 `website/` 建立独立 React + TypeScript + Vite 包；保留 Product Design 模板的 Sites-ready 构建文件。页面由分区组件组合，可见文案集中在 `siteContent.ts`，Release 资产匹配保持为纯函数，请求与取消封装在 Hook 中。网站只读 GitHub Releases，不接入后端、账号、分析或持久化。

**Tech Stack:** React 18、TypeScript、Vite、Vitest、Testing Library、Phosphor Icons、CSS Custom Properties、GitHub Releases REST API。

## Global Constraints

- 视觉与文案以 `docs/superpowers/specs/2026-08-17-downany-official-website-design.md` 为唯一实现规格。
- 使用 Product Design `prototype` 模板初始化；保留 `.openai/hosting.json`、`worker/index.js`、`scripts/prepare-sites-build.mjs` 与 `tests/sites-worker.test.mjs`。
- 先写失败测试、确认失败原因，再写最小实现；每个行为变化都遵循 RED → GREEN → REFACTOR。
- 只使用真实品牌、产品预览和专门生成的媒体资产；概念总览图不得进入生产包。
- 页面全局只允许 `RecognitionSpotlight` 使用一次 Reading Glass。
- Windows Release 资产缺失时必须显示 `Windows 版准备中`；不得伪造可下载链接。
- 不部署、不推送远端、不修改 Electron、Sidecar、扩展或 Telegram 行为。

---

### Task 1: 初始化 Sites-ready TypeScript 前端包

**Files:**

- Create: `website/`（由 Product Design 模板初始化）
- Modify: `website/package.json`
- Modify: `website/vite.config.mjs`
- Create: `website/tsconfig.json`
- Create: `website/src/vite-env.d.ts`
- Rename: `website/src/main.jsx` → `website/src/main.tsx`
- Rename: `website/src/App.jsx` → `website/src/App.tsx`
- Create: `website/src/test/setup.ts`

- [x] 运行模板初始化：

  ```bash
  node /Users/jacklee/.codex/plugins/cache/openai-curated-remote/product-design/0.1.52/scripts/bootstrap-prototype.mjs \
    --dest /Users/jacklee/work/personal/trae/downloader/website
  ```

  Expected: 输出 `status: created`，且 `website/` 中存在模板的 Sites-ready 文件。

- [x] 将模板转换为 TypeScript，增加 `test`、`test:watch` 与 `typecheck` 脚本；加入 Vitest、Testing Library、TypeScript、jsdom 与 `@phosphor-icons/react`，但保持 Sites 构建脚本不变。

- [x] 安装依赖：

  ```bash
  cd website && npm install --prefer-offline --no-audit --no-fund
  ```

  Expected: `package-lock.json` 更新，安装完成且无依赖解析错误。

- [x] 验证空壳工程：

  ```bash
  cd website && npm run typecheck && npm run build && npm run test:sites
  ```

  Expected: 三条命令成功；`dist/client/index.html`、`dist/server/index.js` 与 `dist/.openai/hosting.json` 存在。

### Task 2: TDD 实现 Release 资产解析与平台排序

**Files:**

- Create: `website/src/lib/releases.test.ts`
- Create: `website/src/lib/releases.ts`
- Create: `website/src/lib/platform.test.ts`
- Create: `website/src/lib/platform.ts`

- [x] 先为 `resolveReleaseAssets` 写测试，覆盖 macOS DMG、Windows EXE、Chrome 扩展、缺失 Windows、空 Release 与 Releases 页面回退。

- [x] 运行测试确认 RED：

  ```bash
  cd website && npm test -- --run src/lib/releases.test.ts
  ```

  Expected: 因模块或导出尚不存在而失败，失败信息只指向 Release 解析能力。

- [x] 实现 `GithubRelease`、`DownloadLinks` 和 `resolveReleaseAssets(release, fallbackUrl)`；资产匹配必须大小写不敏感，并返回原始 `browser_download_url`。

- [x] 运行测试确认 GREEN：

  ```bash
  cd website && npm test -- --run src/lib/releases.test.ts
  ```

  Expected: Release 解析测试全部通过。

- [x] 先为 `detectPlatform` 与 `orderPlatforms` 写测试，覆盖 `userAgentData.platform`、传统 `userAgent`、macOS、Windows 与其他平台；确认 RED 后实现最小纯函数并确认 GREEN。

### Task 3: TDD 实现最新 Release 请求状态

**Files:**

- Create: `website/src/hooks/useLatestRelease.test.tsx`
- Create: `website/src/hooks/useLatestRelease.ts`

- [x] 写 Hook 测试，覆盖初始 `loading`、成功 `ready`、HTTP 非 2xx 的 `error`、JSON/网络失败和卸载时取消请求。

- [x] 运行测试确认 RED：

  ```bash
  cd website && npm test -- --run src/hooks/useLatestRelease.test.tsx
  ```

  Expected: 因 Hook 尚不存在而失败。

- [x] 实现 `useLatestRelease(fetcher = globalThis.fetch)`，请求 `https://api.github.com/repos/JackEngineer/downany/releases/latest`，使用 `AbortController` 并将异常稳定映射为 `error`。

- [x] 再次运行同一测试，确认 GREEN；重构时不改变状态联合类型 `loading | ready | error`。

### Task 4: TDD 实现内容合同、下载状态与核心交互

**Files:**

- Create: `website/src/content/siteContent.ts`
- Create: `website/src/components/Hero.tsx`
- Create: `website/src/components/DownloadPanel.tsx`
- Create: `website/src/components/Faq.tsx`
- Create: `website/src/components/SiteHeader.tsx`
- Create: `website/src/components/core-interactions.test.tsx`
- Create: `website/src/App.test.tsx`

- [x] 写失败测试，验证首屏允许文案、无虚假统计/eyebrow、Release 各状态下的按钮文案和链接、Windows 缺失时的准备中状态。

- [x] 写失败测试，验证 FAQ 一次只展开一项、再次点击关闭、`aria-expanded` 正确。

- [x] 写失败测试，验证移动菜单可打开、Escape 关闭、点击导航后关闭、关闭后焦点返回菜单按钮。

- [x] 实现 `siteContent.ts` 和最小组件逻辑，使上述测试逐个变绿；禁止在组件中复制大段文案。

- [x] 运行聚焦测试：

  ```bash
  cd website && npm test -- --run src/components/core-interactions.test.tsx src/App.test.tsx
  ```

  Expected: 所有内容合同、下载状态、FAQ 和移动菜单测试通过。

### Task 5: 实现全部页面分区与真实资源

**Files:**

- Create: `website/src/components/ProductPreview.tsx`
- Create: `website/src/components/Workflow.tsx`
- Create: `website/src/components/RecognitionSpotlight.tsx`
- Create: `website/src/components/CapabilityList.tsx`
- Create: `website/src/components/SiteFooter.tsx`
- Modify: `website/src/App.tsx`
- Create: `website/public/assets/logo-mark.svg`
- Create: `website/public/assets/downany-app-preview.png`
- Create: `website/public/assets/recognition-media.png`
- Modify: `website/index.html`

- [x] 将仓库品牌标志与已确认产品预览复制为独立生产资源；使用内置图片生成能力制作与视觉方案一致、无文字和 UI 的网页识别媒体图，并逐张目视检查。

- [x] 实现 `SiteHeader → Hero → Workflow → RecognitionSpotlight → CapabilityList → DownloadPanel → Faq → SiteFooter` 的固定结构；每个分区只承担一个职责。

- [x] 用 Phosphor `regular` 图标实现流程、能力和平台语义；品牌标志继续使用仓库 SVG。

- [x] 补充标题、description、Open Graph、favicon 与稳定的图片尺寸；首屏产品图预加载，非首屏媒体懒加载。

- [x] 运行：

  ```bash
  cd website && npm test -- --run && npm run typecheck
  ```

  Expected: 全部组件、数据和内容测试通过，TypeScript 无错误。

### Task 6: 实现深色媒体舞台视觉与响应式

**Files:**

- Create: `website/src/styles/tokens.css`
- Create: `website/src/styles/foundations.css`
- Create: `website/src/styles/site.css`
- Modify: `website/src/main.tsx`

- [x] 将规格中的颜色、排版、间距、圆角与焦点样式建立为语义 Token；组件样式只引用 Token。

- [x] 完成桌面 `1440 × 900`、平板与移动 `390 × 844` 布局；桌面首屏采用 `36% / 64%`，移动端采用纵向 CTA 和时间线。

- [x] 仅在 `RecognitionSpotlight` 实现一次 Reading Glass；加入 `backdrop-filter` 不支持、`prefers-reduced-motion` 与 `prefers-reduced-transparency` 的实色降级。

- [x] 检查所有交互目标至少 `44 × 44px`、焦点环可见、页面无横向滚动；普通表面不使用投影，产品窗口只保留轻微抬升阴影。

### Task 7: 自动化验证与生产构建

**Files:**

- Modify: 仅针对验证发现的问题修改 `website/src/**`

- [x] 运行完整验证：

  ```bash
  cd website && npm test -- --run && npm run typecheck && npm run build && npm run test:sites
  ```

  Expected: 全部命令退出码为 0，Sites-ready 三个产物存在。

- [x] 检查生产包不含概念总览图或开发占位词：

  ```bash
  rg -n "downany-website-concept|TODO|TBD|placeholder" website/dist/client website/src
  ```

  Expected: 无匹配；若有匹配，必须修正后重新构建。

- [x] 运行 `git diff --check`，确认无空白错误，并检查未暂存内容不含密钥、私有配置或无关产物。

### Task 8: 内置浏览器与 Design QA

**Files:**

- Create: `website/design-qa.md`
- Create: `website/qa/implementation-desktop.png`
- Create: `website/qa/implementation-mobile.png`
- Create: `website/qa/comparison-desktop.png`
- Create: `website/qa/comparison-mobile.png`
- Modify: 仅针对视觉验收发现的问题修改 `website/src/**`

- [x] 启动本地预览，使用 Codex 内置 Browser 的 IAB 实例打开网站；不得静默切换为外部 Chrome。

- [x] 在 `1440 × 900` 验证导航、两个平台 CTA、Release 降级、FAQ、外链、控制台和横向溢出，并保存桌面截图。

- [x] 在 `390 × 844` 验证移动菜单、Escape、CTA、时间线、Reading Glass、FAQ 和横向溢出，并保存移动截图。

- [x] 将参考图与同尺寸实现截图合成到同一比较输入；至少记录首屏、三步流程、网页识别、能力/下载/FAQ、移动端五项视觉差异，修正后重新比较。

- [x] 在 `website/design-qa.md` 记录来源、浏览器、视口、交互、可见偏差与修正，最后一行必须是：

  ```text
  final result: passed
  ```

- [x] 再运行一次完整测试、类型检查、构建、Sites 测试与 `git diff --check`，仅在全部通过后提交网站实现；不推送远端。
