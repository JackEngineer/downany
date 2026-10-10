# Downany v0.3.0 稳定基线收口 Execution Index

> **For Codex:** Use `superpowers:executing-plans` to execute each linked plan task-by-task. Re-read the current `AGENTS.md` before every implementation branch. Use `publishing-downany-releases` before any release or release verification work.

**Goal:** 在不建立长期 `v0.3.0` 分支的前提下，把已经验收的 `v0.2.2` 至 `v0.2.5` 能力收口为可从旧版本升级、关键路径双语一致、Windows 可见验收且 NSIS/扩展 ZIP 同源的 `v0.3.0` 稳定基线。

**Architecture:** 保持 Electron Main + preload IPC + React Renderer + Python Sidecar + yt-dlp 单一主线。升级兼容继续依赖各存储组件的幂等默认值和列迁移，由历史资料夹具证明合同；只有失败测试证明现有组件无法安全升级时，才在对应组件内做最小修复。产品一致性和发布交付分别使用独立短分支，避免把文案、迁移和远程发布揉成不可审查的大提交。

**Tech Stack:** Python 3.11、pytest、SQLite、TypeScript、React 18、Vitest、Electron 33、Node.js 20、Vite、Electron Builder、GitHub Actions、GitHub CLI。

**Spec:** `docs/superpowers/specs/2026-08-26-downany-v0-3-staged-upgrade-design.md`

## Global Constraints

- **用户范围调整（2026-08-27）：** 先读 `docs/superpowers/specs/2026-08-27-downany-windows-execution-scope.md`。本任务只负责 Windows 与扩展；不执行或等待 Mac 构建/验收，保留现有 Mac 实现和历史资产。

- 按用户最新要求取消人工验收前置条件。入口条件改为可追溯的 `v0.2.4` 候选自动化基线和按计划完成的 `v0.2.5` 本地增量；未授权集成时使用逐阶段核对的源码快照，不执行或伪称 merge，不从不明来源拼装版本。
- 一个计划使用一个短分支；每次从当时最新、已验证的 `main` 创建，不维护长期里程碑分支。
- 不重新实现播放列表、错误恢复、诊断、队列或 Telegram；先用合同与历史夹具找真实缺口。
- `DOWNANY_DATA_DIR` 只用于隔离自动化和候选验收；正式升级仍要在真实 Windows 用户路径上验证。
- Cookie、Token、Telegram 凭据、代理认证、本地绝对路径和未脱敏响应不得进入夹具、提交、日志、诊断包或验收文档。
- 公开说明不得出现已经要求移除的成人站点支持描述；内部平台键、匹配、Referer、URL 和功能回归保持不变。
- 无证书时继续明确说明未签名、SmartScreen、Gatekeeper 与手动更新，不把构建成功写成签名或自动替换更新成功。
- 本地实现、测试、候选构建和验收不授权 merge、push、tag、CI dispatch、Release 草稿、资产上传或公开发布。
- 远程阶段最多设置两个必要授权点：一是精确列出 main push、annotated tag、tag CI、草稿和上传；二是草稿资产验证完成后的公开发布。未经授权保持本地候选。

## 已审计事实与设计选择

1. `v0.2.1` 与 `v0.2.4` 使用同一数据根、`config.json`、`history.db` 和 `telegram/bot-token.v1`；当前支持范围不需要凭空新增全局迁移服务。
2. `HistoryDB`、`QueueStore` 和 `TelegramDeliveryStore` 各自执行幂等建表/加列；`JsonConfig` 通过默认值合并兼容新增设置。升级计划用历史 SQL/JSON 夹具验证这些合同，并只修复失败点。
3. 当前英语目录只覆盖导航、添加、搜索和少量设置；失败恢复、播放列表、更新、诊断和 Telegram 等关键路径仍大量硬编码中文。
4. README 已描述部分现有能力，但旧路线图仍把播放列表、诊断等写成未来能力；官网还把 Telegram 写成“随下一版本提供”。公开事实需要由可测试的产品事实合同约束。
5. 原有标签 CI 构建 DMG/NSIS，扩展尚无同标签可下载 ZIP。当前 Windows 交付范围要求 annotated tag、同源 NSIS/扩展 ZIP、草稿全量下载验真后再公开；现有 Mac CI 不删除，也不作为本任务的交付依赖。

## 执行顺序

| 阶段 | 计划 | 用户可见结果 | 进入下一阶段的硬门槛 |
|---|---|---|---|
| A | [`2026-08-27-downany-v0-3-upgrade-migration.md`](2026-08-27-downany-v0-3-upgrade-migration.md) | 从 `v0.2.1` 或最近 `v0.2.x` 升级后保留设置、队列、历史和 Telegram 状态 | 两代历史夹具、幂等重开、打包 Sidecar、Windows 真实升级证据均通过 |
| B | [`2026-08-27-downany-v0-3-product-consistency.md`](2026-08-27-downany-v0-3-product-consistency.md) | 获取、下载、失败恢复、播放列表、更新、诊断关键路径中英文一致，公开载体陈述同一事实 | 类型化双语目录、关键路径组件测试、公开事实扫描、官网/扩展构建均通过 |
| C | [`2026-08-27-downany-v0-3-release-convergence.md`](2026-08-27-downany-v0-3-release-convergence.md) | 同一源码产生 Windows NSIS 和扩展 ZIP，Windows 核心链路可见通过 | 自动化、真实 URL、旧版升级、包内冒烟、两资产 SHA256 和公开匿名下载全部通过 |

阶段 A、B 可分别开发和审查，但阶段 C 只能从两者都已获授权集成后的 `main` 开始。若 A 或 B 暴露阻断缺陷，修复留在对应短分支，不在发布分支里顺手修产品逻辑。

## 执行检查点

