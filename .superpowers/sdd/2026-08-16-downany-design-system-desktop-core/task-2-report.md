# Task 2 Report - Accessible UI Primitives

## 结论

- 已按 brief 完成 Task 2 范围内的 UI primitive：`Icon`、`Button`、`IconButton`、`TextField`、`FilterTab`、`ui.css`。
- 已复用 Task 1 的 canonical token 源：`design-system/tokens.css` 与 `desktop/renderer/styles/foundations.css`，未新增第二套 token。
- 已按要求替换现有行为中的图标占位：`ToastHost` 关闭按钮、`NetSearchPanel` 缩略图占位播放图标。
- 聚焦测试通过，`npm run build` 通过。
- 完整 `desktop` 测试未全绿，失败集中在既有 Telegram 相关用例与本地监听限制；按要求未修改 Telegram。

## 本次修改

### 新增文件

- `desktop/renderer/components/ui/Icon.tsx`
- `desktop/renderer/components/ui/Button.tsx`
- `desktop/renderer/components/ui/TextField.tsx`
- `desktop/renderer/components/ui/FilterTab.tsx`
- `desktop/renderer/components/ui/uiPrimitives.test.tsx`
- `desktop/renderer/styles/ui.css`

### 修改文件

- `desktop/renderer/styles.css`
- `desktop/renderer/components/ToastHost.tsx`
- `desktop/renderer/components/NetSearchPanel.tsx`

## 实现说明

### 1. Exhaustive SVG Icon

- 实现了 brief 指定的 `IconName` 穷举联合类型，共 16 个图标名。
- `Icon` 统一输出：
  - `viewBox="0 0 24 24"`
  - `fill="none"`
  - `stroke="currentColor"`
  - `strokeWidth="1.5"`
  - `strokeLinecap="round"`
  - `strokeLinejoin="round"`
  - `data-icon={name}`
  - `aria-hidden="true"`
  - `focusable="false"`
- `glyph()` 使用 exhaustive switch，默认分支通过 `never` 做编译期穷举保护。

### 2. Button / IconButton

- `Button` 使用 `forwardRef<HTMLButtonElement, ButtonProps>`。
- `IconButton` 使用 `forwardRef<HTMLButtonElement, IconButtonProps>`，满足后续搜索恢复焦点需求。
- `Button` 默认 `type="button"`。
- `loading` 时：
  - 保留原 children 可见
  - `disabled={disabled || loading}`
  - `aria-busy`
- `IconButton` 同时设置了：
  - `aria-label={label}`
  - `title={label}`

### 3. TextField

- 按 brief 接口实现 `leadingIcon?: IconName`。
- 使用 `<label className="ui-text-field">` 包裹 input。
- 图标与输入框共享统一控件高度、内边距和 focus ring。

### 4. FilterTab

- 按 brief 渲染为 `role="tab"` 的 button。
- 暴露 `aria-selected`。
- 可选 count 文本使用 `.ui-filter-tab__count`。
- 指示条使用 `aria-hidden`。
- 为满足测试要求和可访问名称一致性，显式设置：
  - `aria-label={count ? \`\${label} \${count}\` : label}`

### 5. 样式与 token 接入

- 新增 `desktop/renderer/styles/ui.css`，只使用 Task 1 语义 token。
- 在 `desktop/renderer/styles.css` 中按 brief 顺序于 `foundations.css` 后导入 `ui.css`。
- 未引入新的颜色、间距、圆角或交互时长 token。

### 6. 现有组件图标替换

- `ToastHost`：
  - 将关闭按钮的 `×` 替换为 `<Icon name="close" size={14} />`
  - 保留原 `aria-label="关闭"`
- `NetSearchPanel`：
  - 将空缩略图占位 `▶` 替换为 `<Icon name="play" size={14} />`
  - 未更改行为与文案

## TDD 过程

### Red

先新增 `desktop/renderer/components/ui/uiPrimitives.test.tsx`，随后运行：

```bash
cd desktop
npm test -- renderer/components/ui/uiPrimitives.test.tsx
```

结果按预期失败，失败原因为：

- `Failed to resolve import "./Button"`

说明新测试确实覆盖了尚未存在的 primitive 接口，而非误测现有行为。

### Green

补齐实现后，第一次聚焦测试发现一个真实无障碍细节问题：

- `FilterTab` 的 accessible name 实际为 `进行中2`
- brief 测试期望为 `进行中 2`

随后修正 `FilterTab` 的 `aria-label` 拼接逻辑，再次运行聚焦测试通过。

## 验证结果

### 1. 聚焦测试

命令：

```bash
cd desktop
npm test -- renderer/components/ui/uiPrimitives.test.tsx renderer/components/NetSearchPanel.test.tsx
```

结果：

- 2 files passed
- 9 tests passed

覆盖到：

- loading button 可访问名称与禁用态
- icon-only button 的可访问名称
- selected filter tab 的 `aria-selected` 与 count
- TextField 的 label + leading icon
- `NetSearchPanel` 现有行为回归

### 2. 完整 desktop 测试

命令：

```bash
cd desktop
npm test
```

结果：

- 36 test files 中 30 个通过，6 个失败
- 149 tests 中 134 个通过，15 个失败

失败明细分两类：

#### A. 既有本地监听限制 / Telegram 相关 EPERM

以下测试因 `listen EPERM: operation not permitted 127.0.0.1` 失败：

- `electron/telegram/client.test.ts`
  - 6 个失败
- `electron/telegram/controller.delivery.e2e.test.ts`
  - 1 个失败
- `electron/telegram/controller.test.ts`
  - 3 个失败
- `electron/telegram/delivery.integration.test.ts`
  - 1 个失败

这与本次 UI primitive 改动无关，且符合你提前提示的“既有 Telegram/本地监听失败需准确记录，不要修改 Telegram”边界。

#### B. 既有 Telegram 路径/私有路径守卫失败

- `electron/telegram/paths.test.ts`
  - 1 个失败
  - 断言为 Windows 路径分隔符不一致：
    - expected: `C:\Program Files\Downany\resources\telegram-bot-api\telegram-bot-api.exe`
    - received: `C:\Program Files\Downany\resources/telegram-bot-api/telegram-bot-api.exe`

- `electron/telegram/supervisor.test.ts`
  - 3 个失败
  - 失败表现为 `Telegram 私有路径越界`
  - 导致其未进入测试原本期望的后续分支，例如：
    - local endpoint / flags 校验
    - `LOCAL_PROCESS_RECOVERY_REQUIRED`
    - `packaged manifest drift`

这部分同样未在本任务范围内处理。

### 3. Build

命令：

```bash
cd desktop
npm run build
```

结果：

- 通过
- renderer / electron main / preload / extractPreload 均成功产出

### 4. 额外检查

命令：

```bash
git diff --check
```

结果：

- 通过，无空白错误

## 范围自查

### 已遵守

- 只实现 Task 2
- 未实现窗口、ActionBar、FilterBar 或后续任务
- 未修改 Sidecar、Telegram、扩展、CLI、计划或 ledger
- 使用 brief 指定接口与提交信息
- 复用 Task 1 token
- 添加真实行为/可访问性测试

### 未做

- 未处理 Telegram 测试失败
- 未尝试修复本地监听 `EPERM`
- 未扩展 primitive 到其他页面控件
- 未 push

## 提交信息

按 brief 使用：

```bash
feat(ui): add reusable desktop controls
```
