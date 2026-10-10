# Downany v0.3.0 关键路径文案与产品事实一致性 Implementation Plan

> **For Codex:** Use `superpowers:executing-plans` to implement this plan task-by-task. Use `superpowers:test-driven-development` for catalog and component changes, and `superpowers:verification-before-completion` before claiming consistency is complete.

**Goal:** 让获取应用、添加下载、失败恢复、播放列表、应用更新、诊断和 Telegram 这些 `v0.3.0` 关键用户路径在简体中文/英语下表达同一对象、动作、状态和结果，并让 README、路线图、Release 文档、扩展和官网对当前能力、平台、签名及更新方式陈述同一事实。

**Architecture:** 把轻量 i18n 目录改成编译期完整的类型化目录，使用一个 React locale hook 响应语言切换；关键纯函数接收显式 locale，组件不再各自复制事件订阅。即时操作失败只展示按动作定义的稳定用户文案，不渲染原始异常。公开载体不共享运行时代码，而由一个版本化 `docs/product-facts.json` 和静态检查器约束必要事实、下载入口及禁止公开描述，避免把 Markdown、扩展和官网强耦合。

**Tech Stack:** TypeScript 5.7、React 18、Vitest、Testing Library、Node.js 20、Python 3.11、Vite、Chrome MV3、Markdown/JSON 静态合同。

**Spec:** `docs/superpowers/specs/2026-08-26-downany-v0-3-staged-upgrade-design.md` 第 4.5、5.3、6 节，以及仓库 `AGENTS.md` 的界面文案规则。

## Global Constraints

- **用户范围调整（2026-08-27）：** 先读 `docs/superpowers/specs/2026-08-27-downany-windows-execution-scope.md`。本任务只负责 Windows 与扩展；不执行或等待 Mac 构建/验收，保留现有 Mac 实现和历史资产。

- 从升级迁移计划已获授权集成后的最新 `main` 创建 `chore/v0-3-product-consistency`。
- 本计划只覆盖关键路径，不以一次性翻译所有低频设置、开发画廊或维护文档为完成条件。
- 所有界面文案先区分用户操作、产品对象和结果；不得出现“需求、方案、接口、Sidecar、Renderer、占位、开发联调、后续上线”等内部语言。
- 英语目录不得依赖中文回退来伪装完整；关键 key 在两种 locale 下都必须存在且非空。
- 品牌 `Downany · 百纳`、产品名 `Telegram`、工具名 `yt-dlp`、格式名和平台商标可在英语中保持原名；普通用户句子不得混入中文。
- UI 不直接显示 `String(error)`、堆栈、响应正文、Cookie、Token、URL 查询参数、本地绝对路径或代理认证。原始异常留在受控日志/诊断边界，普通界面只显示稳定动作结果。
- 诊断导出成功后可以通过系统文件管理器定位文件，但界面正文不长期渲染完整绝对路径；文案必须在导出前说明包含与排除内容。
- 公开载体不得描述已要求移除的成人站点支持；内部平台 enum、匹配、URL、Referer、下载和测试逻辑必须保持。
- 官网事实检查不授权部署、绑定域名或修改线上内容；只构建和验证仓库内网站。
- 本计划不授权 merge、push、tag、CI dispatch、上传或发布。

## 任务 1：把 i18n 目录升级为类型化、可响应的关键路径合同

**文件**

- 修改：`desktop/renderer/i18n.ts`
- 新建：`desktop/renderer/i18n.test.ts`
- 新建：`desktop/renderer/useLocale.ts`
- 新建：`desktop/renderer/useLocale.test.tsx`
- 修改：`desktop/renderer/components/shell/ActionBar.tsx`
- 修改：`desktop/renderer/components/shell/FilterBar.tsx`
- 修改：`desktop/renderer/components/EmptyState.tsx`
- 修改：`desktop/renderer/components/TaskList.tsx`
- 修改：`desktop/renderer/components/SitesPanel.tsx`

**Interfaces:** consumes `localStorage`, the `downany:locale` event, and one canonical Chinese catalog; produces `Locale`, `CopyKey`, `CopyValues`, `t(key, locale, values)`, `setLocale(locale)`, and `useLocale()` with compile-time English completeness and one runtime subscription path.

- [ ] **Step 1: 写类型和运行时失败测试**

