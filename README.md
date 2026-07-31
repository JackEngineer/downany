# 视频下载器（VideoDownloader）

macOS 视频下载应用。产品主线为 **Electron + Python Sidecar**（`desktop/` + `src/sidecar/`）。PyQt6 / SwiftUI 已冻结于 [`legacy/`](legacy/)，不再新增功能。

## 功能

- **平台识别**：YouTube、Bilibili、抖音、TikTok、Twitter、Instagram、Pornhub 等
- **下载工作台**：单条 / 批量 URL 解析与入队
- **队列管理**：可配置并发、暂停 / 恢复 / 取消 / 重试、实时进度
- **历史记录**：SQLite 存储，可检索与重新下载
- **设置**：下载目录、并发、限速、代理、画质、字幕、主题、yt-dlp 更新
- **桌面集成**：原生菜单、通知、Dock 徽标、窗口几何、旧 Trae 数据迁移
- **Chrome 扩展**：识别页面媒体后一键入队（见 [`browser-extension/`](browser-extension/)）
- **浏览器抓取窗口**：登录墙 / 纯 HLS 页可用内置浏览器嗅探入队
- **CLI**：`./scripts/videodl add <url> [--audio] [--quality 1080p] [--detach]`

> 站内搜索 / 应用内预览仍在冻结的 PyQt 线（`legacy/`）；Electron 主线聚焦下载命令中心，路线见 [docs/roadmap.md](docs/roadmap.md)。

## 快速开始（Electron 主线）

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

数据目录：`~/Library/Application Support/VideoDownloader/`  
日志：`~/Library/Logs/VideoDownloader/`

## 打包（macOS）

```bash
./scripts/fetch_release_binaries.sh   # yt-dlp + ffmpeg → desktop/resources/bin
./scripts/build_sidecar.sh            # PyInstaller Sidecar
./scripts/build_macos_dmg.sh          # 未签名 .app / DMG（可设 FETCH_BINS=0 BUILD_SIDECAR=0 跳过）
# 有 Apple 证书时：
# SIGN_IDENTITY=... APPLE_ID=... APP_PASSWORD=... TEAM_ID=... ./scripts/notarize_macos.sh
```

产物默认在 `desktop/release/`。

## Chrome 扩展（一键入队）

最快：

```bash
./scripts/setup_chrome_extension.sh
```

会打开已预装扩展的独立 Chrome 窗口，或重启主 Chrome 加载扩展；点工具栏图标可查看嗅探到的媒体并勾选下载。细节见 [browser-extension/README.md](browser-extension/README.md)。

## 冻结的旁线（legacy）

PyQt / Swift 代码在 [`legacy/`](legacy/)。日常请用 Electron 主线。若需启动旧 PyQt：

```bash
./scripts/start_app.sh --pyqt
# 或：python legacy/main.py
```


## 架构

```
desktop/           # Electron Main / Preload / React 命令中心
src/sidecar/       # JSON Lines Sidecar（无 Qt）
src/core/          # 下载调度、yt-dlp、解析、平台识别
src/data/          # SQLite、JsonConfig / 旧 QSettings
legacy/            # 已冻结：PyQt UI、SwiftUI、旧 UI 测试
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

设计与阶段计划见 `docs/superpowers/specs/`、`docs/superpowers/plans/`。

## 许可证

MIT
