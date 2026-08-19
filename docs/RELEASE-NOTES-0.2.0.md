# Downany · 百纳 0.2.0

这是面向 macOS Apple Silicon 与 Windows x64 的云端模式发行版本。安装包未签名，首次启动可能看到系统安全提示。

本版不携带 Telegram Local Bot API 和 ProcessHost 原生资源；Telegram 使用官方云端 Bot API。下载、Sidecar、扩展入队和普通 Telegram 自动发送流程可用，但不包含本地 Bot API 的单文件 2 GB 上传能力。

## 下载

- `Downany-0.2.0-mac.dmg`：macOS arm64 安装包
- `Downany-0.2.0-win-x64.exe`：Windows x64 安装包
- `Downany-chrome-extension-0.8.2.zip`：Chrome 扩展，解压后通过开发者模式加载

## 本次新增

- macOS Apple Silicon 安装包，内置 arm64 FFmpeg 与 Sidecar
- Windows 桌面端安装、启动、单实例和本机数据目录支持
- Chrome 扩展把浏览器中的视频任务发送到本机百纳，继续使用原有下载队列
- Telegram Bot 绑定、读取聊天、测试消息、下载完成后自动发送和最近发送记录
- 云端 Bot API 大文件视频按可播放片段发送，保持原始画面比例和中文标题
- Telegram 视频标题保留标题、大小和分段序号，不再显示来源 URL
- 修复代理环境下的本机扩展桥、YouTube 下载参数与 Windows 中文路径处理

## 已知限制

- 安装包未签名：macOS 需右键打开或在「隐私与安全性」中允许；Windows SmartScreen 需选择「更多信息 → 仍要运行」
- Telegram 本地 Bot API 模式暂未随本版分发；云端 Bot API 对单文件大小有限制，较大的视频会按可播放片段发送
- YouTube 等站点可能需要有效的浏览器 Cookie
- 应用内更新当前仍是检查 GitHub Release 后前往下载，自动替换需后续签名与 electron-updater

详见 [RELEASE.md](RELEASE.md)。
