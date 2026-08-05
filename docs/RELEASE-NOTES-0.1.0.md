# Downany · 百纳 0.1.0

首个可分发未签名构建。

## 安装

1. 下载 `Downany-0.1.0-mac.dmg`
2. 将 Downany 拖入「应用程序」
3. **右键打开**（或 `xattr -cr /Applications/Downany.app`），因当前未公证
4. （可选）下载 `Downany-chrome-extension-0.8.1.zip`，解压后在 `chrome://extensions` 以开发者模式「加载已解压」

详见 [RELEASE.md](RELEASE.md)。

## 亮点

- Electron + Sidecar + yt-dlp 主线
- Chrome 扩展桥（`127.0.0.1:17888`）、页内下载、任务状态回传
- Cookie 从浏览器导入、内置浏览器抓取窗口
- 播放列表/合集选集与分组
- 元数据嵌入、HLS 分片并发
- 结构化失败码与设置页可操作引导
- 设置页检查 GitHub Releases 更新并前往下载

## 已知限制

- 未签名，受 Gatekeeper 提示
- YouTube 等站点常需有效浏览器 Cookie
- 自动应用内替换需后续签名 + electron-updater
