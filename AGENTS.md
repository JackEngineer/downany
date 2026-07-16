# AGENTS.md / CLAUDE.md — Agent 指引（与当前代码对齐）

## 项目概览

macOS 视频下载器：

- **Python 主线**：`src/` + yt-dlp + PyQt6（可选 Fluent）
- **Swift 并行线**：`swift-app/`（SwiftUI + Process 调用 yt-dlp）

## 开发命令

```bash
./scripts/install_env.sh
source venv/bin/activate
python src/main.py
# 或 npm start → scripts/start_app.sh

cd swift-app && swift test
./scripts/package_swift_app.sh
```

## Python 架构

- `src/main.py`：入口
- `src/core/download_manager.py`：队列、并发、暂停/取消状态机（带锁）
- `src/core/downloader.py`：yt-dlp 封装；失败必须向上抛出
- `src/core/search_engine.py` / `video_info_extractor.py` / `platform_detector.py`
- `src/data/database.py` / `config_manager.py`
- `src/ui/main_window.py` + `src/ui/tabs/*` + `src/ui/components/*`

下载在后台线程执行；关闭窗口时各 Tab `shutdown()` 后 `DownloadManager.stop()`。

## 约定

- UI 文案中文，标识符英文
- 默认 `noplaylist: True`
- 暂停为中断下载 + 恢复入队（依赖 yt-dlp 续传），非流式 pause API
- 不要内联 import；Swift 对 enum/union 做 exhaustive switch

更完整说明见 [README.md](README.md)。
