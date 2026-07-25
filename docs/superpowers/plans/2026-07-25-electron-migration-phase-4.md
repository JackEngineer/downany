# Electron 迁移阶段 4：发布打包 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Sidecar、内置 yt-dlp/ffmpeg 与 Electron 壳打包成可安装的 macOS `.app` / DMG，并提供签名与公证脚本（无证书时可做未签名本地构建）。

**Architecture:** 发布态由 Electron Main 启动 `extraResources` 内的 PyInstaller Sidecar 可执行文件，并通过 `VIDEODL_BIN_DIR` 指向同包内的 `bin/ffmpeg` 与保底 `bin/yt-dlp`；用户更新的 yt-dlp 仍优先落在 Application Support。开发态继续 `python -m src.sidecar`。

**Tech Stack:** PyInstaller、electron-builder、现有 `install_ffmpeg.sh`、GitHub yt-dlp release、可选 `codesign`/`notarytool`。

**规格来源:** 设计文档 §6.6、§13 阶段 4、§14 验收 9–10、13。

## Global Constraints

- 产物标识：`VideoDownloader` / `com.jacklee.videodownloader` / 视频下载器；无 Trae。
- 二进制不提交进 git（`.gitignore`）；由脚本拉取并校验。
- 无 Apple 证书时：`CSC_IDENTITY_AUTO_DISCOVERY=false` 打未签名 DMG，签名脚本检测缺证书后优雅跳过并说明。
- 每次提交只 add 点名文件；不碰无关 UI WIP。
- 首版不做自动静默更新应用本体（仅 yt-dlp 应用内更新，阶段 3 已有）。

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `packaging/sidecar.spec` | 新建 | PyInstaller 规格 |
| `packaging/requirements-sidecar.txt` | 新建 | Sidecar 运行时依赖（无 Qt） |
| `scripts/fetch_release_binaries.sh` | 新建 | 拉取 yt-dlp + 调用 ffmpeg 安装到 `desktop/resources/bin` |
| `scripts/build_sidecar.sh` | 新建 | 构建 Sidecar 到 `desktop/resources/sidecar` |
| `scripts/build_macos_dmg.sh` | 新建 | Vite build + electron-builder |
| `scripts/notarize_macos.sh` | 新建 | 可选公证 |
| `desktop/electron-builder.yml` | 新建 | mac 目标、extraResources、appId |
| `desktop/package.json` | 修改 | builder 依赖与 dist 脚本 |
| `desktop/electron/sidecar.ts` | 修改 | 打包态启动路径与 env |
| `desktop/electron/paths.ts` | 新建 | resources / bin / sidecar 解析 |
| `src/core/downloader.py` | 修改 | 尊重 `VIDEODL_BIN_DIR` |
| `src/sidecar/ytdlp_updater.py` | 修改 | 保底内置 yt-dlp 路径 |
| `tests/sidecar/test_bin_paths.py` | 新建 | 路径解析单测 |
| `.gitignore` | 修改 | 忽略 resources 二进制与 release 产物 |

---

### Task 0: 分支

```bash
git checkout electron-phase-3
git checkout -b electron-phase-4
```

### Task 1: 二进制资源与路径约定

- [x] `VIDEODL_BIN_DIR`：ffmpeg / 内置 yt-dlp
- [x] 用户更新：`AppPaths.data_dir/bin/yt-dlp` 优先
- [x] `fetch_release_binaries.sh` + gitignore

### Task 2: Sidecar PyInstaller

- [x] `build_sidecar.sh` → `desktop/resources/sidecar/VideoDownloaderSidecar`
- [x] 冒烟：file/size 检查

### Task 3: Electron 打包态启动

- [x] `app.isPackaged` 时 spawn 资源内 Sidecar
- [x] 设置 `VIDEODL_BIN_DIR`

### Task 4: electron-builder + DMG

- [x] `electron-builder.yml`：dmg + dir（可执行名英文 `VideoDownloader`，显示名中文）
- [x] `npm run dist:mac`（未签名本地构建已通过）

### Task 5: 签名/公证脚本与验收

- [x] `notarize_macos.sh`：缺证书时优雅跳过
- [x] pytest 路径测 + desktop test/build
- [x] 本机产出 `VideoDownloader-0.1.0-mac.dmg`（unsigned）

---

## 自审

- 不在本阶段做 Sparkle/自动应用更新。
- PyQt/Swift 线保持可运行，不被打包脚本破坏。