`i18n.test.ts` 覆盖：

```ts
it.each(CRITICAL_COPY_KEYS)("has complete critical copy for %s", (key) => {
  expect(t(key, "zh-CN")).not.toBe(key);
  expect(t(key, "en")).not.toBe(key);
  expect(t(key, "zh-CN").trim()).not.toBe("");
  expect(t(key, "en").trim()).not.toBe("");
});

it("interpolates declared values without leaking placeholders", () => {
  expect(t("update.available", "en", { version: "0.3.0" })).toBe("Downany 0.3.0 is available");
  expect(t("update.available", "zh-CN", { version: "0.3.0" })).toBe("发现 Downany 0.3.0");
});
```

`useLocale.test.tsx` 证明一个 mounted consumer 在 `setLocale("en")` 后无需 reload 即更新，unmount 后移除 listener。现有五个组件测试删除重复订阅实现并保持行为。

- [ ] **Step 2: 运行并确认 RED**

```powershell
Push-Location desktop
npm.cmd test -- renderer/i18n.test.ts renderer/useLocale.test.tsx
Pop-Location
```

- [ ] **Step 3: 实现类型化目录与插值**

以中文 key 推导类型，英语必须 satisfies 同一键集合：

```ts
export const zhCN = {
  "nav.all": "全部",
  "action.add": "添加",
  "update.available": "发现 Downany {version}",
} as const;

export type CopyKey = keyof typeof zhCN;
export type CopyValues = Readonly<Record<string, string | number>>;

export const en = {
  "nav.all": "All",
  "action.add": "Add",
  "update.available": "Downany {version} is available",
} satisfies Record<CopyKey, string>;
```

实际提交保留全部现有 key 并加入本计划关键 key；代码片段中的三项只是结构，不得删除其他目录内容。`t` 对缺失插值变量保持 `{name}` 并让测试失败，不把 `undefined` 渲染给用户。生产中未知 key 回退中文，关键 key 由测试保证不会触发回退。

`useLocale()` 统一监听 `downany:locale`：

```ts
export function useLocale(): Locale {
  const [locale, setLocaleState] = useState<Locale>(() => getLocale());
  useEffect(() => {
    const refresh = () => setLocaleState(getLocale());
    window.addEventListener("downany:locale", refresh);
    return () => window.removeEventListener("downany:locale", refresh);
  }, []);
  return locale;
}
```

- [ ] **Step 4: 迁移已有订阅组件并确认 GREEN**

```powershell
Push-Location desktop
npm.cmd test -- renderer/i18n.test.ts renderer/useLocale.test.tsx renderer/components/shell/ActionBar.test.tsx renderer/components/EmptyState.test.tsx renderer/components/TaskList.test.tsx
Pop-Location
```

- [ ] **Step 5: 本地提交检查点（仅在已授权时）**

```powershell
git add desktop/renderer/i18n.ts desktop/renderer/i18n.test.ts desktop/renderer/useLocale.ts desktop/renderer/useLocale.test.tsx desktop/renderer/components/shell/ActionBar.tsx desktop/renderer/components/shell/FilterBar.tsx desktop/renderer/components/EmptyState.tsx desktop/renderer/components/TaskList.tsx desktop/renderer/components/SitesPanel.tsx
git commit -m "feat(ui): type critical locale catalog"
```

## 任务 2：统一添加、失败恢复、任务与播放列表关键路径

**文件**

- 新建：`desktop/renderer/lib/userError.ts`
- 新建：`desktop/renderer/lib/userError.test.ts`
- 修改：`desktop/renderer/lib/addFlow.ts`
- 修改：`desktop/renderer/components/AddConfirmDialog.tsx`
- 修改：`desktop/renderer/components/AddConfirmDialog.test.tsx`
- 修改：`desktop/renderer/components/task/failureRecovery.ts`
- 修改：`desktop/renderer/components/task/failureRecovery.test.ts`
- 修改：`desktop/renderer/components/task/taskPresentation.ts`
- 修改：`desktop/renderer/components/task/taskPresentation.test.ts`
- 修改：`desktop/renderer/components/task/MediaTaskBanner.tsx`
- 修改：`desktop/renderer/components/task/MediaTaskBanner.test.tsx`
- 修改：`desktop/renderer/components/PlaylistGroupCard.tsx`
- 修改：`desktop/renderer/components/PlaylistGroupCard.test.tsx`（进入本计划前由 v0.2.5 任务 4 新建）
- 修改：`desktop/renderer/components/task/TaskActionsMenu.tsx`
- 修改：`desktop/renderer/components/task/useTaskCommands.ts`
- 修改：`desktop/renderer/i18n.ts`

