---
name: downloader-launcher
description: 启动 Downloader 应用程序。当用户想要运行、打开或测试 Downloader 应用时使用此技能。
---

# Downloader Launcher

此技能用于启动 Downloader 应用程序。

## 概览

该技能封装了启动 Downloader Python 应用程序的逻辑，自动处理以下环境配置：

1. 设置 `PYTHONPATH` 确保源码模块可导入。
2. (macOS) 自动检测并设置 `QT_PLUGIN_PATH` 和 `QT_QPA_PLATFORM_PLUGIN_PATH`，解决 PyQt6 找不到 cocoa 插件的问题。

## 何时使用

当用户要求：

- "启动项目"
- "运行程序"
- "打开 App"
- "测试一下应用"

## 使用步骤

Claude 将执行以下步骤：

1. 确保当前工作目录是项目根目录。
2. 运行启动脚本：

   ```bash
   bash scripts/start_app.sh
   ```

该脚本会自动检测环境并启动 `src/main.py`。
