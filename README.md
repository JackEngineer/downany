# Trae 视频下载器

基于 Python、yt-dlp 和 PyQt6 的 macOS 视频下载应用；另含并行推进的 SwiftUI 原生版（`swift-app/`）。

## 功能

- **平台识别**：YouTube、Bilibili、抖音、TikTok、Twitter、Instagram、Pornhub 等
- **站内搜索**：YouTube / Bilibili / Pornhub，封面懒加载与应用内预览
- **下载工作台**：单条 / 批量 URL 入队
- **队列管理**：可配置并发、暂停 / 恢复 / 取消 / 重试、实时进度
- **历史记录**：SQLite 存储，可检索与重新下载
- **设置**：下载目录、并发、限速、代理、画质、字幕、主题

## 快速开始

```bash
./scripts/install_env.sh
source venv/bin/activate
python src/main.py
# 或
npm start
```

安装 FFmpeg（可选，建议）：

```bash
./scripts/install_ffmpeg.sh
# 生产环境建议锁定校验：FFMPEG_SHA256=<hash> ./scripts/install_ffmpeg.sh
```

## 架构（Python）

```
src/
├── core/          # 下载调度、yt-dlp、搜索、平台识别、元数据
├── data/          # SQLite 历史、QSettings 配置
├── ui/            # 主窗口、tabs、components、主题
└── utils/         # 日志
```

配置：`~/Library/Preferences/com.Trae.Downloader.plist`  
历史：`~/.trae_downloader/history.db`

## Swift 原生版

见 [swift-app/README.md](swift-app/README.md)。构建：

```bash
cd swift-app && swift test
./scripts/package_swift_app.sh
```

## 测试与 CI

```bash
pip install -r requirements-dev.txt
QT_QPA_PLATFORM=offscreen pytest -q
cd swift-app && swift test
```

## 许可证

MIT