**Interfaces:** consumes explicit `Locale`, task snapshots, stable error codes, and user action identifiers; produces localized add/selection/recovery/task/group presentations and `userErrorFor(action, locale)` that never renders the caught exception.

- [ ] **Step 1: 写稳定错误边界的失败测试**

定义有限动作：

```ts
export type UserOperation =
  | "parse"
  | "add"
  | "taskAction"
  | "groupAction"
  | "history"
  | "saveSettings"
  | "updateTool"
  | "exportDiagnostics"
  | "telegram";
```

测试传入包含绝对路径、URL query token、Cookie、Bot token 和堆栈的 Error，`userErrorFor` 在中英文下都只返回对应目录文案，输出不包含任何原始片段。组件测试 mock reject 后检查 toast/detail 不含原始异常。

- [ ] **Step 2: 让纯展示函数接收显式 locale**

```ts
export function failureRecoveryFor(
  errorCode: string | null | undefined,
  locale: Locale = "zh-CN",
): FailureRecoveryView;

export function presentTask(
  task: TaskSnapshot,
  locale: Locale = "zh-CN",
  now: Date = new Date(),
): TaskPresentation;
```

`FAILURE_VIEWS` 保存 `detailKey: CopyKey` 而不是中文句子；状态、主动作、完成时间前缀和字节单位按 locale 渲染。未知错误仍给“重试或网页识别”的安全动作，不展示 `error_message`。

- [ ] **Step 3: 迁移关键组件文案**

至少加入并使用下列 key 组：

- `add.confirm.*`：确认下载、条目选择、范围、画质、解析/添加结果。
- `task.status.*`、`task.action.*`、`task.failure.*`：状态、暂停/继续/打开/重试、错误解释和恢复动作。
- `playlist.*`：合集、项目计数、展开/折叠、整组操作、删除确认、没有已完成文件。
- `operation.error.*`：按用户动作定义的稳定失败提示。

组件通过 `useLocale()` 取得 locale，并传给纯函数。不要在 `FailureRecoveryView` 或任务状态对象里存双语用户句子。

- [ ] **Step 4: 运行关键路径 GREEN**

```powershell
Push-Location desktop
npm.cmd test -- renderer/lib/userError.test.ts renderer/components/AddConfirmDialog.test.tsx renderer/components/task/failureRecovery.test.ts renderer/components/task/taskPresentation.test.ts renderer/components/task/MediaTaskBanner.test.tsx renderer/components/PlaylistGroupCard.test.tsx
Pop-Location
```

- [ ] **Step 5: 静态禁止关键路径原始异常**

在 `i18n.test.ts` 或独立源扫描测试中对上述关键文件断言不含 `detail: String(error)`、`detail: String(err)`、`setError(String(error))`、`setError(String(err))`。不要扫描内部日志和功能测试，避免误删有价值的开发错误信息。

## 任务 3：统一更新、诊断、连接和 Telegram 关键设置路径

**文件**

- 修改：`desktop/renderer/SettingsApp.tsx`
- 修改：`desktop/renderer/SettingsApp.diagnostics.test.ts`
- 新建：`desktop/renderer/SettingsApp.locale.test.tsx`
- 修改：`desktop/renderer/components/ConnectionGate.tsx`
- 新建：`desktop/renderer/components/ConnectionGate.test.tsx`
- 修改：`desktop/renderer/components/TelegramSettingsTab.tsx`
- 修改：`desktop/renderer/components/TelegramSettingsTab.test.tsx`
- 修改：`desktop/renderer/components/ToastHost.tsx`
- 修改：`desktop/renderer/i18n.ts`

**Interfaces:** consumes update status, diagnostics export result, connection state, Telegram config/delivery summaries, and `useLocale()`; produces localized critical settings UI with stable success/failure copy, privacy explanation, and no persistent rendering of local absolute paths.

- [ ] **Step 1: 写中英文关键设置旅程测试**

