# 官网资源来源

- `public/assets/logo-mark.svg`：复制自仓库 `assets/brand/logo-mark.svg`，未修改。
- `public/assets/downany-app-preview.png`：2026-10-10 在 Windows x64 实际运行 Downany `0.3.2` 打包应用后，通过窗口的原生截图接口捕获主窗口内容，尺寸为 `1104 × 695`。来源为 [CI 38024006884](https://github.com/JackEngineer/downany/actions/runs/38024006884) 的 Windows 工程候选，源码提交 `9f5ce04f864067a90b1a89a405efeb27eef64692`；该提交的 `desktop/` 与 `src/` 代码和正式标签 `v0.3.2`（`e2fff0a`）一致。使用真实 Main、Preload 和包内 onedir Sidecar，运行时确认版本 `0.3.2`、Sidecar 已连接。截图来自全新的隔离数据目录、Electron profile 与输出目录，使用临时扩展桥端口、迁移阻断标记并关闭协议注册和剪贴板监控；画面为空下载列表，无个人任务、账号或路径，未做本地后处理。它记录真实应用界面，不作为公开安装包哈希匹配或安装验收的证明。图片 SHA-256 为 `3774af6788f0b92212c19e0667e79626c9d50ee74017114c4d907dc4eda85dbf`。
- `public/assets/recognition-media.png`：2026-08-17 使用 Codex 内置图片生成能力，参考 `docs/assets/website/downany-website-flow-recognition-v1.png` 生成。输出为不透明 PNG，无文字、UI、Logo 或水印，未做本地后处理。

内置生成工具未返回可核验的模型 ID，因此本仓库不声称已独立确认具体图像模型版本。
