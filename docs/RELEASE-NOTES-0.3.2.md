# Downany 0.3.2

Windows x64 与 Apple Silicon Mac，配套 Chrome 扩展 0.9.2。

## 变化

- 任务和下载记录的排序偏好在重启后保留。
- 任务暂时无法移除时会显示提示，方便稍后重试。
- Windows 启动参数或下载工具检查失败时，中文诊断按 UTF-8 输出，避免早期错误信息乱码。
- 下载工具更新更严格地检查压缩包原始路径，拒绝含反斜杠、空字符或盘符的成员；校验失败时继续使用已有可用引擎。
- 保留 0.3.1 的下载失败处理、重试选项、队列恢复与 Chrome 扩展 0.9.2 功能。

## 下载与安装

- Windows：`Downany-0.3.2-win-x64.exe`。
- Apple Silicon Mac：`Downany-0.3.2-mac.dmg`。
- Chrome：解压 `Downany-chrome-extension-0.9.2.zip`，在扩展页面开启开发者模式并加载解压目录；使用扩展前先启动 Downany。

Windows 安装包未签名，Mac 未使用 Developer ID 签名或公证，首次安装或打开可能出现系统安全提示。Windows SmartScreen 可在核对下载来源后选择“更多信息”→“仍要运行”；Mac 可右键应用选择“打开”。

安装包采用 cloud-only 模式，Telegram 使用官方云端 Bot API；不宣称本地 Bot API 的 2 GB 能力。应用内更新通过“检查应用更新”查询最新正式版，再打开下载页。

## 验证范围

发布前预检包含两平台各 649 项桌面测试、Windows 自动首装与 0.3.0 升级、双卸载、包内 Sidecar/媒体工具、13 项 Windows 受控桌面操作及五轮退出恢复。正式安装包仍由本次 tag 的 CI 重新构建和验证。

完整 Windows 网站矩阵当前为 9/30（六次独立素材下载、三条预期错误），仍缺 21 条，其中登录前后对照和合集尚未通过；不宣称三站 90% 成功率。普通 Chrome 原生扩展操作、干净 Windows 的人工安装/卸载重装及系统提示记录也未完成。Mac 已由用户测试，本轮没有新增 Mac 人工记录。

在上述验收缺口保持明确记录的前提下，按维护者 2026-10-10 的发布指令交付本版本。详细候选与历史边界见 [0.3.2 验证记录](https://github.com/JackEngineer/downany/blob/v0.3.2/docs/acceptance/v0.3.2-release-readiness.md)。