分别以 `zh-CN` 和 `en` 渲染并断言：

- 连接失败的标题、说明和重新尝试动作。
- 检查应用更新的 idle/busy/up-to-date/update-available/error 状态及“前往下载”。
- 诊断包含/排除说明、导出中、成功、失败和在文件管理器中显示。
- Telegram 绑定、选择接收位置、自动发送、测试消息、断开和最近发送空态。
- 切换语言后 mounted Settings/Telegram 组件更新，不依赖 `window.location.reload()`。

- [ ] **Step 2: 修正诊断路径展示**

成功后调用 `window.api.showItemInFolder(result.path)` 并显示“已导出，可在文件管理器中查看”，不再把 `diagPath` 作为正文长期渲染。测试继续证明导出前文案明确：包含应用版本、系统环境、错误类型和日志数量；排除下载链接、内容标题、日志正文和账号信息。

- [ ] **Step 3: 使用稳定动作错误，不显示 caught Error**

`persist`、yt-dlp 检查/更新、Telegram 初始化/动作均调用 `userErrorFor(...)`。服务端提供的版本号、已验证目标显示名等产品数据可以展示；异常对象和内部错误消息不进入 state/toast。

- [ ] **Step 4: 运行 GREEN**

```powershell
Push-Location desktop
npm.cmd test -- renderer/SettingsApp.diagnostics.test.ts renderer/SettingsApp.locale.test.tsx renderer/components/ConnectionGate.test.tsx renderer/components/TelegramSettingsTab.test.tsx
Pop-Location
```

## 任务 4：建立公开产品事实合同与精确扫描边界

**文件**

- 新建：`docs/product-facts.json`
- 新建：`scripts/check_product_facts.mjs`
- 新建：`scripts/check_product_facts.test.mjs`
- 修改：`package.json`
- 修改：`.github/workflows/ci.yml`

**Interfaces:** consumes one versioned product-facts JSON document and an allowlist of public surfaces; produces schema validation, required-fact assertions, canonical release-link checks, stale/internal-copy rejection, and a public-only forbidden-description scan that leaves internal recognition behavior untouched.

- [ ] **Step 1: 写事实文件 schema 与失败测试**

`docs/product-facts.json` 使用以下稳定结构：

```json
{
  "schemaVersion": 1,
  "productName": "Downany · 百纳",
  "releasePage": "https://github.com/JackEngineer/downany/releases/latest",
  "desktopPlatforms": ["macOS Apple Silicon", "Windows x64"],
  "acceptancePlatforms": ["Windows x64"],
  "distribution": {
    "signed": false,
    "updateMode": "manual",
    "artifacts": ["nsis", "chrome-extension-zip"]
  },
  "availableCapabilities": [
    "link-download",
    "browser-recognition",
    "playlist-selection",
    "queue-persistence",
    "failure-recovery",
    "diagnostics-export",
    "telegram-auto-delivery"
  ],
  "publicSurfaces": [
    "README.md",
    "docs/roadmap.md",
    "docs/RELEASE.md",
    "browser-extension/README.md",
    "browser-extension/install.html",
    "browser-extension/install.js",
    "website/src/content/siteContent.ts"
  ]
}
```

测试拒绝未知 schema、重复 capability、非 HTTPS 外链、`signed=true` 与当前 builder `identity: null` 冲突、`updateMode=automatic` 与当前 `appUpdater` 手动下载冲突、缺少任一公共文件。

`desktopPlatforms` 只描述保留的现有平台实现；本轮验收及交付承诺以 `acceptancePlatforms` 和 `distribution.artifacts` 为准，不宣称 Mac 已完成 v0.3.0 验收。

- [ ] **Step 2: 写公共载体事实检查**

检查器对 allowlist 文件验证：

- 不含“占位、上线后、开发联调、随下一版本提供、Windows 版准备中”等过期或内部文案。
- 安装回退只使用 `releases/latest` 或由官网运行时解析出的真实 Release 资产，不使用不存在的下载页。
- README/Release 文档都明确未签名、手动更新及 Windows NSIS/扩展 ZIP；官网不声称已签名或自动安装更新。
- README、路线图、扩展和官网不把已实现的播放列表、诊断、Telegram 写成未实现。
- 只对 `publicSurfaces` 和新增 `docs/RELEASE-NOTES-0.3.0.md`（存在时）执行禁止公开站点描述扫描；不扫描 `src/`、`tests/`、`desktop/electron/`、扩展匹配代码或内部技术文档。

