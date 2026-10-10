# AGENTS.md — Agent 指引

## 项目与版本依据

Downany · 百纳是 macOS / Windows 视频下载应用，唯一产品主线为 **Electron + Python Sidecar + yt-dlp**。不再引入已删除的 PyQt、SwiftUI 或 `legacy/` 旁线。

- 本检出桌面端与 Sidecar 版本为 `0.3.2`，Chrome 扩展独立版本为 `0.9.2`。分别以 `desktop/package.json`、`src/sidecar/protocol.py` 和 `browser-extension/manifest.json` 为准；根目录 `package.json` 的版本不是应用发行版本。
- 2026-10-10 文档核对时，公开稳定版为 [v0.3.2](https://github.com/JackEngineer/downany/releases/tag/v0.3.2)，包含双平台 cloud-only 安装包与扩展 `0.9.2`。公开状态以 [GitHub Releases](https://github.com/JackEngineer/downany/releases) 为准，不根据旧验收文件或本地版本推断 Latest。
- 当前变化见 [v0.3.2 发布说明](docs/RELEASE-NOTES-0.3.2.md)；[发布准备记录](docs/acceptance/v0.3.2-release-readiness.md) 保留该轮预检与历史边界，不替代公开发行核验。[发布指南](docs/RELEASE.md) 保留 v0.3.0 双平台发行基线；[v0.3.1 Mac 候选说明](docs/RELEASE-NOTES-0.3.1-MAC-CANDIDATE.md) 与 [Windows 交接](docs/WINDOWS-0.3.1-HANDOFF.md) 记录该轮候选范围，不代表此后发行状态。当前发行的已知限制以对应 Release 说明为准；旧包哈希、扩展版本及未执行项不能套用到新包。

## 仓库结构

```text
desktop/electron/    # Main、Preload、Sidecar 托管、扩展桥、引擎更新、Telegram
desktop/renderer/    # React 主窗口、设置、状态与中英文文案
src/sidecar/         # 引擎入口、JSON Lines 协议、handlers、迁移、诊断、更新
src/core/            # 下载调度、解析、输出合同、媒体校验、yt-dlp 运行时
src/data/            # SQLite、JsonConfig、队列、Telegram 发送记录
src/cli/             # scripts/downany 的 CLI 实现
browser-extension/   # Chrome MV3、媒体检测、网页解析、入队回执与任务反馈
native/process-host/ # Telegram 本地进程托管器
packaging/           # Sidecar onedir、FFmpeg 与 Telegram 源码/归档锁
scripts/             # 构建、扩展打包、包级 smoke、升级与可靠性验收
website/             # 官网；改动同时遵循 website/AGENTS.md
design-system/       # 共享设计资源
docs/acceptance/     # 带候选身份的历史验收记录
tests/{core,data,sidecar,cli}/
```

## 开发命令

CI 使用 **Python 3.11、Node.js 20**。优先沿用锁文件安装依赖；Windows 使用 `npm.cmd`，Python 明确指向仓库 `venv`，避免不同解释器混用。

### Windows / PowerShell

在仓库根执行；不需要先激活虚拟环境。已有 `venv` 时跳过创建。

```powershell
py -3.11 -m venv venv
& .\venv\Scripts\python.exe -m pip install -r requirements-dev.txt
$env:DOWNANY_PYTHON = (Resolve-Path .\venv\Scripts\python.exe).Path
npm.cmd --prefix desktop ci
npm.cmd --prefix desktop run dev
```

已有生产构建时，可用 `npm.cmd --prefix desktop start` 启动 Electron。根目录 `npm start` 调用 Bash 脚本；`install_env.sh`、`build_sidecar.sh` 也不是原生 PowerShell 入口。开发态 Sidecar 由 Main 使用 `venv\Scripts\python.exe -m src.sidecar` 拉起；单独运行需提供双向 JSON Lines 握手，不能把等待 stdin 当作启动失败。

### macOS / shell

```bash
./scripts/install_env.sh
source venv/bin/activate
npm --prefix desktop ci
npm --prefix desktop run dev
# 仓库根也可 npm run desktop 或 ./scripts/start_app.sh
```

项目发行目标为 macOS Apple Silicon 与 Windows x64；Linux shell 命令不代表存在 Linux 安装包或验收承诺。

## 验证命令与证据边界

Windows 在仓库根执行基础回归：

```powershell
& .\venv\Scripts\python.exe -m pytest tests/core tests/data tests/sidecar tests/cli -q
npm.cmd --prefix desktop test
npm.cmd --prefix desktop run build
node --test browser-extension/shared.test.js browser-extension/sniff-core.test.js browser-extension/bridge-timeout.test.js browser-extension/install-ui.test.js browser-extension/delivery-state.test.js
node --test scripts/package_smoke_helpers.test.mjs scripts/test_packaged_media_tools.test.mjs scripts/windows_media_lock.test.mjs
```

macOS 对应使用 `venv/bin/python` 和 `npm`。`build` 已包含 Main / Renderer 类型检查；仅做类型检查可运行 `npm.cmd --prefix desktop run typecheck`。修改验收器、打包或更新链路时，补跑相应 `scripts/*.test.mjs` 和组件定向测试。

- 媒体集成先准备已核对的 FFmpeg / FFprobe，设置 `DOWNANY_BIN_DIR` 与 `DOWNANY_REQUIRE_MEDIA_INTEGRATION=1` 后运行 `tests/core/test_media_pipeline_integration.py`；跳过不算通过。
- 布局检查：`npm.cmd --prefix desktop run test:electron-layout:unit`、`npm.cmd --prefix desktop run test:electron-layout`。后者生成 development 展示构建，打包前必须重新运行生产 `build`。
- 宿主 Node 25 若因 Web Storage 导致 Vitest 失败，可仅在该次宿主测试设置 `NODE_OPTIONS=--no-experimental-webstorage`，测试后移除；不要把该参数传给 Electron，优先使用 CI 的 Node 20。
- 源码测试、构建成功、包内 smoke、安装升级、真实网站下载、人工操作和公开交付是不同证据，按实际执行分别记录。macOS 结果不能记作 Windows 通过；旧包与旧扩展的原生交互结果不能记作新版本通过。
- 自动验收使用新建隔离数据目录、Electron profile、输出目录和临时桥端口，设置 `DOWNANY_SKIP_PROTOCOL_REGISTRATION=1`。不得读写日常数据库、下载目录或为了首次安装删用户数据。
- Windows NSIS 安装、卸载和协议注册会影响账户状态，仅换安装目录不足以隔离；优先用专用测试环境，参见 [Windows 交接](docs/WINDOWS-0.3.1-HANDOFF.md)。

## 架构与行为合同

### Sidecar 与进程生命周期

- Renderer 只经 Preload IPC 访问 Main；Main 拉起并监护 Sidecar。stdout 只写完整 UTF-8 JSON Lines 协议消息，日志走 stderr；协议行需串行写入，不能混入日志或调试输出。
- `src/sidecar/entrypoint.py` 先选择并激活引擎，再导入实际下载/解析消费者。Sidecar 提前发送 `hello` 并完成双向握手，再迁移和恢复队列；Main 在握手完成前拒绝业务请求，不能用任意查询占用首条握手消息。
- `desktop/electron/sidecar.ts` 管理心跳、有限退避重连、受控重启和退出。退出必须等待旧进程，按所属 PID 收尾进程树，阻止旧回调重新拉起或误伤新进程；不要按进程名清理所有 Python / FFmpeg。
- 应用退出先停止接收新工作与更新操作，完成 Telegram worker 的 lease/终态写入，再关闭 Sidecar；连续退出等待同一清理过程。不要把 shutdown 响应等同于解析子进程全部结束。
- 发布 Sidecar 必须为 PyInstaller **onedir**。Windows 路径为 `resources/sidecar/DownanySidecar/DownanySidecar.exe`；macOS 为 `Downany.app/Contents/Resources/sidecar/DownanySidecar/DownanySidecar`。代码中的 onefile 兼容回退不是新包方案。

### 队列、输出与恢复

- `src/core/download_manager.py` 维护六态任务机、调度锁、持久化意图和恢复；失败须向上传递，不能用空成功结果吞掉异常。状态与进度事件不得在终态、删除或重连后倒退。
- 暂停是中断下载并保留恢复意图，再入队时依赖 yt-dlp 续传。重试保留任务的画质、输出目录、格式、音频与后处理选项；恢复所需的代理、浏览器登录状态等采用当前设置，扩展 Cookie / headers 遵循任务来源规则。
- 单条实际下载仍默认 `noplaylist: True`；集合能力已由入队前解析、选集与分组处理，不应全局改为自动下载整份播放列表，也不能按旧路线图声称集合尚未实现。
- 任务与历史共用显示排序偏好，独立保存在 Renderer 存储，重启后恢复；它不改变下载队列的优先级与调度顺序。
- 输出计划、路径、媒体校验和提交集中在 `output_contract.py`、`output_paths.py`、`media_verifier.py`、`output_commit.py`。最终媒体与附属文件安全提交后再更新完成状态/历史；保持已有文件不覆盖、成品大小可追溯及失败回滚。
- 修改 `options_json`、队列或发送记录时必须保留旧数据兼容。下载完成与 Telegram 发送结果独立持久化；本地发送模式需要匹配的 Bot API、ProcessHost 与构建凭据，不能仅凭资源目录存在宣称就绪。

### 数据、媒体与扩展桥

- 数据：macOS `~/Library/Application Support/Downany/`，Windows `%LOCALAPPDATA%\Downany`；日志分别为 `~/Library/Logs/Downany/` 与 `%LOCALAPPDATA%\Downany\logs`。`DOWNANY_DATA_DIR` 覆盖数据路径，日志随之进入 `<data>/logs`。
- `DOWNANY_PYTHON` 指定开发解释器，`DOWNANY_BIN_DIR` 指定媒体工具；旧 `VIDEODL_*` 仅用于兼容。Main 存在打包资源时会选择 `resources/bin`，验收以实际运行路径为准。
- `migration.py` 兼容旧 Trae / VideoDownloader 数据；新路径和产物使用 Downany / 百纳。隔离验收要防止旧个人数据自动迁入测试目录。
- 扩展默认桥为 `127.0.0.1:17888`，桌面端须先运行且 Sidecar 就绪。`DOWNANY_BRIDGE_PORT=0` 可让隔离执行器获取临时端口；正常 Chrome 扩展仍访问固定端口，不能拿临时端口 smoke 代替扩展实测。
- 扩展已区分检测媒体与网页解析，支持批量入队回执、任务状态、显式重试/定位；相关合同见 `bridgeServer.ts`、`browser-extension/shared.js` 与 `delivery-state.js`。不要把 HTTP 收到请求当作桌面任务创建成功；失败重试须保留原选项并防重复。
- Cookie、授权网址、Telegram token、凭据、个人路径和原始诊断只在授权范围内处理，不写入提交、公开证据或聊天输出。人工登录及系统权限提示交给用户，不导出 Chrome 凭据绕过限制。

## 下载工具更新

下载工具更新与应用安装包更新分开维护，完整流程见 [ENGINE-UPDATES.md](docs/ENGINE-UPDATES.md)。

- 下载工具仅取 `yt-dlp/yt-dlp` 官方稳定归档及同版本校验清单；检查来源、重定向、大小、SHA-256、归档结构、版本和独立进程自检，不接受 Renderer 传入任意下载地址。
- 准备写入 `engines/<sha256>/yt-dlp.zip` 与 `pending.json`，不改 `active.json`；下载、解析、搜索和 Telegram 工作忙碌时保持旧引擎。
- 启用由 Main 阻止新工作、冻结 Telegram 领取，并取得 Sidecar 空闲票据；将旧选择和目标写入 `activation.json`，原子切换活动指针，确认旧进程退出后启动新进程。
- 双向握手完成后核对实际运行版本、来源和 SHA-256，确认成功才清除事务/待启用记录。失败恢复旧选择并重启；无法确认恢复时继续阻止新工作，应用下次启动先恢复未完成事务。
- 下载线程、解析子进程、健康检查和诊断使用同一选定引擎；独立 CLI 版本或准备完成不代表产品已启用，也不代表某网站下载问题已解决。
- 应用更新仍由 `appUpdater.ts` 查询 GitHub 正式 Latest 并打开 Release 下载页；`DOWNANY_GITHUB_REPO` 可覆盖仓库，`DOWNANY_UPDATE_DISABLED=1` 可关闭检查。不要声称安装包已自动下载替换。

## 打包与发布门槛

构建或发布前重读 [RELEASE.md](docs/RELEASE.md)、本次版本说明、当前 CI 与适用验收记录；执行正式 Downany 发布时使用 `$publishing-downany-releases`。版本升级、推送 main、打标签、派发 CI、上传和正式发布分别按用户授权范围执行。

Windows cloud-only 候选在 Windows 原生 PowerShell 中构建：

```powershell
$env:DOWNANY_PYTHON = (Resolve-Path .\venv\Scripts\python.exe).Path
$env:BUILD_TELEGRAM_NATIVE = '0'
$env:ALLOW_CLOUD_ONLY_PACKAGE = '1'
.\scripts\build_windows_nsis.ps1
```

脚本会重建 `.build/sidecar`、`desktop/resources/sidecar` 和 `desktop/release`，构建前保存需要保留的候选与证据。默认脚本会要求/构建 Telegram 原生资源，缺凭据时不要直接使用默认值；cloud-only 不宣称本地 Bot API 的单文件 2 GB 能力。`FETCH_BINS=0`、`BUILD_SIDECAR=0` 只用于已有资源确实匹配本次候选的情况。

macOS 对应使用 `fetch_release_binaries.sh`、`build_sidecar.sh`、`build_macos_dmg.sh`；cloud-only 同样需显式设置 `BUILD_TELEGRAM_NATIVE=0 ALLOW_CLOUD_ONLY_PACKAGE=1`。Chrome ZIP 统一使用 `scripts/build_chrome_extension_zip.sh`，从 manifest 读版本，排除测试/隐藏文件并检查 ZIP；该脚本需要 Bash、Node.js、zip、unzip 和 shasum，Windows 没有这些工具时使用同一提交的 CI 工件。

- CI 对 macOS / Windows 跑 Python 与 desktop 测试，另测扩展并打 ZIP。`v*` 标签或 `workflow_dispatch` 才运行安装包任务；标签默认 cloud-only，手动 `package_mode=native` 才要求 Telegram 应用 Secrets。
- Windows 覆盖升级门禁在 `v*` 标签及 `workflow_dispatch` 的 Windows 安装包任务中执行；仍须核对该次升级结果，不能只凭打包成功判定通过。任何红色任务都要定位，不把部分成功当整次 CI 通过；CI 上传工件不等于 GitHub Release 已发布。
- FFmpeg / FFprobe 必须同源成对：Windows 来自同一已锁定并验证 SHA-256 的归档，macOS 来自同一源码锁。打包前和包内均运行媒体生成/探测 smoke，缺工具或版本不匹配阻止交付。
- 包级检查使用 `test_packaged_sidecar.mjs`、`test_packaged_media_tools.mjs`、`test_packaged_electron.mjs`；升级使用真实旧包生成数据，再验证新包保留设置/队列、非零 Range 恢复、完整解码与已有文件哈希不变。
- 每轮证据绑定本次源码、候选大小与 SHA-256，换包重新验证相关项。矩阵、清单和辅助器可能仍含历史版本要求，先核对再使用；不要挪用旧 `releaseReady` 或旧包完整矩阵。
- 完整双平台发行同一 tag 交付 macOS arm64 DMG、Windows x64 NSIS 与匹配源码的 Chrome ZIP。单平台候选必须符合明确范围和预发布标记，不因存在工程包就设为 Latest。
- 当前打包配置未做 Developer ID / Authenticode 签名或 Mac 公证；包内 smoke 不等于干净机器安装、Gatekeeper / SmartScreen 人工验收。官网、下载链接、资产与校验值按本次交付实证核验。

## 协作约定

- 界面文案表达真实用户的对象、动作、状态和结果，避免需求复述、实现说明、内部角色或 AI 生成过程。主要文案为中文，维护 `desktop/renderer/locales/zh-CN.ts` / `en.ts` 及相关测试，标识符用英文。
- 不随意新增内联 import；引擎入口必须在激活后延迟导入消费者，这是运行时选择所需的既有例外。TypeScript 对 enum / union 使用 exhaustive `never` switch。
- 修改前检查 `git status` 与现有差异；保留用户的 tracked / untracked WIP，尤其 `docs/superpowers/` 规划文件。提交仅含本次工作，文档更新不隐含提交、push 或发版授权。
- 不提交 `desktop/release/`、`desktop/resources/` 生成资源、`.build/`、`venv/`、`bin/`、用户数据、下载成品或凭据。清理 Windows worktree 前先检查 Junction / reparse point 及实际目标，不能递归删除到外部目录。
- 分支沿用 `feat/m{N}-{slug}` / `chore/{slug}` / `fix/{slug}` / `spike/{slug}`，见 [BRANCHING.md](docs/BRANCHING.md)。
- [roadmap.md](docs/roadmap.md) 保留早期差距与阶段快照，不能用历史“尚未实现”覆盖当前代码；验收范围以本轮明确指令与对应版本文件为准。v0.3.1 Windows 交接已取消五人首次试用，不把旧模板空项自动加入新任务门槛。

用户使用说明见 [README.md](README.md)，Telegram 云端/本地模式与限制见 [TELEGRAM.md](docs/TELEGRAM.md)。
