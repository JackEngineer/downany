# Downany · 百纳 0.2.0-rc.1（Windows 候选版）

这是面向 Windows 的公开候选版本。macOS 安装包尚未包含；现有 macOS 稳定版仍为 0.1.0。

## 下载

- `Downany-0.2.0-win-x64.exe`：Windows x64 未签名安装包
- `Downany-chrome-extension-0.8.2.zip`：Chrome 扩展，解压后通过开发者模式加载

## 本次新增

- Windows 桌面端安装、启动、单实例和本机数据目录支持
- Chrome 扩展把浏览器中的视频任务发送到本机百纳，继续使用原有下载队列
- Telegram Bot 绑定、读取聊天、测试消息、下载完成后自动发送和最近发送记录
- 云端 Bot API 大文件视频按可播放片段发送，保持原始画面比例和中文标题
- Telegram 视频标题保留标题、大小和分段序号，不再显示来源 URL
- 修复代理环境下的本机扩展桥、YouTube 下载参数与 Windows 中文路径处理

## 已验证

- Windows 安装包可以启动 Electron 与 Python Sidecar
- Chrome 扩展真实入队并完成下载
- Telegram 已完成测试消息、8 秒样片与 148.83 MB 视频分段发送验收
- 分段视频画面比例、播放和中文标题验收通过

## 已知限制

- 安装包未签名，Windows SmartScreen 可能提示“未知发布者”，需选择“更多信息 → 仍要运行”
- 当前候选包默认使用 Telegram 云端 Bot API；大文件会分段发送，不宣称支持单文件 2 GB
- macOS 0.2.0 安装包需要在 Apple Silicon 环境完成后续构建与验收
