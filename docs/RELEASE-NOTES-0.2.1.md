# Downany · 百纳 0.2.1

本次更新精简了公开的平台说明与展示名称，下载识别和兼容能力保持不变。

## 下载

- `Downany-0.2.1-mac.dmg`：macOS Apple Silicon 安装包
- `Downany-0.2.1-win-x64.exe`：Windows x64 安装包
- `Downany-chrome-extension-0.8.2.zip`：Chrome 扩展，解压后通过开发者模式加载

## 本次更新

- 精简公开的平台说明与展示名称
- 保留现有下载识别、链接匹配与兼容能力
- Windows x64 与 macOS Apple Silicon 继续使用云端模式安装包
- Chrome 扩展版本保持为 0.8.2

## 交付范围

本版不携带 Telegram Local Bot API 和 ProcessHost 原生资源；Telegram 使用官方云端 Bot API。下载、Sidecar、扩展入队和普通 Telegram 自动发送流程可用，但不包含本地 Bot API 的单文件 2 GB 上传能力。

## 已知限制

- 安装包未签名：macOS 需右键打开或在「隐私与安全性」中允许；Windows SmartScreen 需选择「更多信息 → 仍要运行」
- YouTube 等站点可能需要有效的浏览器 Cookie
- 应用内更新当前仍是检查 GitHub Release 后前往下载，自动替换需后续签名与 electron-updater

详见 [RELEASE.md](RELEASE.md)。
