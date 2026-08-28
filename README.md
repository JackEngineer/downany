# Downany · 百纳

macOS / Windows 视频下载应用。产品主线为 **Electron + Python Sidecar**（`desktop/` + `src/sidecar/`）。

本工作树已完成 **v0.3.0 Windows 本地候选** 的自动化门槛，尚未安装、提交或公开发布；扩展独立版本为 `0.8.2`。本轮不包含 Mac 构建或人工验收。结果与边界见 [候选验证记录](docs/acceptance/v0.3.0-stable-baseline.md)。

## 功能

- **平台识别**：YouTube、Bilibili、抖音、TikTok、Twitter、Instagram 等常见视频平台
- **网络搜索**：支持 YouTube、Bilibili，搜索结果可直接加入下载列表
- **下载工作台**：单条 / 批量 URL 解析与入队
- **队列管理**：可配置并发、暂停 / 恢复 / 取消 / 重试、实时进度
- **恢复与顺序**：保留暂停选择与队列顺序，支持整组操作和同优先级内调整顺序；失败或取消的任务不会自行重试
- **历史记录**：SQLite 存储，可检索与重新下载
- **设置**：下载目录、并发、限速、代理、画质、字幕、主题、yt-dlp 更新
- **界面语言**：默认中文；English 覆盖添加、任务状态与操作、合集、排序及常规设置中的更新/诊断。部分低频设置、原生菜单和服务端历史说明仍为中文
- **Telegram 自动转发**：绑定 Bot、验证私聊/群组/频道，下载完成后自动发送并保留发送记录
- **桌面集成**：原生菜单、通知、Dock 徽标、窗口几何、旧 Trae 数据迁移
- **Chrome 扩展**：识别页面媒体后一键入队（见 [`browser-extension/`](browser-extension/)）
- **浏览器抓取窗口**：登录墙 / 纯 HLS 页可用内置浏览器嗅探入队

Telegram 的绑定与发送说明见 [`docs/TELEGRAM.md`](docs/TELEGRAM.md)。云端 Bot API 可直接用于开发；
本地 Bot API 的 2 GB 文件能力需要随平台安装包提供已构建并验收的原生资源。
- **CLI**：`./scripts/downany add <url> [--audio] [--quality 1080p] [--detach]`

路线图见 [docs/roadmap.md](docs/roadmap.md)。所有用户可见载体遵循
[Downany Design System](docs/DESIGN-SYSTEM.md)，桌面端详细规则见
[Desktop UI Profile](docs/UI-DESIGN-LANGUAGE.md)。

## 快速开始

```bash
./scripts/install_env.sh
source venv/bin/activate
cd desktop && npm install
npm run dev          # 仓库根也可用：npm run desktop
```

Sidecar 单独调试：

```bash
python -m src.sidecar
```

| 平台 | 数据目录 | 日志 |
|------|----------|------|
| macOS | `~/Library/Application Support/Downany/` | `~/Library/Logs/Downany/` |
| Windows | `%LOCALAPPDATA%\Downany` | `%LOCALAPPDATA%\Downany\logs` |

环境变量 `DOWNANY_DATA_DIR` 可覆盖数据目录。

## 下载与发布

当前分发为**未签名**构建，经 [GitHub Releases](https://github.com/JackEngineer/downany/releases)：

| 产物 | 说明 |
|------|------|
| `Downany-<ver>-mac.dmg` | macOS 桌面端；首次需右键「打开」或 `xattr -cr /Applications/Downany.app` |
| `Downany-<ver>-win-x64.exe` | Windows NSIS 安装包；SmartScreen 需「更多信息 → 仍要运行」 |
| `Downany-chrome-extension-<ver>.zip` | Chrome 扩展；解压后在 `chrome://extensions` 以开发者模式加载 |

详细步骤、公证与应用内更新检查：见 [docs/RELEASE.md](docs/RELEASE.md)。

## 打包

**macOS：**

```bash
./scripts/fetch_release_binaries.sh   # yt-dlp + ffmpeg → desktop/resources/bin
./scripts/build_sidecar.sh            # PyInstaller Sidecar（onedir）
./scripts/build_macos_dmg.sh          # 未签名 .app / DMG（可设 FETCH_BINS=0 BUILD_SIDECAR=0 跳过）
# 有 Apple 证书时：
# SIGN_IDENTITY=... APPLE_ID=... APP_PASSWORD=... TEAM_ID=... ./scripts/notarize_macos.sh
```

**Windows**（须在 Windows 上构建；NSIS 不在 macOS 产出）：

```powershell
.\scripts\build_windows_nsis.ps1      # 拉取 Win 二进制 → Sidecar → electron-builder --win
```

Chrome 扩展 zip（版本取自 `browser-extension/manifest.json`）与 DMG/NSIS 同挂 Release；打包示例见 [docs/RELEASE.md](docs/RELEASE.md)。

产物默认在 `desktop/release/`（已 gitignore，勿提交）。

## Chrome 扩展（一键入队）

**用户**：从 Release 下载 zip → 解压 → `chrome://extensions` → 开发者模式 → 加载已解压目录；须先启动桌面端（桥 `127.0.0.1:17888`）。

**开发**：

```bash
./scripts/setup_chrome_extension.sh
```

会打开已预装扩展的独立 Chrome 窗口，或重启主 Chrome 加载扩展。细节见 [browser-extension/README.md](browser-extension/README.md)。

## 架构

```
desktop/           # Electron Main / Preload / React 命令中心
src/sidecar/       # JSON Lines Sidecar（无 Qt）
src/core/          # 下载调度、yt-dlp、解析、平台识别
src/data/          # SQLite、JsonConfig
packaging/         # Sidecar PyInstaller 规格
```

分支约定见 [docs/BRANCHING.md](docs/BRANCHING.md)、路线图 [docs/roadmap.md](docs/roadmap.md)。

## 测试

```bash
source venv/bin/activate
pip install -r requirements-dev.txt
pytest tests/core tests/data tests/sidecar tests/cli -q
cd desktop && npm test && npm run build
```

`npm run build` 会先检查 Main 和 Renderer 的 TypeScript 类型。Windows 自动窗口布局、旧格式迁移和真实包恢复命令见 [本地候选门槛](docs/RELEASE.md#v030-windows-本地候选门槛)。自动化测试不等于覆盖安装、真实账号发送或真实网站全量验证。

产品路线见 [docs/roadmap.md](docs/roadmap.md)；发布与签名见 [docs/RELEASE.md](docs/RELEASE.md)。

## 许可证

MIT
