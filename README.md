# Downany · 百纳

面向 macOS 与 Windows 的视频下载应用。粘贴链接、选择合集中的视频，或从浏览器发送检测到的媒体，再在桌面端管理下载、字幕和历史记录。产品主线为 **Electron + React + Python Sidecar + yt-dlp**。

## 版本与下载

截至 **2026-10-10**，最新正式版为 [Downany v0.3.2](https://github.com/JackEngineer/downany/releases/tag/v0.3.2)，同时提供 Apple Silicon Mac、Windows x64 安装包与 Chrome 扩展 `0.9.2`。

| 用途 | 版本与入口 |
| --- | --- |
| 安装使用 | [v0.3.2 正式版](https://github.com/JackEngineer/downany/releases/tag/v0.3.2)；后续版本见 [GitHub Releases](https://github.com/JackEngineer/downany/releases) |
| 当前检出源码 | `desktop/package.json` 为 `0.3.1`，`browser-extension/manifest.json` 为 `0.9.2`；本检出尚未同步到 v0.3.2 |
| 历史基线 | [v0.3.0 发布说明](docs/RELEASE-NOTES-0.3.0.md) 与 [公开发布验收](docs/acceptance/v0.3.0-public-release.md) |
| 历史候选 | [v0.3.1 Mac 候选说明](docs/RELEASE-NOTES-0.3.1-MAC-CANDIDATE.md)、[验收记录](docs/acceptance/v0.3.1-acceptance.md)、[Windows 交接](docs/WINDOWS-0.3.1-HANDOFF.md)；结果只适用于各记录对应的源码和安装包 |

v0.3.2 保留 v0.3.1 的下载、失败恢复和扩展功能，并增加排序偏好的重启保留、任务移除失败提示及 Windows 早期中文诊断修正，收紧下载工具归档校验。正式版采用 **cloud-only** 模式，Telegram 使用官方云端 Bot API。

公开发行不代表所有网站场景已验收：v0.3.2 发布说明记录 Windows 网站矩阵完成 `9/30`，登录前后对照、合集与部分人工安装/扩展操作仍待验证；不宣称三站 90% 成功率。完整范围以该版本的 [发布说明](https://github.com/JackEngineer/downany/releases/tag/v0.3.2) 为准。

## 功能

- **链接与搜索**：单条或批量添加链接；识别 YouTube、Bilibili、抖音、TikTok、Twitter、Instagram 等平台；支持 YouTube、Bilibili 网络搜索。可下载内容以实际识别结果和访问权限为准。
- **合集与多 P**：展开后逐条勾选、全选、反选或按序号范围选择；按合集目录保存并保留分集序号。
- **队列与恢复**：设置并发、暂停、继续、取消和重试；保留队列顺序与暂停选择，支持整组操作、优先级和同优先级内调整顺序。失败或取消的任务不会自行重试。
- **输出与字幕**：视频或 MP3、画质、文件命名与字幕语言；字幕可独立保存、写入视频或同时保留。音频任务使用独立字幕，重复下载保留已有成品。
- **失败处理**：区分网络异常、需登录、登录状态读取失败、视频详情不可用、内容限制和下载位置问题；提供对应设置入口，重试保留原任务输出选项。
- **登录与网页识别**：可主动选择浏览器登录状态；遇到登录墙或媒体页面，可在内置窗口打开网页、播放并检测媒体后发送。网页可播放不保证能够下载。
- **任务与历史**：检索和排序、重新下载、打开文件及所在目录；历史与队列持久化到 SQLite。
- **设置与诊断**：下载目录、并发、限速、代理、主题、画质、字幕、下载工具更新和诊断导出。
- **Chrome 扩展**：区分检测媒体与网页解析，支持批量发送、发送回执、重复发送保护和近期任务进度。
- **Telegram 自动转发**：绑定 Bot、验证私聊/群组/频道，下载完成后自动发送并保留发送记录。用法及云端限制见 [Telegram 说明](docs/TELEGRAM.md)；本地 Bot API 的 2 GB 能力需另行构建和验收原生资源。
- **桌面集成与语言**：原生菜单、通知、窗口位置恢复、旧数据迁移；默认中文，English 覆盖主要下载与设置路径，部分低频设置和原生菜单仍为中文。

以上功能按当前检出代码整理；公开安装包的变更与验证范围见对应 Release。

## 安装与首次使用

| 产物 | 平台与安装方式 |
| --- | --- |
| `Downany-<ver>-mac.dmg` | Apple Silicon Mac；打开 DMG，将应用复制到 Applications |
| `Downany-<ver>-win-x64.exe` | Windows x64；按 NSIS 向导安装，可选择安装目录 |
| `Downany-chrome-extension-<ver>.zip` | 解压后在 `chrome://extensions` 开启开发者模式，加载解压目录 |

当前安装包未签名，Mac 未公证，首次运行可能显示 Gatekeeper 或 SmartScreen 提示。核对官方 Release 来源后按系统提示操作；系统阻止运行时保留具体提示，便于诊断。

启动桌面端后，确认下载位置可写，粘贴一条有权下载的视频链接，在添加窗口选择视频或音频、画质及条目后开始下载。完成后可从任务卡打开文件或所在目录。

### Chrome 扩展

先启动百纳，再打开视频页面并播放。在扩展弹窗中选择 **“下载检测媒体”** 或 **“解析本页视频”**；视频/MP3 输出可单独选择，网页解析还可设置画质上限。检测到的直链媒体使用其现有清晰度。

扩展通过 `127.0.0.1:17888` 与桌面端连接，显示连接状态、发送结果和任务进度。浏览器首次提示本地网络访问权限时需允许连接；断线时可重新检测，已注册 `downany://` 的桌面端可尝试唤醒。

当前扩展发送只附带公开 Referer，不读取浏览器 Cookie。桌面设置中的登录状态选择用于桌面解析与下载，不能视为扩展已取得登录权限。抖音视频详情读取失败会提示状态未知；可以尝试“网页识别”，实际检测到有效媒体后再下载。

开发时修改扩展后须在 `chrome://extensions` 重新加载。手动加载当前源码可选择 `browser-extension/`；更多细节见 [扩展说明](browser-extension/README.md)。macOS 的 `scripts/setup_chrome_extension.sh` 会重启主 Chrome，使用前保存浏览器中的工作。

### 应用与下载工具更新

- **应用更新**：“检查应用更新”查询最新正式 Release，“前往下载”打开下载页；当前不会自动替换安装包。
- **下载工具更新**：“下载并启用”从官方稳定版准备并检查更新。有下载、解析、搜索或 Telegram 工作未结束时保留当前版本，空闲后可“启用更新”。确认实际运行版本后才提示成功；失败会尝试恢复原版本，无法确认恢复时提示重启。

下载工具更新不会替换 Downany 安装包，也不保证解除网站登录或访问限制。维护及验证边界见 [下载工具更新说明](docs/ENGINE-UPDATES.md)。

## 本地开发

构建基线与 CI 一致：**Python 3.11、Node.js 20、npm**。主要交付平台为 macOS Apple Silicon 与 Windows x64；Linux 不在当前安装包交付范围。

### macOS

在仓库根目录执行：

```bash
./scripts/install_env.sh
source venv/bin/activate
cd desktop
npm ci
npm run dev
```

环境脚本创建 Python 虚拟环境并安装依赖，检查 FFmpeg 和 Deno。开发依赖安装完成后，也可在仓库根运行 `npm run desktop`。合并音视频和后处理需要可用的 FFmpeg / FFprobe。

### Windows（PowerShell）

在仓库根目录执行，无需激活虚拟环境或调用 shell 环境脚本：

```powershell
py -3.11 -m venv venv
.\venv\Scripts\python.exe -m pip install -r requirements-dev.txt
$env:DOWNANY_PYTHON = (Resolve-Path .\venv\Scripts\python.exe).Path
.\scripts\fetch_release_binaries.ps1
Set-Location desktop
npm.cmd ci
npm.cmd run dev
```

媒体工具脚本将经校验的 yt-dlp、FFmpeg / FFprobe 写入 `desktop/resources/bin/`。开发态默认 Python 为 `venv/Scripts/python.exe`（Windows）或 `venv/bin/python`（macOS）；使用其他环境时设置 `DOWNANY_PYTHON`。

### Sidecar 与 CLI

Sidecar 单独调试在仓库根执行，使用 JSON Lines 协议，stdout 只用于协议消息：

```bash
venv/bin/python -m src.sidecar
```

Windows 对应 `.\venv\Scripts\python.exe -m src.sidecar`。CLI 使用相同下载核心，可独立添加任务：

```bash
./scripts/downany add "<视频链接>" --quality 1080p
./scripts/downany add "<视频链接>" --audio
```

将示例中的 `<视频链接>` 替换为实际地址。Windows 可运行 `.\venv\Scripts\python.exe -m src.cli add "<视频链接>" --audio`。`--subs` 下载字幕，`--detach` 仅入队并打印任务 ID，不等待完成，也不启动常驻后台服务。

### 数据与日志

| 平台 | 数据目录 | 日志目录 |
| --- | --- | --- |
| macOS | `~/Library/Application Support/Downany/` | `~/Library/Logs/Downany/` |
| Windows | `%LOCALAPPDATA%\Downany` | `%LOCALAPPDATA%\Downany\logs` |

`DOWNANY_DATA_DIR` 覆盖数据目录后，日志写入该目录的 `logs/`。安装、迁移和恢复测试须使用隔离数据及 Electron profile，避免影响日常配置、队列和成品；具体步骤见 [Windows 候选交接](docs/WINDOWS-0.3.1-HANDOFF.md)。

## 仓库结构

```text
desktop/             # Electron Main / preload / React 界面
src/sidecar/         # JSON Lines 协议、迁移、诊断、引擎更新
src/core/            # 下载调度、解析、输出与失败处理
src/data/            # SQLite、配置、队列与发送记录
src/cli/             # CLI 入口
browser-extension/   # Chrome MV3 扩展与媒体检测
native/process-host/ # Telegram 本地进程托管（原生模式）
packaging/           # Sidecar onedir、平台媒体工具锁
scripts/             # 构建、打包与候选验收
website/             # 官网及下载入口
design-system/       # 共享设计资源
tests/               # Python 核心、数据、Sidecar 与 CLI 测试
docs/                # 设计、路线图、发布与验收记录
```

Electron Main 管理 Sidecar，Renderer 只经 preload IPC 发起操作。Sidecar 先完成双向握手，再执行迁移与队列恢复；打包采用 PyInstaller **onedir**。本仓库没有 PyQt / SwiftUI 产品旁线。

## 验证

Python（仓库根）：

```bash
venv/bin/python -m pytest tests/core tests/data tests/sidecar tests/cli -q
```

Windows 对应 `.\venv\Scripts\python.exe -m pytest tests/core tests/data tests/sidecar tests/cli -q`。

桌面端（`desktop/`）：

```bash
npm test
npm run build
npm run test:electron-layout:unit
```

Windows 使用 `npm.cmd`。`npm run build` 先检查 Main 与 Renderer 的 TypeScript 类型；真实窗口布局检查为 `npm run test:electron-layout`，它会生成开发构建，打包前须重新执行生产构建。宿主 Node 25 若触发 Vitest webstorage 兼容问题，可只为测试设置 `NODE_OPTIONS=--no-experimental-webstorage`，启动 Electron 前移除。

扩展与打包辅助检查（仓库根）：

```bash
node browser-extension/shared.test.js
node browser-extension/sniff-core.test.js
node browser-extension/bridge-timeout.test.js
node browser-extension/install-ui.test.js
node --test scripts/build_chrome_extension_zip.test.mjs scripts/package_smoke_helpers.test.mjs scripts/test_packaged_media_tools.test.mjs
```

官网改动在 `website/` 执行 `npm ci`、`npm test`、`npm run build`、`npm run test:sites`，并遵循 [官网代理指引](website/AGENTS.md)。自动化通过不替代人工安装、真实网站授权对照、原生扩展操作或跨平台验收；结果应绑定实际候选安装包的 SHA-256。

## 打包与发布

以下为与公开发行一致的 **cloud-only** 构建示例，不要求 Telegram 应用凭据。构建脚本会重建 Sidecar 和产物目录，已有候选及证据应先另行保留。

macOS（Apple Silicon）：

```bash
BUILD_TELEGRAM_NATIVE=0 ALLOW_CLOUD_ONLY_PACKAGE=1 ./scripts/build_macos_dmg.sh
./scripts/build_chrome_extension_zip.sh
```

Windows（PowerShell，仓库根）：

```powershell
$env:BUILD_TELEGRAM_NATIVE = '0'
$env:ALLOW_CLOUD_ONLY_PACKAGE = '1'
.\scripts\build_windows_nsis.ps1
```

脚本拉取成对媒体工具、构建 Sidecar、执行媒体工具检查，再构建 Electron 安装包；可通过 `FETCH_BINS=0`、`BUILD_SIDECAR=0` 复用已经核对的资源。macOS FFmpeg / FFprobe 来自锁定源码的 arm64 构建；Windows 两个工具来自同一锁定归档。

扩展 ZIP 由 `scripts/build_chrome_extension_zip.sh` 从 `manifest.json` 读取版本，排除测试及隐藏文件并验证包内容；需要 Bash、Node.js、zip、unzip 和 shasum，Windows 缺少这些工具时可使用同一提交的 CI 工件。产物默认位于 `desktop/release/`，不提交 Git。

原生 Telegram 模式另需 Local Bot API、ProcessHost 和有效应用凭据，必须按平台构建与验收，不能据 cloud-only 安装包宣称本地 2 GB 能力。正式双平台发布须由同一 tag 交付 DMG、NSIS 与扩展 ZIP，公开状态以实际 Release 为准。构建、签名、应用更新及历史基线见 [发布指南](docs/RELEASE.md) 与 [CI 工作流](.github/workflows/ci.yml)。

## 开发文档

- [AGENTS.md](AGENTS.md)：架构合同、开发命令与维护约定。
- [产品路线图](docs/roadmap.md)、[分支约定](docs/BRANCHING.md)：当前方向及历史计划。
- [设计系统](docs/DESIGN-SYSTEM.md)、[桌面界面规范](docs/UI-DESIGN-LANGUAGE.md)：用户可见界面的共同规则。
- [发布指南](docs/RELEASE.md)、[下载工具更新](docs/ENGINE-UPDATES.md)、[Telegram](docs/TELEGRAM.md)：专项维护与验证。

历史路线图、候选清单与交接中的版本号不代表最新公开版本；执行前核对当前源码、包身份与对应 Release。

## 许可证

MIT
