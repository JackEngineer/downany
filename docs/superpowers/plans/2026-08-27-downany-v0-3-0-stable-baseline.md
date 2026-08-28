# Downany v0.3.0 Windows Stable Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Implementation is sequential; the required independent final code review is read-only.

**Goal:** 在已验证的 v0.2.5 基础上完成旧数据保留、关键操作与语言一致性，交付自动化验证的 v0.3.0 Windows 本地候选。

**Architecture:** 复用现有请求级快照保护与六态数据模型，集中启动/重连订阅；使用由旧 tag 生成的独立数据 fixture 验证兼容性。语言目录与订阅只覆盖既有用户链路，不更换下载引擎或更新机制。

**Tech Stack:** Python 3.11、SQLite、pytest、Electron 33、React 18、TypeScript 5、Zustand、Vitest、yt-dlp、ffmpeg/ffprobe。

**Spec:** `docs/superpowers/specs/2026-08-27-downany-v0-3-0-stable-baseline-design.md`；同时遵守 `docs/superpowers/specs/2026-08-27-downany-windows-execution-scope.md`。

## Global Constraints

- 只负责 Windows x64 和 Chrome 扩展；不要求人工安装、窗口操作或操作系统重启；没有执行的检查不得写成通过。
- 保持六种公共状态、默认单链接语义、成品不变量，以及 Telegram/下载结果独立。
- 原始异常和凭据不得出现在普通界面；中文默认，已有 English 选择得到关键路径一致性。
- 基线为 v0.2.5 的 475 文件原始字节快照（零差异），未提交/未合并。保留原候选和产物；复用已验证依赖，不对 junction 执行 npm ci/install。
- 所有中间提交检查点只记录逻辑差异与 GREEN 证据，不运行 git add/commit/merge/push/tag、远程 CI、上传/发布或清理。
- 输出采用新的版本目录。没有可追溯的源文件和资源清单时不开始 NSIS。

## 任务 0：继承基线与上下文

**Files:** `.build/v030-execution/inherited-source.json`；当前 `AGENTS.md`、`docs/RELEASE.md`、`.github/workflows/ci.yml`。

**Interfaces:** 输入 v0.2.5 R2 源码和已验证媒体工具；输出逐字节匹配的独立 `fix/v0.3.0-stable-baseline` 工作区及全量 GREEN 基线。

- [x] 核对 worktree/branch/忽略规则，以相同 HEAD 建立新工作树并复制 475 个候选文件，哈希零差异。
- [x] 完整读取当前指引/发布文档/工作流；Mac 要求按用户范围覆盖，不改变历史资产。
- [x] 使用临时 DOWNANY_DATA_DIR、必需媒体工具跑 `python -m pytest tests/core tests/data tests/sidecar tests/cli -q`：758 passed，124.43s。
- [x] 在 desktop 执行 `NODE_OPTIONS=--no-experimental-webstorage` 对应 PowerShell 环境下的 `npm.cmd test`（410 passed / 62 files / 79.19s）、`npm.cmd run build`；三项扩展测试与 20 项打包辅助测试通过。

## 任务 1：统一快照与会话边界

**Files:** 新建 `desktop/renderer/lib/appSession.ts` 及 `.test.ts`；修改 `main.tsx`、`store/appStore.ts`、`store/appStoreSnapshot.test.ts`、`lib/addFlow.ts` 及测试、`components/Shell.tsx` 及测试、`components/task/useTaskCommands.ts` 及新测试、`SettingsApp.tsx` 及新异步回归。

**Interfaces:**

- `startAppSession(api: AppSessionApi): () => void` 管理主窗口订阅，返回清理函数；API 使用现有 request/onEvent/onState/getConnectionState/getLogDir。
- `useAppStore.getState().invalidateSnapshotRequests(): void` 使旧连接/已卸载请求失效，但不清空已知任务。
- 所有刷新统一调用现有 `refreshSnapshot(load: () => Promise<AppSnapshot>): Promise<void>`；设置窗口保留轻量 settings.get 并用本地 generation 防止旧响应覆盖事件/草稿。

- [x] **RED：** 每个刷新入口加入真实 store + 延迟 Promise 用例；启动连接查询晚到、停止后回复、拒绝、较新设置事件和保存中继续输入都要覆盖。

```ts
let resolve: (snapshot: AppSnapshot) => void = () => undefined;
const response = new Promise<AppSnapshot>((finish) => { resolve = finish; });
const refresh = useAppStore.getState().refreshSnapshot(() => response);
useAppStore.getState().invalidateSnapshotRequests();
resolve({ tasks: [], settings });
await refresh;
expect(useAppStore.getState().tasks).toEqual(previousTasks);
```

测试使用手写 deferred helper，兼容既有 TypeScript lib 与 Node 20，不升级依赖。

