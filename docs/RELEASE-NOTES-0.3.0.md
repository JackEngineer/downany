# Downany · 百纳 0.3.0

0.3.0 聚焦下载成品正确性、队列恢复和桌面端关键操作体验，并首次把这些改进作为 macOS Apple Silicon 与 Windows x64 同版本交付。

## 下载

- `Downany-0.3.0-mac.dmg`：macOS Apple Silicon 安装包
- `Downany-0.3.0-win-x64.exe`：Windows x64 安装包
- `Downany-chrome-extension-0.8.2.zip`：Chrome 扩展，解压后通过开发者模式加载

## 本次更新

- 下载完成前按任务类型校验媒体流与容器，使用安全的暂存和落盘流程，避免把不完整文件标为成品。
- 同名输出不会覆盖已有文件；任务会保存最终成品路径和大小，便于打开文件或恢复后继续使用。
- 暂停意图、队列顺序与整组操作可以持久化；启动、重连和操作后的迟到刷新不会覆盖较新的任务状态。
- 失败、取消和 Telegram 发送分别记录；发送失败不会把已经完成的下载改成失败，也不会自动重新下载。
- 诊断导出只包含限定的去敏摘要；保存成功但打开目录失败时会保留真实结果并给出明确提示。
- 添加确认、任务状态与操作、合集、排序、更新和诊断等关键路径支持中文与 English。
- 官网会显示 GitHub 当前公开版本，并直接提供对应平台的 Release 下载入口。

## 交付范围

本版安装包为 cloud-only：Telegram 使用官方云端 Bot API，不携带 Local Bot API、ProcessHost 或应用凭据，因此不包含本地 Bot API 的单文件 2 GB 上传能力。Chrome 扩展版本保持为 `0.8.2`，使用前需先启动桌面端。

## 已知限制

- 安装包未签名、未公证：macOS 需右键打开或在「隐私与安全性」中允许；Windows SmartScreen 需选择「更多信息 → 仍要运行」。
- macOS 安装包仅支持 Apple Silicon，Windows 安装包仅支持 x64。
- English 尚未覆盖部分低频设置、原生菜单和服务端历史说明。
- YouTube 等站点可能需要有效的浏览器 Cookie，站点规则变化也可能影响下载。
- 应用内更新当前只检查 GitHub Release 并前往下载，不会自动替换安装。

完整安装和校验说明见 [RELEASE.md](RELEASE.md)。
