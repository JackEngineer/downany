# CLAUDE.md（中文说明）

本文件为 Claude 在本仓库写代码时提供指引。

## 项目概览

基于 Python、yt-dlp 和 PyQt6 的 macOS 视频下载应用，支持单个与批量下载，带标签页式图形界面。

## 开发命令

### 环境准备
```bash
./scripts/install_env.sh  # 创建虚拟环境、安装依赖、检查 ffmpeg/deno
source venv/bin/activate   # 激活虚拟环境
```

### 运行应用
```bash
python src/main.py   # 直接运行
npm start            # 使用 start_app.sh（自动处理 venv 与 Qt 路径）
```

### 安装 FFmpeg（如需）
```bash
./scripts/install_ffmpeg.sh  # 将 ffmpeg 静态二进制下载到 bin/
```

## 架构

### 核心模块

**入口**：`src/main.py`
- 初始化 PyQt6 的 QApplication
- 启动主窗口 MainWindow
- 将项目根目录加入 sys.path 以便导入模块

**下载逻辑**：`src/core/downloader.py`
- `Downloader` 类封装 yt-dlp
- 支持进度 / 完成 / 错误回调
- 自动检测本地 ffmpeg：优先使用 `bin/ffmpeg`
- 默认格式：`bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best`
- 下载目录可配置，默认 `downloads/`

**界面**：`src/ui/main_window.py`
- `MainWindow`：主窗口，使用 QTabWidget
  - 标签页 1：单条下载（一个 URL 输入）
  - 标签页 2：批量下载（多行文本输入）
- `DownloadThread`：QThread 子类，在后台执行下载
  - 按顺序处理单条或批量 URL
  - 通过信号更新界面（进度、完成、错误、批量进度）
  - 批量时某条失败会继续下载其余链接

**工具**：`src/utils/logger.py`
- 统一日志配置

### 线程模型

下载在 `DownloadThread`（QThread）中执行，避免卡住界面：
1. 用户点击下载
2. 界面创建 DownloadThread，传入 URL（或列表）和下载目录
3. 线程信号连接到界面槽（progress_signal、finished_signal、error_signal、batch_progress_signal）
4. 线程顺序执行下载并发出进度
5. 界面实时更新进度条和状态文字
6. 完成后恢复控件并显示完成提示

### FFmpeg 检测顺序

1. 本地二进制：`bin/ffmpeg`（优先）
2. 系统 PATH 中的 `ffmpeg`
3. 自动安装：运行 `install_ffmpeg.sh` 将静态二进制下载到 `bin/`

## 依赖

- Python 3.9+
- yt-dlp >= 2025.01.01（视频下载引擎）
- PyQt6 >= 6.6.0（图形界面）
- ffmpeg（可选，建议安装，用于合并音视频流）
- deno（可选，改善 YouTube 解析）

## 项目结构

```
src/
├── main.py              # 应用入口
├── core/
│   └── downloader.py    # yt-dlp 封装与回调
├── ui/
│   └── main_window.py   # PyQt6 界面（MainWindow + DownloadThread）
└── utils/
    └── logger.py        # 日志工具

scripts/
├── install_env.sh       # 环境安装（venv + 依赖）
├── install_ffmpeg.sh    # FFmpeg 安装
└── start_app.sh         # 启动脚本（处理 venv 与 Qt 路径）

bin/
└── ffmpeg               # 本地 ffmpeg（若已安装）
```

## 注意事项

- 界面和注释是中文，代码命名仍用英文
- `start_app.sh` 会处理 macOS 下 Qt 插件路径
- 批量下载时单条失败会继续下载，错误会记录并显示
- 进度通过 yt-dlp 的 progress hooks 和自定义信号更新
- 默认 `noplaylist: True`，不会整列表下载
