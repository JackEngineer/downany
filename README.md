# Downany · 百纳

macOS 视频下载应用。产品主线为 **Electron + Python Sidecar**（`desktop/` + `src/sidecar/`）。

## 功能

- **平台识别**：YouTube、Bilibili、抖音、TikTok、Twitter、Instagram、Pornhub 等
- **下载工作台**：单条 / 批量 URL 解析与入队
- **队列管理**：可配置并发、暂停 / 恢复 / 取消 / 重试、实时进度
- **历史记录**：SQLite 存储，可检索与重新下载
- **设置**：下载目录、并发、限速、代理、画质、字幕、主题、yt-dlp 更新
- **桌面集成**：原生菜单、通知、Dock 徽标、窗口几何、旧 Trae 数据迁移
- **Chrome 扩展**：识别页面媒体后一键入队（见 [`browser-extension/`](browser-extension/)）
- **浏览器抓取窗口**：登录墙 / 纯 HLS 页可用内置浏览器嗅探入队
- **CLI**：`./scripts/downany add <url> [--audio] [--quality 1080p] [--detach]`

路线图见 [docs/roadmap.md](docs/roadmap.md)。

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

数据目录：`~/Library/Application Support/Downany/`  
日志：`~/Library/Logs/Downany/`

## 下载与发布

当前分发为**未签名**构建，经 [GitHub Releases](https://github.com/JackEngineer/downany/releases)：

| 产物 | 说明 |
|------|------|
| `Downany-<ver>-mac.dmg` | 桌面端；首次需右键「打开」或 `xattr -cr /Applications/Downany.app` |
| `Downany-chrome-extension-<ver>.zip` | Chrome 扩展；解压后在 `chrome://extensions` 以开发者模式加载 |

详细步骤、公证与应用内更新检查：见 [docs/RELEASE.md](docs/RELEASE.md)。

## 打包（macOS）

```bash
./scripts/fetch_release_binaries.sh   # yt-dlp + ffmpeg → desktop/resources/bin
./scripts/build_sidecar.sh            # PyInstaller Sidecar（onedir）
./scripts/build_macos_dmg.sh          # 未签名 .app / DMG（可设 FETCH_BINS=0 BUILD_SIDECAR=0 跳过）
# Chrome 扩展 zip（版本取自 browser-extension/manifest.json）：
# (cd browser-extension && zip -r ../desktop/release/Downany-chrome-extension-0.8.1.zip . \
#   -x '*.test.js' -x '.*' -x '__MACOSX*' -x '*.DS_Store')
# 有 Apple 证书时：
# SIGN_IDENTITY=... APPLE_ID=... APP_PASSWORD=... TEAM_ID=... ./scripts/notarize_macos.sh
```

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
pytest tests/core tests/data tests/sidecar -q
cd desktop && npm test && npm run build
```

产品路线见 [docs/roadmap.md](docs/roadmap.md)；发布与签名见 [docs/RELEASE.md](docs/RELEASE.md)。

## 许可证

MIT
