# Electron 迁移阶段 2：命令中心核心界面 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在阶段 1 的 Electron + Sidecar 外壳上实现命令中心四页（新建任务、下载队列、历史记录、设置）及统一反馈，达到可日常完成「粘贴链接 → 下载 → 管理」的闭环。

**Architecture:** Renderer 用 React + 轻量客户端状态（Zustand）：Sidecar 快照为任务唯一事实来源；页面只发 `window.api.request` / 订阅 `onEvent`。布局为左侧导航 + 主区；窄窗折叠为图标栏。阶段 1 的连接状态页降级为 Sidecar 故障全屏页，不再作为默认首页。

**Tech Stack:** React 18、TypeScript、Zustand、Vite、Vitest + Testing Library、既有 `desktop/electron` IPC。

**规格来源:** `docs/superpowers/specs/2026-07-19-electron-migration-design.md` §4–5、§13 阶段 2。

## Global Constraints

- UI 文案中文；标识符英文；无内联 import。
- 不引入新本地 HTTP 端口；不破坏 `contextIsolation`。
- 进度事件可节流展示，终态必须立即反映。
- 工作区无关 WIP 不提交；每次只 `git add` 点名文件。
- 测试：`cd desktop && npm test`；Python 侧回归 `pytest tests/sidecar -q`。
- 本阶段不做：旧数据迁移、Dock 徽标、自动更新、签名公证、站内搜索。

---

## 文件结构总览

| 文件 | 动作 | 职责 |
|---|---|---|
| `desktop/renderer/store/appStore.ts` | 新建 | 连接态、任务快照、设置、toast 队列 |
| `desktop/renderer/lib/api.ts` | 新建 | 对 `window.api` 的类型化封装 |
| `desktop/renderer/lib/urls.ts` | 新建 | 从文本提取 URL |
| `desktop/renderer/components/Shell.tsx` | 新建 | 侧边栏 + 主区 + 故障页 |
| `desktop/renderer/components/Sidebar.tsx` | 新建 | 导航（宽/窄） |
| `desktop/renderer/components/ToastHost.tsx` | 新建 | 非阻塞反馈 |
| `desktop/renderer/components/ConfirmDialog.tsx` | 新建 | 破坏性确认 |
| `desktop/renderer/pages/NewTaskPage.tsx` | 新建 | 粘贴/解析/确认入队 |
| `desktop/renderer/pages/QueuePage.tsx` | 新建 | 队列与行内操作 |
| `desktop/renderer/pages/HistoryPage.tsx` | 新建 | 搜索筛选分页 |
| `desktop/renderer/pages/SettingsPage.tsx` | 新建 | 即时保存设置 |
| `desktop/renderer/styles.css` | 重写 | 设计令牌与布局 |
| `desktop/renderer/App.tsx` | 重写 | 挂载 Shell |
| `desktop/electron/main.ts` | 修改 | 可选：目录选择对话框 IPC |
| `desktop/electron/preload.ts` | 修改 | 暴露 `selectDirectory` |
| `desktop/renderer/**/*.test.tsx` | 新建 | 页面与 store 单测 |

---

### Task 0: 分支

```bash
git checkout electron-phase-1
git checkout -b electron-phase-2
```

提交本计划文件后开始实现。

---

### Task 1: 类型化 API + Zustand store

**Files:**
- Create: `desktop/renderer/lib/api.ts`
- Create: `desktop/renderer/lib/types.ts`
- Create: `desktop/renderer/store/appStore.ts`
- Test: `desktop/renderer/store/appStore.test.ts`

**Produces:**
- `api.request<T>(method, payload)`
- `useAppStore`: `{ connection, tasks, settings, route, toasts, hydrateSnapshot, applyEvent, setRoute, pushToast }`
- 启动时 `getSnapshot`；监听 `onEvent` / `onState`；重连后重新 `getSnapshot`

- [ ] 写 store 单测（快照替换、progress 更新、终态覆盖）
- [ ] 实现并通过 `npm test`
- [ ] Commit: `feat(desktop): add typed API client and app snapshot store`

---

### Task 2: Shell + 侧边栏导航

**Files:**
- Create: `desktop/renderer/components/Shell.tsx`
- Create: `desktop/renderer/components/Sidebar.tsx`
- Create: `desktop/renderer/components/ConnectionGate.tsx`
- Modify: `desktop/renderer/App.tsx`
- Modify: `desktop/renderer/styles.css`
- Test: `desktop/renderer/components/Sidebar.test.tsx`

**行为:**
- 路由：`new` | `queue` | `history` | `settings`；默认 `new`
- 宽窗（≥960）显示文字标签；窄窗仅图标
- 设置钉在侧栏底部
- `connection === 'failed'` 显示故障页（日志路径 + 重试说明），隐藏业务页
- 队列导航可显示活跃任务数小角标

