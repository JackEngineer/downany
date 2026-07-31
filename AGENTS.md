# AGENTS.md / CLAUDE.md — Agent 指引（与当前代码对齐）

## 项目概览

macOS 视频下载器（产品名 **视频下载器** / `VideoDownloader`）：

- **唯一产品主线**：`desktop/` + `src/sidecar/`（JSON Lines）+ yt-dlp
- **已冻结**：`legacy/`（原 PyQt `src/ui`、SwiftUI `swift-app`、`tests/ui`）——勿新增功能

## 开发命令

```bash
./scripts/install_env.sh
source venv/bin/activate

# Electron
cd desktop && npm install && npm run dev
# 或仓库根：npm run desktop

# Sidecar 单独跑
python -m src.sidecar

# 打包
./scripts/build_macos_dmg.sh
```

## 架构要点

- `src/sidecar/`：协议、handlers、迁移、yt-dlp 更新；stdout 仅协议行，日志走 stderr
- `src/core/download_manager.py`：队列、并发、暂停/取消状态机（带锁）
- `src/core/downloader.py`：yt-dlp 封装；失败必须向上抛出；`VIDEODL_BIN_DIR` 解析 ffmpeg
- `src/data/json_config.py` / `database.py` / `queue_store.py`：Sidecar 持久化
- `desktop/electron/`：Main、菜单、通知、Dock、窗口几何、打包态 Sidecar 启动

数据目录：`~/Library/Application Support/VideoDownloader/`（可用 `VIDEODL_DATA_DIR` 覆盖）。

## 约定

- UI 文案中文，标识符英文；发布产物无 Trae 标识
- 默认 `noplaylist: True`
- 暂停为中断下载 + 恢复入队（依赖 yt-dlp 续传），非流式 pause API
- 不要内联 import；TS 对 enum/union 做 exhaustive switch
- 提交时勿夹带无关 WIP
- 分支：`feat/m{N}-{slug}` / `chore/{slug}`；见 [docs/BRANCHING.md](docs/BRANCHING.md)

更完整说明见 [README.md](README.md)、[docs/roadmap.md](docs/roadmap.md)。
