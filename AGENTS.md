# AGENTS.md / CLAUDE.md — Agent 指引（与当前代码对齐）

## 项目概览

macOS 视频下载应用（产品名 **Downany · 百纳**）：

- **唯一产品主线**：Electron（`desktop/`）+ Python Sidecar（`src/sidecar/`，JSON Lines）+ yt-dlp
- **旁线已删除**：无 PyQt / SwiftUI / `legacy/`；勿再引入
- **附属**：`browser-extension/`（Chrome 嗅探入队）、`scripts/downany`（CLI）

## 仓库结构

```
desktop/             # Electron Main / Preload / React 命令中心
src/sidecar/         # 协议循环、handlers、迁移、健康检查、更新
src/core/            # 下载调度、yt-dlp、解析、平台识别
src/data/            # SQLite、JsonConfig、queue_store
src/cli/             # ./scripts/downany 入口
browser-extension/   # MV3 扩展 + sniff-core
packaging/           # Sidecar PyInstaller（onedir）
scripts/             # 环境、打包、公证、扩展加载
docs/                # roadmap / BRANCHING / RELEASE / COMMERCIAL
tests/{core,data,sidecar}/
```

## 开发命令

```bash
./scripts/install_env.sh
source venv/bin/activate

# Electron（推荐）
cd desktop && npm install && npm run dev
# 仓库根：npm run desktop  或  ./scripts/start_app.sh

# Sidecar 单独跑（开发态 python -m，非打包二进制）
python -m src.sidecar

# 测试
pytest tests/core tests/data tests/sidecar -q
cd desktop && npm test && npm run build
node browser-extension/shared.test.js

# 打包（Sidecar 为 onedir，勿改回 onefile）
./scripts/fetch_release_binaries.sh
./scripts/build_sidecar.sh
./scripts/build_macos_dmg.sh   # FETCH_BINS=0 BUILD_SIDECAR=0 可跳过前置步骤
# Windows NSIS（在 Windows 上）：.\scripts\build_windows_nsis.ps1 — 见 docs/RELEASE.md
# 扩展 zip 一并挂 Release，勿只发 DMG/NSIS；版本看 browser-extension/manifest.json
# (cd browser-extension && zip -r ../desktop/release/Downany-chrome-extension-<ver>.zip . \
#   -x '*.test.js' -x '.*' -x '__MACOSX*' -x '*.DS_Store')
```

## 架构要点

- **进程模型**：Electron Main 拉起并监护 Sidecar；Renderer 只经 preload IPC；stdout 仅协议行，日志走 stderr
- **Sidecar 握手**：启动后尽早 `hello`，再做迁移/恢复队列；打包态路径为 `resources/sidecar/DownanySidecar/DownanySidecar`
- **下载核心**：`src/core/download_manager.py` 队列与状态机（带锁）；失败必须向上抛出
- **ffmpeg**：`DOWNANY_BIN_DIR`（兼容旧 `VIDEODL_BIN_DIR`）；开发可用仓库/`install_ffmpeg`，发布用 `desktop/resources/bin`
- **持久化**：`json_config.py` / `database.py` / `queue_store.py`；数据目录 `~/Library/Application Support/Downany/`（`DOWNANY_DATA_DIR` 可覆盖）
- **迁移**：`migration.py` 可读旧 Trae 与 `VideoDownloader` 数据；**新路径与发布产物使用 Downany / 百纳**
- **分发**：默认未签名 DMG（macOS）+ NSIS（Windows）+ Chrome 扩展 zip，经 GitHub Releases；应用内更新当前为「检查最新 Release → 前往下载」，自动替换待签名后启用；见 [docs/RELEASE.md](docs/RELEASE.md)
- **扩展桥**：`127.0.0.1:17888`；桌面端须先运行，扩展才能入队

## 约定

- UI 文案中文，标识符英文；产品英文名 Downany，中文副标百纳
- 默认 `noplaylist: True`（播放列表能力按 roadmap 演进，勿擅自改默认语义）
- 暂停 = 中断下载 + 恢复入队（yt-dlp 续传），非流式 pause API
- 不要内联 import；TypeScript 对 enum/union 做 exhaustive `never` switch
- 提交勿夹带无关 WIP；勿提交 `desktop/release/`、`venv/`、`bin/`、下载成品
- 分支：`feat/m{N}-{slug}` / `chore/{slug}` / `fix/{slug}`；见 [docs/BRANCHING.md](docs/BRANCHING.md)
- 产品差距与优先级：见 [docs/roadmap.md](docs/roadmap.md)
- 发版清单：DMG + NSIS + 扩展 zip 同挂一个 tag；Gatekeeper / SmartScreen 说明见 [docs/RELEASE.md](docs/RELEASE.md)

更完整说明见 [README.md](README.md)。