- [ ] **Step 3: 运行并确认 RED**

```powershell
node --test scripts/check_product_facts.test.mjs
node scripts/check_product_facts.mjs
```

预期当前路线图、官网 Telegram 文案或扩展旧说明至少一项失败。

- [ ] **Step 4: 接入根命令和 CI**

根 `package.json` 新增 `test:product-facts`，CI 在 browser-extension 或独立轻量 job 中运行 `node scripts/check_product_facts.mjs`。检查器只读，不抓网络，不依赖线上 Release 当前状态。

## 任务 5：统一 README、路线图、发布说明、扩展和官网事实

**文件**

- 修改：`README.md`
- 修改：`docs/roadmap.md`
- 修改：`docs/RELEASE.md`
- 修改：`browser-extension/README.md`
- 修改：`browser-extension/install.html`
- 修改：`browser-extension/install.js`
- 修改：`website/src/content/siteContent.ts`
- 修改：`website/src/App.test.tsx`
- 修改：`website/src/components/core-interactions.test.tsx`

**Interfaces:** consumes `docs/product-facts.json` and the current accepted implementation; produces user-facing public copy that agrees on available capabilities, platforms, artifacts, unsigned/manual-update limitations, install recovery, and Telegram availability.

- [ ] **Step 1: 按当前代码事实改写路线图基线**

保留未来方向，但把“当前差距”改成执行时实际状态：播放列表选择/分组、诊断导出、结构化错误、网页识别、Cookie 导入、队列持久化、Telegram 自动转发已经存在；签名/公证、自动替换更新和商店分发仍未完成。删除与代码事实重复或已经完成的“未来任务”，不承诺未验收平台。

- [ ] **Step 2: 统一下载和安装入口**

扩展无客户端时先尝试协议唤起，失败后到 `https://github.com/JackEngineer/downany/releases/latest`。用户文案只说明“下载并启动 Downany 后返回页面重试”；不显示开发命令、占位状态或上线计划。

- [ ] **Step 3: 统一能力和限制**

- README 与官网：链接下载、网页识别、播放列表/批量队列、暂停恢复、历史、诊断和 Telegram 都按已实现能力描述。
- Release 文档：本轮 Windows NSIS、扩展 ZIP、未签名/SmartScreen 和手动下载更新；已有 Mac 说明保留为对应版本历史，不宣称本轮已验证 Mac。
- 扩展 README：Chrome 为正式手动加载路径；Edge/Firefox 只保留经当前实现验证的兼容边界，不夸大商店上架。
- 网站：Telegram 不再写“随下一版本提供”；下载按钮继续以 GitHub Release API 真实资产为准，缺失时明确回到 Release 页面。

- [ ] **Step 4: 保持功能支持代码不变**

```powershell
git diff -- src/core/platform_detector.py src/core/download_task.py desktop/electron/thumbnailReferrer.ts desktop/electron/main.ts browser-extension/shared.js tests/core/test_platform_detector.py desktop/electron/thumbnailReferrer.test.ts
```

上述 diff 应为空；如果因其他已集成分支本就有变更，使用本任务起点 SHA 比较并证明本任务没有删除内部识别、Referer 或下载功能。

- [ ] **Step 5: 让事实检查 GREEN**

```powershell
node --test scripts/check_product_facts.test.mjs
node scripts/check_product_facts.mjs

Push-Location website
npm.cmd test
npm.cmd run build
Pop-Location
```

## 任务 6：验证扩展、官网与桌面端可见一致性

**文件**

- 新建：`docs/acceptance/v0.3-product-consistency.md`
- 修改：`docs/product-facts.json`（只在实现事实证明需要时）

**Interfaces:** consumes green catalog/component/public-fact builds; produces visible zh-CN/en evidence for the critical desktop journeys plus built website/extension evidence, while separating local source truth from any unperformed online deployment.

- [ ] **Step 1: 运行桌面端全测试与生产构建**

