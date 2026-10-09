# 下载工具更新

适用于 v0.3.1 开发分支。候选包与实机验证状态以 [验收记录](acceptance/v0.3.1-acceptance.md) 为准。

## 用户流程

1. 设置显示当前进程实际使用的下载工具版本。“检查更新”访问官方稳定版信息。
2. “下载并启用”准备更新。下载、解析、搜索和 Telegram 工作仍在进行时，只保留待启用版本，不中断任务。
3. 工作结束后点击“启用更新”。确认新进程实际版本后才显示成功；原下载目录、队列与成品保持不变。
4. 启用失败会恢复原选择并重新启动下载服务。无法确认恢复时暂停接收新工作并提示重启应用；重新打开设置仍保留提示。

下载工具更新与应用安装包更新分开。此功能不保证修复某个网站的登录、验证或提取问题。

## 准备与启用

- Python 后台任务只从 `yt-dlp/yt-dlp` 官方最新稳定 release 获取通用 `yt-dlp` 归档与同版本 `SHA2-256SUMS`。限制来源、重定向、大小与处理时间；不接受 Renderer 提供的下载地址。
- 在写入 `pending.json` 前检查 SHA-256、归档结构、版本和独立进程自检。自检使用当前 Python 或冻结 Sidecar，并导入实际下载与解析模块。准备不改写 `active.json`。
- 归档保存在数据目录 `engines/<sha256>/yt-dlp.zip`，发布时不覆盖已有归档。过期的待启用版本不会导致运行版本降级。
- Main 先阻止新增工作并冻结 Telegram 领取，再向 Sidecar 请求空闲票据。Sidecar 同时检查下载调度、解析、搜索、请求和发送状态；无法确认空闲时不切换。
- Main 将原选择和目标写入 `activation.json`，再原子替换活动指针。受控重启确认旧进程退出后启动新进程；完成双向握手前拒绝查询和业务请求，避免请求占用首条握手消息。随后核对实际版本、来源及 SHA-256，确认后清除事务记录和待启用记录。
- 启用失败时恢复旧选择并重启。进程或冻结状态无法确认时保持阻止新工作的状态；启动应用时，在启动 Sidecar 前恢复未完成事务的原选择。
- Sidecar 的解析子进程和下载线程使用同一个启动时选定的引擎。健康检查与诊断报告实际运行模块，不能用独立 CLI 版本替代。

## 维护与验证

主要代码：`src/core/ytdlp_runtime.py`、`src/sidecar/ytdlp_updater.py`、`src/sidecar/handlers.py`、`desktop/electron/engineUpdater.ts`。

```bash
venv/bin/python -m pytest tests/sidecar/test_engine_update_preparation.py tests/sidecar/test_engine_activation_gate.py tests/sidecar/test_engine_entrypoint.py -q
npm --prefix desktop test -- electron/engineUpdater.test.ts electron/quitSequence.test.ts renderer/SettingsApp.engineUpdate.test.tsx electron/telegram/controller.test.ts electron/telegram/deliveryWorker.test.ts
npm --prefix desktop run build
```

真实流程在隔离数据目录和 Electron profile 中验证：选择旧官方归档，通过设置下载准备新版，保持一个受控下载不结束以验证忙碌保护，完成下载后启用并核对实际身份、旧数据与新下载完整解码。冻结 Sidecar 另行执行官方准备、自检和重启验证。合成本机媒体结果不计入真实网站成功率；源码和冻结进程结果不替代最终安装包验收；macOS 包级结果不替代 Windows 实机及其安装包验收。

2026-09-27 已在基于 `62db270` 的 macOS DMG `f0f4a16b…` 中完成[实际设置页更新验证](acceptance/v0.3.1-macos-engine-update-results.json)：确认包内运行身份，官方检查和准备、忙碌时保留旧下载、空闲后启用、实际版本及 SHA 校验、待启用记录清理和新旧媒体完整解码均通过。原始归档仅用于选择旧版本，新归档由产品更新器下载和验证。后续验收工具提交 `25e9941`、`42f869a` 分别补齐 URL 摘要去重门禁和合集解析失败记录；`2409d4d` 进一步默认排除已确认的同内容别名；这些脚本改动不改变被测候选运行时的 `62db270` 身份。此项标记为 `candidateAutomation: true`、`fullReleaseAcceptance: false`、`manual: false`；同一包的[网站矩阵](acceptance/v0.3.1-macos-website-results.engine-update.r2.json)已记录全部 30 项，但现行合格数为 YouTube `7/9`、Bilibili `7/9`、抖音 `0/9`，登录场景 `0/6`。新 Windows 和人工验收仍未完成，不能据组件更新通过宣称抖音恢复。
