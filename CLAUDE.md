# CLAUDE.md — 与 AGENTS.md 同步，详见 AGENTS.md / README.md

本仓库为 macOS 视频下载器（Python/PyQt6 主线 + SwiftUI 并行版）。

开发：`./scripts/install_env.sh` → `source venv/bin/activate` → `python src/main.py`

核心在 `src/core/download_manager.py`（队列/状态机）与 `src/ui/tabs/*`，不是早期的单文件 `DownloadThread` 双 Tab。完整模块树见 README.md。