- [ ] **Step 1: 以 v0.2.4 候选源码建立自动化基线并继续 v0.2.5**

使用 `docs/acceptance/v0.2.4-output-correctness.md` 保留历史证据。用户已进一步明确“继续往后面做，不用手动验收”，不再等待安装版手动启动，不重装现有应用。独立工作区核对候选源码并重新跑自动化后进入步骤 2；人工检查标记为用户取消要求，不标记为通过。

**2026-08-27 范围调整前的执行记录：** 用户已明确确认并完成 `0.1.0 → 0.2.4` 最新 Windows 候选覆盖安装；安装文件同一性、原配置/历史/队列保留、正常首次启动和正常退出已有证据，不再重复请求这次安装授权。退出后的桌面控制工具启动操作超时，当前未观察到安装版新进程，安装态重启及后续完整旅程仍未通过。已补齐两条最终成品大小的真实 SQLite 重建回归，旧模块红灯、当前源码绿灯和独立复审均完成，最新完整 Python 回归为 394 passed in 49.42s；本次没有修改生产源码或安装包。自动化结果不替代剩余 Windows/macOS 可见验收。详细事实以 `fix/v0.2.4-output-correctness` 候选工作树中的验收记录为准；此步骤仍未完成，不能据此进入步骤 2。

**2026-08-27 范围调整前的阻塞记录：** `13:17:57` 的只读检查仍显示已安装 `0.2.4`，配置与 `app.asar` 哈希不变，应用、Sidecar、候选安装器进程及 `17888` 监听均为 0。当前可用项目主机只有本地 Windows，未提供本任务可用的 Apple Silicon macOS 环境。自本次安装获准恢复执行以来，同一实机验收条件已连续三轮未解除；可独立完成的真实存储回归已在上一轮完成，本轮未重试超时启动、重跑测试或修改产品。后续须先恢复安装版普通桌面启动，并补齐 Mac 实机条件；在此之前暂停自动推进，保留全部工作树、候选与备份，不进入步骤 2，也不将目标标为完成。

**最新范围已调整：** 用户随后明确“mac你不用管”。上述 Mac 前置条件已取消，后续不再要求 Mac 主机、DMG 或 Mac 实机结果。Windows 自动重启与完整旅程仍需真实完成；候选、源代码和备份全部保留。

**2026-08-27 19:10 Windows 复核：** 本轮检查未发现会强制 Electron 进入 Node 模式的环境变量，也没有检索到匹配的当日应用错误事件；这些检查未确定此前启动超时的根因。资源管理器窗口虽已可读取，但地址栏操作分别遇到 `coordinate input geometry is unavailable` 和 UIA `CacheRequest` 属性错误，已停止输入。安装文件与用户配置哈希不变，Downany/Sidecar 进程和 `17888` 监听仍为 0。未重复安装、未修改生产代码或重跑已通过的回归；需先恢复安装版普通桌面启动，不能把控制接口错误写成产品崩溃或验收通过。

- [ ] **Step 2: 完成并验证 v0.2.5**

执行 `docs/superpowers/plans/2026-08-27-downany-v0-2-5-queue-recovery-stability.md`。完成后必须有精确源码 SHA、测试结果、候选产物哈希和 Windows 可见证据；本地完成不自动授权集成或发布。

- [ ] **Step 3: 执行阶段 A**

从已集成的最新 `main` 创建 `fix/v0-3-profile-upgrade`，执行升级迁移计划。只在历史夹具产生 RED 时修改产品存储代码。

- [ ] **Step 4: 执行阶段 B**

从包含阶段 A 的最新 `main` 创建 `chore/v0-3-product-consistency`，执行产品一致性计划。界面文案使用真实用户对象、动作、状态和结果，不出现实现链路或计划语言。

- [ ] **Step 5: 执行阶段 C 的本地候选部分**

从包含阶段 A/B 的最新 `main` 创建 `chore/v0-3-release-convergence`。完成版本合同、CI 产物合同、本地全回归和可执行的 Windows 验收，停在远程边界前。

- [ ] **Step 6: 仅在精确授权后执行远程发布阶段**

按发布计划记录准确的分支、提交 SHA、tag、远程动作和草稿状态。任何不确定响应先读取 GitHub 状态再决定，不盲目重试。草稿验真和公开发布使用分开的授权节点。

- [ ] **Step 7: 按四层证据判定 v0.3.0**

四层必须同时成立：合同测试、生产构建测试、Windows 可见运行验收、公开交付验证。缺任一层时只能称为相应层级的候选，不能称为 `v0.3.0` 已发布。

## Interfaces

**Interfaces:** consumes the approved staged design, the accepted v0.2.4/v0.2.5 baselines, and the three linked implementation plans; produces an ordered set of short branches, explicit evidence gates, and a two-stage remote authorization boundary without creating any product or remote state by itself.

## 完成定义

- 三个计划分别完成，且每个计划的证据来自执行时的当前代码而非旧工作树推断。
- `main` 的最终源码 SHA 同时对应桌面端 `0.3.0`、Sidecar `0.3.0`、记录在案的扩展版本和 NSIS/扩展 ZIP。
- `v0.2.1 → v0.3.0` 与最近 `v0.2.x → v0.3.0` 在 Windows 上保留规定数据。
- 关键用户路径双语合同和公开产品事实合同持续进入 CI。
- 固定真实 URL 回归没有阻断缺陷，预期失败均给出正确且可执行的用户动作。
- GitHub Release 非草稿、非预发布，两个匿名直链完整下载后 SHA256 与已记录值一致，`releases/latest` 指向 `v0.3.0`。
- 若远程授权未获得，完成状态明确停留在“本地候选”，不降低门槛、不省略 Windows 或扩展验证、不把草稿写成公开版本。