- [ ] 实现 + 单测导航切换
- [ ] Commit: `feat(desktop): add command-center shell and responsive sidebar`

---

### Task 3: Toast 与确认框

**Files:**
- Create: `desktop/renderer/components/ToastHost.tsx`
- Create: `desktop/renderer/components/ConfirmDialog.tsx`
- Test: `desktop/renderer/components/ToastHost.test.tsx`

**行为（对齐 §5.5）:**
- 成功/信息自动消失；带行动按钮的 toast 在焦点停留时不消失
- 确认框用于：清空历史、删除多条、退出时有未完成任务（若 Main 转发 before-quit）

- [ ] Commit: `feat(desktop): add toast host and confirm dialog`

---

### Task 4: 新建任务页

**Files:**
- Create: `desktop/renderer/pages/NewTaskPage.tsx`
- Create: `desktop/renderer/lib/urls.ts`
- Test: `desktop/renderer/lib/urls.test.ts`
- Test: `desktop/renderer/pages/NewTaskPage.test.tsx`

**流程:**
1. 多行文本框粘贴 → 提取 URL
2. 「解析」→ `download.parseUrls`；订阅 `download.parseResult` 渐进填充
3. 可取消 → `download.cancelParse`
4. 勾选有效项 → 「开始下载」→ `download.createTasks`（带 title）
5. 无效项单独列表；提供「跳过解析直接入队」
6. 字段内错误，无模态

- [ ] Commit: `feat(desktop): implement new-task parse-and-confirm flow`

---

### Task 5: 下载队列页

**Files:**
- Create: `desktop/renderer/pages/QueuePage.tsx`
- Create: `desktop/renderer/components/TaskRow.tsx`
- Test: `desktop/renderer/pages/QueuePage.test.tsx`

**行为（§5.2）:**
- 行内：状态、进度、体积、速度、ETA、允许的操作
- 批量：全部暂停 / 全部恢复 / 清除已完成
- 空态：引导去新建任务（不渲染空表）
- 完成：打开文件 / 访达显示（经 Main `shell.openPath` / `showItemInFolder`）

- [ ] 扩展 preload/main：`showItemInFolder`
- [ ] Commit: `feat(desktop): implement download queue page with row actions`

---

### Task 6: 历史记录页

**Files:**
- Create: `desktop/renderer/pages/HistoryPage.tsx`
- Test: `desktop/renderer/pages/HistoryPage.test.tsx`

**行为（§5.3）:**
- 即时搜索 + 状态筛选 → `history.list`（offset/limit）
- 滚动到底加载更多
- 重新下载 / 打开 / 删除；清空需确认

- [ ] Commit: `feat(desktop): implement history page with search and pagination`

---

### Task 7: 设置页

**Files:**
- Create: `desktop/renderer/pages/SettingsPage.tsx`
- Modify: main/preload 增加 `selectDirectory`
- Test: `desktop/renderer/pages/SettingsPage.test.tsx`

**行为（§5.4）:**
- 即时 `settings.update`（防抖 300ms）
- 状态文案：正在保存 / 已保存 / 输入有误
- 代理启用时地址必填；目录选择走系统对话框
- 主题：system / light / dark（写配置；跟随系统由 `nativeTheme` 后续阶段 3 完善，本阶段先应用 `data-theme`）

- [ ] Commit: `feat(desktop): implement settings page with instant save`

---

### Task 8: 拖放与窗口菜单钩子（最小）

**Files:**
- Modify: `desktop/electron/main.ts`（`webContents` 允许 drop；`Cmd+N` 等可先用 Renderer keydown）
- Modify: `NewTaskPage` / `Shell` 接收 drop 的 URL 文本

本阶段快捷键在 Renderer 实现即可：`Cmd/Ctrl+N` → 新建；`Cmd/Ctrl+,` → 设置；历史页 `Cmd/Ctrl+F` 聚焦搜索。

- [ ] Commit: `feat(desktop): add drag-drop URLs and keyboard navigation hooks`

---

### Task 9: 验收与回归

- [ ] `cd desktop && npm test && npm run build`
- [ ] `pytest tests/sidecar -q`
- [ ] 手工：`npm run dev` — 解析一条链接、入队、暂停恢复、设置保存、历史删除
- [ ] 对照 §13 阶段 2 清单打勾
- [ ] Commit 收尾（若有）

---

## 自审记录

- 规格 §4–5 四页与反馈规则均有对应任务。
- 复用阶段 1 协议方法，不扩展 Sidecar（除非发现 `showItemInFolder` 仅需 Main）。
- 状态以快照为准，避免 Renderer 本地改任务字段。
