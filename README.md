# Resource Downloader (资源下载器)

基于 yt-dlp 和 PyQt6 开发的 macOS 视频下载工具。

## 功能特性

- 支持多种视频网站下载
- 图形化界面操作
- 实时进度显示
- 自动合并视频与音频

## 开发环境设置

1. 运行环境安装脚本：

   ```bash
   ./scripts/install_env.sh
   ```

2. 激活虚拟环境：

   ```bash
   source venv/bin/activate
   ```

3. 运行程序：

   ```bash
   python src/main.py
   ```

## 依赖

- Python 3.9+
- yt-dlp
- PyQt6
- ffmpeg (运行环境脚本会自动尝试安装，或使用 `./scripts/install_ffmpeg.sh` 手动安装)