```powershell
Push-Location desktop
$downanyHadNodeOptions = Test-Path Env:NODE_OPTIONS
$downanyPriorNodeOptions = $env:NODE_OPTIONS
try {
  $env:NODE_OPTIONS = "--no-experimental-webstorage"
  npm.cmd test
  npm.cmd run build
} finally {
  if ($downanyHadNodeOptions) { $env:NODE_OPTIONS = $downanyPriorNodeOptions } else { Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue }
  Pop-Location
}
```

- [ ] **Step 2: 运行扩展与事实合同**

```powershell
node browser-extension/shared.test.js
node browser-extension/sniff-core.test.js
node browser-extension/bridge-timeout.test.js
node --test scripts/check_product_facts.test.mjs
node scripts/check_product_facts.mjs
```

- [ ] **Step 3: 执行桌面可见双语旅程**

在 Windows 候选执行；Mac 不在本任务范围：

1. 中文：添加公开链接 → 确认 → 任务完成/打开。
2. 英语：切换语言 → 同一添加旅程，界面无需重启。
3. 中文/英语各触发一个固定失败码，核对原因和恢复动作，不出现内部异常。
4. 解析播放列表 → 选择 → 分组 → 暂停/继续/删除确认。
5. 检查应用更新、导出诊断并在文件管理器定位。
6. Telegram 设置页核对绑定/目标/自动发送/最近发送关键状态。

截图先遮蔽 URL、标题、聊天信息和用户路径；验收文档记录文案结果和动作，不嵌入敏感截图。

- [ ] **Step 4: 执行官网与扩展可见检查**

官网用本地生产构建验证桌面/移动布局、下载可用/缺失状态、能力和 FAQ；扩展用解压目录验证在线、离线唤起成功、未安装三态。明确“本地网站构建通过”不等于官网已部署。

- [ ] **Step 5: 记录证据**

`docs/acceptance/v0.3-product-consistency.md` 记录源码 SHA、两种 locale 的关键路径、组件/构建命令、事实检查结果、平台可见证据以及未部署边界。

## 任务 7：全仓回归与候选交接

**文件**

- 修改：`docs/acceptance/v0.3-product-consistency.md`
- 修改：`docs/superpowers/plans/2026-08-27-downany-v0-3-convergence-index.md`（只更新执行状态）

**Interfaces:** consumes tasks 1–6 and their evidence; produces a reviewable local product-consistency candidate and an exact handoff to release convergence, without version bumping to 0.3.0 or performing remote mutations.

- [ ] **Step 1: 运行全仓自动化**

```powershell
python -m pytest tests/core tests/data tests/sidecar tests/cli tests/upgrade -q

Push-Location desktop
$downanyHadNodeOptions = Test-Path Env:NODE_OPTIONS
$downanyPriorNodeOptions = $env:NODE_OPTIONS
try {
  $env:NODE_OPTIONS = "--no-experimental-webstorage"
  npm.cmd test
  npm.cmd run build
} finally {
  if ($downanyHadNodeOptions) { $env:NODE_OPTIONS = $downanyPriorNodeOptions } else { Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue }
  Pop-Location
}

Push-Location website
npm.cmd test
npm.cmd run build
Pop-Location

node browser-extension/shared.test.js
node browser-extension/sniff-core.test.js
node browser-extension/bridge-timeout.test.js
node scripts/check_product_facts.mjs
git diff --check
```

- [ ] **Step 2: 审查目录完整与原始异常边界**

```powershell
rg -n "String\((err|error)\)" desktop/renderer -g '*.ts' -g '*.tsx'
rg -n "占位|上线后|开发联调|随下一版本提供|Windows 版准备中" README.md docs/roadmap.md docs/RELEASE.md browser-extension website/src/content/siteContent.ts
git status --short
git diff --stat
```

第一条只允许不进入用户界面的测试/开发诊断位置；关键路径发现任一直接渲染即失败。第二条预期无匹配。

- [ ] **Step 3: completion verification**

重跑任务 7 命令并逐项核对验收记录。英语只完成自动化而未在 Windows 可见验证时，状态写成“目录与组件候选”，不能写成 Windows 关键路径一致性完成。

- [ ] **Step 4: 本地提交或交接（仅按已有授权）**

若已授权，按“i18n 基础设施”“关键路径迁移”“公开事实与文档”拆分本地提交；未授权则保留工作树。不得自行 merge、push、升版、打标签或发布。