- [x] 跑 `npm.cmd test -- --run renderer/lib/appSession.test.ts renderer/store/appStoreSnapshot.test.ts renderer/lib/addFlow.test.ts renderer/components/Shell.test.tsx renderer/components/task/useTaskCommands.test.tsx`，确认是竞态/缺失方法导致 RED。
- [x] 最小实现，去掉剩余异步直接 hydrate，给拒绝完整 catch。源码核对发现 health 来自 Main 的异步请求，不是同步启动边界；仅将其用作受保护刷新的通知，绝不直接应用其中旧快照。

```ts
await useAppStore.getState().refreshSnapshot(() => request<AppSnapshot>("app.getSnapshot"));
```

- [x] 操作失败显示安全错误；创建已成功而刷新失败只提示队列正在同步，不重复创建任务、不把结果误报为添加失败。
- [x] GREEN 后检查 `rg -n hydrateSnapshot desktop/renderer`：仅允许 store/test，不允许 await/then 后或 health 通知中无保护覆盖。
- [x] 记录测试与逻辑检查点，不提交。

## 任务 2：旧格式数据与包测试隔离

**Files:** 新建 `tests/fixtures/upgrades/v0.2.1/schema.sql`、`config.json`、`provenance.json`、`scripts/legacy_upgrade_fixture.py`、`tests/data/test_version_upgrade.py`；修改 `scripts/package_smoke_helpers.mjs`、`.test.mjs`、`scripts/test_packaged_electron.mjs`；必要的兼容修复仅在 `src/data/queue_store.py`、`src/data/json_config.py`、`src/data/database.py` 的已复现位置。

**Interfaces:** `seed_legacy_upgrade_data(root: Path) -> dict` 仅使用 stdlib 与去敏 fixture，返回 DB/config/output 路径、任务 ID 和预期成品哈希；可供源码测试和包级测试共同使用，不导入当前产品模型。

- [x] 从本地 v0.2.1 tag 的实际数据模块在全新隔离目录生成 schema/config，记录 tag commit 和源码哈希；不读取日常用户数据，不访问网络。
- [x] fixture 去除绝对个人路径；运行时以 root 替换下载/成品路径。覆盖六态、分组、优先级、已完成历史、Telegram 已发送/失败/不确定记录、路由及精确字符串偏移量。
- [x] 新旧结构迁移使用真实 SQLite；测试运行不依赖 git、旧 tag 或网络。

```python
fixture = seed_legacy_upgrade_data(tmp_path)
store = QueueStore(str(fixture["database"]))
first = store.load_tasks()
second = QueueStore(str(fixture["database"])).load_tasks()
assert {task.id for task in first} == set(fixture["task_ids"])
assert [(task.id, task.status) for task in first] == [(task.id, task.status) for task in second]
assert file_hash(fixture["completed_path"]) == fixture["completed_sha256"]
```

`file_hash` 在测试中使用 hashlib.sha256 计算 fixture 文件；完整断言还检查 settings 未知键、下载选项、历史和 Telegram 表。现有行为已正确时记 characterization GREEN，不虚构 RED 或修改稳定代码。

- [x] `python -m pytest tests/data/test_version_upgrade.py tests/data/test_queue_store.py tests/data/test_json_config.py tests/core/test_queue_restore.py -q`；真实缺陷必须先失败再修复。
- [x] 新增 `prepareSmokeData(dataRoot: string): { dataDir: string; outputDir: string }` 辅助函数：创建缺失配置时将下载输出放入 dataRoot；现有配置不覆盖，不允许测试输出逃离数据根。
- [x] 辅助测试先证明默认缺失输出隔离与覆盖风险，再修复 Electron smoke；跑 `node --test scripts/package_smoke_helpers.test.mjs scripts/test_packaged_media_tools.test.mjs`。
- [x] 记录旧格式来源与 GREEN，保留全部证据，不提交。

## 任务 3：关键路径语言与安全结果

**Files:** `desktop/renderer/i18n.ts`；新建 `locales/zh-CN.ts`、`locales/en.ts`、`i18n.test.tsx`；修改既有 `lib/format.ts`、`lib/taskActionReport.ts`、`lib/addFlow.ts`、`components/ConnectionGate.tsx`、`components/AddConfirmDialog.tsx`、`components/PlaylistGroupCard.tsx`、`components/QueueOrderControls.tsx`、`components/shell/ActionBar.tsx`、`components/task/{taskPresentation,failureRecovery,TaskActionsMenu,MediaTaskBanner,useTaskCommands}` 与 `SettingsApp.tsx` 及对应测试。

**Interfaces:** 现有 `getLocale/setLocale/t` 保持兼容；增加 `useLocale(): Locale` 与可选插值参数 `t(key, locale, values)`；中文目录键决定英文目录完整性。任务动作/失败/状态保持原结构化值，只翻译展示。

