# Downany 官网视觉资产

本目录保存 2026-08-17 选定的“深色媒体舞台”官网方向及分段实施参考。

| 文件 | 用途 | 原始尺寸 |
|---|---|---:|
| `downany-website-concept-dark-media-v1.png` | 方案 1 全页节奏 | `862 × 1824` |
| `downany-website-hero-desktop-v1.png` | 桌面首屏 | `1586 × 992` |
| `downany-website-flow-recognition-v1.png` | 三步流程与网页识别 | `1468 × 1071` |
| `downany-website-capabilities-download-v1.png` | 能力、下载与 FAQ | `1346 × 1169` |
| `downany-website-mobile-v1.png` | 移动端重排 | `863 × 1822` |

## 生成说明

- 使用 Codex 内置图片生成能力逐张生成。
- 工具返回结果未暴露模型标识，因此不能独立证明实际模型为 `gpt-image-2`。
- 全部为非透明 PNG。
- 复制进仓库时未做裁切、缩放、调色或其他本地后处理。
- 视觉参考来自 `docs/assets/downany-main-window-glass-v1.png` 与 `desktop/build/icon.png`。

## 提示词范围

最终提示词组分别锁定：

1. 完整中文单页、真实产品预览、双平台下载、三步流程、网页识别、六项能力、安装说明、FAQ 与页脚。
2. `1440 × 900` 桌面首屏的双栏比例、两行标题、按钮尺寸、产品窗口和下一段露出。
3. 水平三步流程与全页唯一 `Reading Glass` 媒体场景。
4. 六项能力的单组列表、双平台下载状态和三项 FAQ。
5. `390px` 移动端的导航、CTA、纵向步骤、媒体玻璃、列表和 FAQ 重排。

共同负约束为：不使用虚假指标、口碑、价格、抽象渐变球、霓虹、卡片墙、嵌套卡片、Hero eyebrow、badge、pill、图库人物或水印。

这些图片是设计规格，不得作为整页背景交付。生产页面中的文字、按钮、导航、列表和 FAQ 必须由代码渲染。
