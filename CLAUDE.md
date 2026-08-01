# CLAUDE.md — 与 AGENTS.md 同步

本仓库为 macOS **视频下载器**（`VideoDownloader`）：**Electron + Python Sidecar + yt-dlp** 唯一主线。无 PyQt / Swift 旁线。

开发：`./scripts/install_env.sh` → `source venv/bin/activate` → `cd desktop && npm run dev`（或仓库根 `npm run desktop`）。

核心：`desktop/`、`src/sidecar/`、`src/core/`、`src/data/`。Sidecar 打包为 **onedir**。测试：`pytest tests/core tests/data tests/sidecar -q`；`cd desktop && npm test`。

完整约定、路径与禁区见 [AGENTS.md](AGENTS.md)、[README.md](README.md)、[docs/roadmap.md](docs/roadmap.md)。
