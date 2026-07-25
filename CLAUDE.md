# CLAUDE.md — 与 AGENTS.md 同步，详见 AGENTS.md / README.md

本仓库为 macOS 视频下载器（Electron + Sidecar 主线；PyQt6 / SwiftUI 并行）。

开发：`./scripts/install_env.sh` → `source venv/bin/activate` → `cd desktop && npm run dev`  
（PyQt：`python src/main.py`）

核心在 `src/core/download_manager.py`、`src/sidecar/` 与 `desktop/`，不是早期的单文件 `DownloadThread` 双 Tab。完整说明见 README.md / AGENTS.md。
