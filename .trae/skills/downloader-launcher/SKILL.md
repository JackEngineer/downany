---
name: downloader-launcher
description: 启动 Downloader 应用程序。当用户想要运行、打开或测试 Downloader 应用时使用此技能。
---

# Downloader Launcher

此技能用于启动 Downloader 桌面应用（Electron 主线）。

## 何时使用

当用户要求：

- "启动项目"
- "运行程序"
- "打开 App"
- "测试一下应用"

## 使用步骤

1. 确保当前工作目录是项目根目录。
2. 运行：

   ```bash
   bash scripts/start_app.sh
   # 或：npm run desktop
   ```
