# Downany 官网 Design QA

## 比较目标

- 视觉真值：
  - `../docs/assets/website/downany-website-hero-desktop-v1.png`
  - `../docs/assets/website/downany-website-flow-recognition-v1.png`
  - `../docs/assets/website/downany-website-capabilities-download-v1.png`
  - `../docs/assets/website/downany-website-mobile-v1.png`
- 实现地址：`http://127.0.0.1:4173/`
- 浏览器：Codex 内置 Browser，IAB 实例；未切换到外部 Chrome。
- 页面状态：深色主题、未展开移动菜单、GitHub Release 已返回 `v0.1.0`；macOS 为可下载，Windows 为缺失资产降级态。

## 视口、像素与归一化

- 桌面实现：CSS 视口 `1440 × 900`，`devicePixelRatio = 1`，截图 `1440 × 900px`：`qa/implementation-desktop.png`。
- 桌面首屏来源：`1586 × 992px`，归一化到 `1440 × 900px` 后与实现同屏，比较图 `2880 × 900px`：`qa/comparison-desktop.png`。
- 三步与网页识别来源：`1468 × 1071px`。按来源中的实际分区裁成 `1468 × 423px` 和 `1468 × 648px`，等宽归一化后分别与实现同屏：`qa/comparison-workflow.png`、`qa/comparison-recognition.png`。
- 能力、下载与 FAQ 来源：`1346 × 1169px`。按分区裁切并等宽归一化到 `1440px` 画布，与 `1440 × 900px` 实现截图同屏：`qa/comparison-capabilities.png`、`qa/comparison-download-faq.png`。
- 移动实现：CSS 视口 `390 × 844`，`devicePixelRatio = 1`，首屏截图 `390 × 844px`：`qa/implementation-mobile.png`；完整滚动页由同一视口无缝拼接为 `390 × 3484px`：`qa/implementation-mobile-full.png`。
- 移动来源：`863 × 1822px`，属于非 1:1 的全页构图板，不是可直接对应 CSS 高度的浏览器截图。因此只将其顶部同状态区域裁为 `863 × 820px` 并归一化到 `390 × 844px`，用于判断顺序、层级和折叠结构，不对字号或纵向长度做伪精确比较。同屏证据：`qa/comparison-mobile.png`。

## Findings

当前没有未解决的 P0、P1 或 P2 问题。

- [P3] 桌面三步区比来源留白更充足。
  - 位置：`Workflow`。
  - 证据：`qa/comparison-workflow.png` 中来源更紧凑，实现保留了更大的上下呼吸空间。
  - 影响：不改变信息层级、首屏露出下一段标题的目标或任务路径。
  - 处理：保留。实现遵循 `1180px` 内容宽度和既定间距 Token，移动端时间线也未被压缩。

## 必查表面

- 字体与排版：实现使用规格中的系统字体栈，只使用 `400 / 500 / 600`；首屏、分区标题、正文、控件和辅助文案的字号与行高层级清楚。桌面 H1 固定两行，移动 H1 自然两行，无截断、重叠或异常字距。
- 间距与布局：桌面采用 `1180px` 内容宽度和稳定分区节奏；移动改为纵向 CTA、时间线、媒体在上和列表单列。`1440 × 900` 与 `390 × 844` 均满足 `scrollWidth = clientWidth`，没有横向滚动。
- 颜色与 Token：近黑冷调背景、实色抬升面、蓝色主操作与焦点、薄荷青能力图标均来自语义 Token。普通表面没有装饰性霓虹或大面积渐变，只有产品预览保留轻微抬升阴影。
- 图像质量与资源：品牌标志使用仓库真实 SVG；产品预览使用已确认视觉基准；网页识别媒体为独立生成资产，比例、裁切和暖色主体与来源一致。三张图都成功加载且有自然尺寸；没有用 CSS 图形、手写 SVG、Emoji 或占位框替代可见资产。
- 文案与内容：可见文案与设计规格一致。来源中的 Windows 可用态被真实 Release 事实替换为 `Windows 版准备中`；未显示无法证明的最低系统版本；Telegram 使用 `随下一版本提供。`。这些属于事实约束，不是设计漂移。
- 图标：交互与能力图标统一使用 Phosphor regular；尺寸、描边和对齐一致，品牌图形未被图标库替代。
- 交互与状态：桌面导航锚点、GitHub 外链、macOS 下载直链、Windows 缺失资产回退链接、移动菜单、Escape 关闭与焦点返回、FAQ 单项展开均已在 IAB 中验证。Release 状态为 macOS `ready`、Windows `missing`。
- 可访问性：页面有且仅有一个 H1；按钮和链接的可见点击区域均不小于 `44 × 44px`；焦点环可见；FAQ 使用原生 button 和 `aria-expanded`；移动菜单有可访问名称；图片具备替代文本；包含减少动画和减少透明度降级。

## 比较历史

### 第 1 轮：blocked

- [P2] 能力列表缺少来源中的统一抬升表面，图标颜色也未形成来源中的薄荷青分区识别。
- [P2] 桌面下载区采用左右分栏，偏离来源的居中下载路径；FAQ 列表缺少完整外框。
- [P2] 移动页脚 `GitHub` 与 `下载` 的可见点击宽度分别为 `43px` 和 `26px`，未满足项目的 `44 × 44px` 目标。

修正：

- 在 `src/styles/site.css` 中为能力列表增加单一抬升表面、外框和圆角，并将能力图标映射为薄荷青语义色。
- 将下载区改为居中层级，CTA 与安装说明归入同一主路径；为 FAQ 列表增加统一实色表面、完整外框和圆角。
- 为页头和页脚导航链接增加 `44px` 最小宽度并居中内容。

### 第 2 轮：passed

- `qa/comparison-capabilities.png` 显示能力列表已恢复为来源中的单组抬升表面，行分隔、标题、描述和箭头保持对齐。
- `qa/comparison-download-faq.png` 显示下载主路径已居中，FAQ 已具备统一外框；Windows 缺失态是明确的事实差异。
- IAB 复测所有可见交互目标后，`undersized = []`；移动页脚三条文字链接均至少 `44px` 宽、`44px` 高。
- 桌面与移动控制台的 `error`、`warn` 均为空；品牌图、产品预览和识别媒体全部加载成功。

## 主要浏览器验证

- 桌面 `1440 × 900`：导航、两个平台 CTA、Release 降级、Reading Glass、FAQ、外链属性、图片加载、控制台和横向溢出。
- 移动 `390 × 844`：菜单打开、Escape 关闭、焦点返回、纵向 CTA、三步时间线、Reading Glass、能力列表、FAQ 单项展开、点击目标和横向溢出。
- Reading Glass 全页仅一处；桌面宽度 `683px`，伪元素计算样式为 `blur(36px) saturate(1.2)`。

## Open Questions

- 产品预览仍是已确认视觉基准，不是发布包实机截图。正式公开发布前应以经过隐私检查的真实应用截图替换；这不阻塞本地官网验收。
- 移动来源是构图板而非 1:1 浏览器捕获，因此移动纵向长度只做结构性比较；实际实现以 `390 × 844` 的可读性、无溢出和完整交互为准。

## Implementation Checklist

- [x] 桌面与移动同视口截图
- [x] 首屏、三步、网页识别、能力、下载/FAQ、移动端同屏比较
- [x] P2 视觉差异修正并复拍
- [x] Release 真实状态与回退链接验证
- [x] 菜单、FAQ、焦点返回与点击目标验证
- [x] 控制台、图片加载和横向溢出验证

## Follow-up Polish

- 正式发布前替换产品预览为真实、去隐私信息的已验收应用截图。

final result: passed