- [x] RED：英文任务状态、暂停/恢复计数、失败恢复动作、分组/排序、确认添加和诊断/更新按钮；localStorage 的跨窗口 storage 事件使已挂载组件改变语言。

```tsx
localStorage.setItem("downany.locale", "en");
window.dispatchEvent(new StorageEvent("storage", { key: "downany.locale" }));
expect(screen.getByRole("button", { name: "Export diagnostics" })).toBeInTheDocument();
expect(screen.queryByText("electron-updater")).not.toBeInTheDocument();
```

- [x] 将目录从 i18n.ts 拆为纯数据模块；共享语言订阅只注册必要的 window 监听，组件卸载后释放。语言存储失败不使点击抛错。
- [x] 主路径用相同键，动态计数/标题通过插值；不翻译用户输入和 URL，不改变任务动作语义。保留默认中文原测试。
- [x] 用包含假 Cookie/URL/本地路径的拒绝消息测试普通错误提示，要求不出现在页面；更新/诊断使用结构化结果与安全回退。
- [x] 设置更新说明只告诉用户检查和下载安装的结果，删除内部库/开发文档说明；不宣称自动安装或已签名。
- [x] 跑关键组件、i18n/状态/失败恢复测试与生产构建；自动化检查英文关键按钮在最小窗口宽度仍可操作，不要求用户手工验收。
- [x] 记录覆盖范围和未翻译的低频/原生菜单，不提交。

## 任务 4：版本、回归入口与事实文档

**Files:** `desktop/package.json`、`desktop/package-lock.json`、`src/sidecar/protocol.py`、相关版本合同测试；`README.md`、`docs/roadmap.md`、`docs/RELEASE.md`、`browser-extension/README.md`；新建 `docs/RELEASE-NOTES-0.3.0.md`、`docs/acceptance/v0.3.0-stable-baseline.md`；官网只在事实确实不一致时调整对应文字并跑其既有测试。

- [x] 版本合同先 RED，统一桌面/锁文件根/Sidecar 为 0.3.0；扩展继续使用 manifest 的独立版本，不为对齐桌面号而改动。
- [x] 对照本地实现核对入口/能力表，把历史公开版本描述与当前本地候选分开；不声称本轮已上传或已部署网站。
- [x] 合并回归入口记录，旧版本证据保持历史用途；不删除历史测试或产物来制造通过率。
- [x] 独立只读代码审查在打包前执行；每项有证据的问题完成 RED→最小修复→回归。按用户授权保留分支，不做集成菜单询问。

## 任务 5：完整门槛与同源候选

**Files:** `scripts/test_packaged_queue_recovery.py`（保留默认 v0.2.4→v0.2.5 行为，增加显式目标/来源版本参数）、新建 `scripts/test_packaged_legacy_upgrade.py`；`.build/v030-execution/` 原始证据及验收文档。

**Interfaces:** 现有 `run_gate` 的版本参数默认为原合同；新增 CLI `--expected-version=0.3.0 --previous-version=0.2.5`。旧格式包级脚本只通过已打包 Sidecar 协议与 SQLite 只读查询检查迁移，不导入当前 manager。

- [x] 新脚本/参数合同测试先运行；新版本包验证必须断言 hello/asar/版本文件是 0.3.0，不能只检查进程存在。
- [x] 在同一最终源码上顺序跑完整 Python（强制媒体集成）、桌面全量、生产构建、扩展三脚本、打包辅助测试和 `git diff --check`。
- [x] 构建一次 onedir Sidecar；记录源码/资源清单。然后以本地 Electron、npmRebuild=false、`--publish never` 构建 `desktop/release-v0.3.0-stable-baseline/`，构建扩展 ZIP 并逐成员核对。
- [x] 包内媒体工具/握手/诊断通过；以真实 v0.2.5 包生成的数据运行五轮本地 HTTP 下载恢复；另以 v0.2.1 源码生成的旧格式 fixture 验证数据保留。两类证据分别标注。
- [x] Electron 隔离配置/输出/浏览器数据入队验证；跳过协议注册，核对测试前后协议关联和已有核心文件；只结束自己创建的子进程。
- [x] 检查版本、产物大小/SHA-256、扩展成员、未签名/云端模式、旧候选未变、无凭据/数据库/下载产物暂存。填写结果后形成 v0.3.0 本地候选；公开交付和人工检查保留未执行边界。

## 自检

任务 1 覆盖请求/连接与关键设置竞态，任务 2 覆盖旧数据和测试输出隔离，任务 3 覆盖关键语言与安全提示，任务 4 覆盖事实/版本，任务 5 覆盖同源真实包与证据。范围不包含新账户、付费、自动安装、Mac 工作或远程发布。无需等待用户重复审批安全本地实现。
