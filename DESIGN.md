# Downany · 百纳设计基线与待确认建议

检查日期：2026-10-18。状态：当前实现的源码基线与待确认建议；已纳入本次授权的任务空态修正，其余建议未实施。

## 使用边界

- **当前实现 / 已实现**：表示已在下述工作树源码中核对，包含尚未提交的 WIP；不代表已运行 UI、已安装应用或已发布版本的验收。
- **建议 / 待确认**：表示尚未实施的设计提议。用户同意接入 `opendesign-downany` 文本 skill 和加入本文件，不代表同意视觉改版、组件迁移或业务修改。
- 本文件与 [旧设计系统](docs/DESIGN-SYSTEM.md) 和 [旧 UI 设计语言](docs/UI-DESIGN-LANGUAGE.md) 并存，保留原文。旧文档与本文件描述不同的地方应先核查当前代码；未来视觉方向仍需用户决定。
- 使用设计指导时先确认任务属于 Downany，再读取本文件和目标代码。只分析或整理时保持只读；需要改变 UI、业务、依赖、系统权限或部署时，先取得对应任务授权。

当前可直接沿用的基准是 **珊瑚橙品牌、暖炭灰深色界面、浅色暖灰表面、顶部五项导航、左侧任务库、右侧媒体详情**。主工作台、品牌资源和扩展已采用这一方向；设置窗口、共享基础令牌、官网及旧规范仍存在蓝色/冷黑体系。本文保留这些实际差异，不能视为全产品已统一。

## 1. 取证范围与版本（接入时基线）

- 取证工作树：`chore/sync-main-20261010`（本文件放置于该工作树的项目根目录）。
- HEAD：`2ef84dfc36db71f7d1ecfa72d73599cf658076dd`。
- 本地分支：`chore/sync-main-20261010`。本次未联网刷新远端，不根据本地版本或分支状态推断公开发行版本。
- 实际源码：桌面端 `0.3.17`、Sidecar `0.3.17`、Chrome 扩展独立版本 `0.9.4`。见 E01、E02、E03。
- 用户报告最近安装版本为 `0.3.17`。本次未运行或检查已安装应用，不把源码核对等同于安装验收。
- 加入本文件前，已有 27 个 tracked 修改路径、7 个 untracked 状态条目（展开为 18 个文件）。品牌、图标、扩展、版本、工作台及验收资料均为原有 WIP；这些 WIP 包含本文件所描述的当前实现。
- 适用指引为仓库父目录和本工作树的 `AGENTS.md`；`desktop/` 未发现嵌套指引。查看官网时也读取了 `website/AGENTS.md`。
- 新增本文件前，项目未有根 `DESIGN.md`；原规范为 `docs/DESIGN-SYSTEM.md` 与 `docs/UI-DESIGN-LANGUAGE.md`。二者仍写“待实现”，与当前工作台不一致。根 `AGENTS.md` 仍写桌面端 `0.3.2`/扩展 `0.9.2`，版本核对应以实际版本文件为准。见 E04、E05。

首次接入仅使用源码、样式、工作树内的设计文档与 Git 状态；当时上一轮草案涉及的 22 份关键源码指纹和原有 Git 状态保持一致，未运行应用或测试。证据使用本仓库根相对路径，HEAD 不包含全部品牌 WIP。

后续用户已明确授权修正任务空态：当前无任务时显示“还没有下载任务 / 新建下载”，有任务但无匹配时显示“没有匹配的任务 / 显示全部任务”，按钮复用既有添加对话框与筛选恢复路径；已同步中英文文案。验证使用隔离源码副本和本机已有依赖，44项相关测试及 Main/Renderer 类型检查通过；隔离浏览器假数据预览也验证了新建对话框的打开/关闭与清筛选恢复列表，页面未报控制台错误。未安装依赖、启动日常应用、打包安装、改下载业务、读取凭据、提交或推送。首次快照加载行为没有在本次增加新的就绪状态判断。见 E21、E31。

## 2. 颜色与品牌

### 2.1 品牌标识（已实现）

- 图形保留“播放三角形 + 下载箭头 + 托盘”，主稿为 `assets/brand/logo-mark.svg`。
- 标识珊瑚橙为 `#ed7051`，深色界面中的产品标识也保持此色。
- 应用图标暖炭灰底为 `#252825`，与深色标题栏一致。
- 托盘用同轮廓单色模板；品牌图形与下载、播放、暂停等行为图标分开。
- 当前 `BrandMark` 引用共享 SVG，设置 `alt=""` / `aria-hidden="true"`，作为产品名称旁的装饰图形。见 E06、E07。

### 2.2 主工作台主题（已实现，作用域 `.workbench`）

下表为当前 CSS 的最终主题变量；初始 `.workbench` 的静态声明随后由 `--text` / `--app-bg` 覆盖。来源为 E08。

| 用途 / 变量 | 浅色 | 深色 |
|---|---|---|
| 主内容底 `--app-bg` | `#ffffff` | `#202321` |
| 标题工具栏 `--titlebar-bg` | `#fbfaf8` | `#252825` |
| 任务侧栏 `--sidebar-bg` | `#f7f6f3` | `#282b27` |
| 控件表面 `--surface` | `#f5f4f1` | `#2d312d` |
| 抬升表面 `--surface-raised` | `#ffffff` | `#30342f` |
| 悬停表面 `--surface-hover` | `#eeede9` | `#383e37` |
| 主文字 `--text` | `#252623` | `#edf0e9` |
| 次要文字 `--text-secondary` | `#747773` | `#abb1a7` |
| 弱提示 `--text-muted` | `#989a96` | `#7f887b` |
| 普通描边 `--border` | `#e7e7e2` | `#373d35` |
| 强描边 `--border-strong` | `#d9dbd5` | `#4b5447` |
| 主动作 `--accent` | `#ed7051` | `#f08c6e` |
| 主动作悬停 `--accent-strong` | `#dc5d3f` | `#f5a48c` |
| 选中背景 `--accent-soft` | `#fae9e2` | `#49362e` |
| 选中悬停 `--accent-soft-hover` | `#f7dfd4` | `#584034` |
| 键盘焦点 `--focus` | `#237cbd` | `#8bc9ff` |
| 成功 `--green` / 浅底 | `#32a36b` / `#e9f5ed` | `#79c59b` / `#2b4032` |
| 下载进度 `--blue` / 浅底 | `#4685b6` / `#e9f2f8` | `#80b4d9` / `#2b3c47` |
| 警告/需登录 `--amber` / 浅底 | `#b77d25` / `#fcf3e4` | `#e7bc70` / `#443a2a` |
| 失败 `--red` / 浅底 | `#cf685d` / `#fbefed` | `#e69a8e` / `#45332f` |

主操作的橙色与进度的蓝色具有不同语义，不能把蓝色进度全部改成橙色。暂停、取消采用中性灰；状态同时展示文字。品牌橙、深色主动作橙和焦点蓝也分别有明确用途。

### 2.3 其他表面现状（已实现，尚有差异）

| 载体 | 当前事实 | 对未来修改的约束 |
|---|---|---|
| 设置窗口 / 共享 UI | `design-system/tokens.css` 深色为冷黑 `#0b0d10`，强调色 `#5b7cfa`；浅色强调 `#4f6ee8`。设置入口加载共享 `styles.css` | 不能声称已全部使用暖炭与珊瑚；统一需单独改造并验证 |
| Chrome 弹窗 / 安装引导 | 已改为 `#202321` 暖炭底、`#f08c6e` 强调；成功/失败仍有独立值 `#4ade80` / `#f87171` | 保留扩展的密度和媒体类别徽标语义，不机械复制桌面尺寸 |
| 官网 | 本地 token 仍为冷黑 `#0b0d10`、蓝强调 `#397bff`；图形资源已更新 | 标识更新不代表官网配色已统一，也未核验在线部署 |
| 全局 Toast / 连接失败页 | `Shell` 将 `ToastHost` 置于工作台外，样式依赖共享 token | 不应把 `.workbench .toast` 作为现行全局 Toast 的最终样式 |

来源：E09、E10、E11、E12、E13。

建议（未实施）：后续保留一个语义令牌源，再按主工作台、工具表面与宿主原生载体生成配置；先审查引用，再迁移，避免直接全局替换同名变量。

## 3. 字体与排版

已实现：

- 主工作台使用本机字体：`-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif`。
- 共享基础字体还包含 `"Segoe UI"`、`"Microsoft YaHei UI"`、`"Noto Sans SC"`。当前不存在必须付费或在线加载的字体要求。见 E08、E09。
- 当前主要排版见下表；不是旧规范中的统一 11/12/13/15/18/20 六档。

| 角色 | 当前值 | 证据 |
|---|---|---|
| 顶部导航 | `12px`，激活 `600`；≤800px 为 `11px` | E14 |
| 任务侧栏标题 | `12px` | E14 |
| 任务名称 / 元信息 | `12px` / `10.5px`（现代壳覆盖旧值） | E14 |
| 详情标题 | `28px / 1.4`，字重 `650`，随窗宽降到27/25px等 | E15 |
| 详情按钮 | `13px / 1.3`，字重 `550` | E16 |
| 分组标题 | `13px`，字重 `600` | E17 |
| 新建下载对话框标题 | `21px / 1.35`，字重 `650` | E18 |
| 设置页标题 | `21px / 28px`，字重 `600` | E12 |

速度、大小、时间、进度等部分数值区域已使用 `tabular-nums`。路径和诊断信息有系统等宽字体样式。主工作台部分中文仍硬编码，不能把双语支持写成所有文案均已完成。

建议（未实施）：新文案沿用对象、动作、状态、结果的中文表达；后续整理字体与排版 token 时保留当前已落地层级，不直接强行套回旧文档的小字号表。极小窗口下的 8–10px 字号需在下一次获准运行 UI 后检查可读性。

## 4. 间距、布局与尺寸

共享 token 已定义 `2 / 4 / 8 / 12 / 16 / 20 / 24 / 32 / 40px`，但现行工作台还大量使用 `3 / 5 / 7 / 9 / 10 / 14 / 18 / 22 / 27px` 等值。严格 8px 网格目前是旧规范的目标，不是已实现事实。见 E09、E14–E18。

当前布局基准：

- **工具栏**：现代壳高 `64px`；窗口高度≤640px 时为 `56px`。左侧应用菜单，中央主导航，右侧新建下载。不能引用旧基础样式的 54px 或旧规范的 44px 作为当前默认。
- **任务视图**：左侧任务库 `280px`；宽度≤800px 为 `240px`；右侧详情自适应。其他主要视图使用单列内容区。任务行最小高 `70px`，缩略图 `46×38px`。
- **详情区**：内容最大宽 `1060px`，默认内边距 `32px 40px 22px`；窄窗逐步缩小。媒体预览为 `16:9`，真实视频使用 `object-fit: contain`，编辑态最大高 `35vh` / 最大宽 `640px`。
- **管理/合集/历史**：主内容最大宽 `1400px`，默认内边距 `28px 36px 48px`；管理行最小高 `76px`。
- **设置窗口**：侧栏 `190px`，宽度≤820px 为 `166px`；正文独立滚动，底部保留保存反馈栏。
- **新建下载对话框**：宽 `600px`，受窗口宽减40px和窗口高减56px限制，内部滚动。

来源：E12、E14、E15、E18、E19。

建议（未实施）：新布局优先使用已有语义间距；将当前特例按用途归档，避免边整理规范边“顺手统一”所有数值。现有 CSS 有历史与现代壳叠加，本次只读核对不能代替小窗口布局验收。

## 5. 圆角与表面

| 用途 | 当前实现 |
|---|---|
| 详情主/次按钮、状态徽标 | `6px` |
| 顶部导航、搜索、普通提示 | `7px` |
| 任务行、批量选择栏、导出状态容器 | `8px` |
| 媒体预览、应用菜单、合集外框 | `9px` |
| 工作台局部 Toast | `10px`（全局 Toast 为12px） |
| 确认对话框（工作台内覆盖）、设置卡片 | `12px` |
| 新建下载对话框 | `15px` |
| 更多操作菜单 | 外框 `18px`、菜单项 `12px`，另有组件内样式 |
| 共享 token 档位 | `6 / 8 / 10 / 12 / 14px`，与上述不完全相同 |

来源：E09、E12、E14–E18、E20。旧文档的“只使用五档圆角”不是当前代码事实。

主工作台以实色分层为主；媒体覆盖层、弹出菜单与部分预览状态使用局部透明/模糊。旧文档中的强阅读玻璃是历史设计方向，不能据此把当前工作台重新改成满屏玻璃。

## 6. 导航与按钮

### 6.1 导航（已实现）

- 顶层视图：**任务 / 队列 / 合集 / 历史 / 搜索**；设置位于 Downany 应用菜单。
- 任务筛选：**全部任务 / 进行中 / 已完成 / 需处理**，同时显示计数；“需处理”包含失败与取消。
- 激活主导航为中性抬升底、文字提亮和600字重；激活任务筛选/任务行使用橙色浅底。不是旧规范的2px短下划线。
- 顶部导航支持左右方向键、Home、End；任务列表支持上下键、Home、End；导航用 `aria-current`，筛选用 `aria-pressed`。
- 快捷键有新建 `⌘/Ctrl+N`、搜索 `⌘/Ctrl+F`、设置 `⌘/Ctrl+,` 等。界面部分提示仍固定显示 `⌘`，跨平台提示尚未完全一致。

来源：E13、E21。

### 6.2 当前两套按钮

| 范围 | 当前样式/尺寸 | 异步行为 |
|---|---|---|
| 工作台详情主按钮 | 实心珊瑚橙，常规最小高40px、左右16px、圆角6px；浅色白字，深色暖炭字 | 由各业务按钮自行处理，不具备统一 loading 契约 |
| 工作台详情次按钮 / 图标按钮 | 表面底+描边；图标按钮40×40px；文件行缩至32px | 悬停表面加深；禁用 `.42` 不透明度 |
| 顶栏“新建下载” | 34px最小高、12px文字 | 打开原生 `<dialog>` 添加流程 |
| 共享 `Button` | `primary / secondary / ghost / danger`，常规32px、小型28px，圆角8px；primary浅色底+强调色字 | `loading` 禁用并设 `aria-busy`；不自动插入转圈图标或替换文案 |

工作台键盘焦点为3px蓝色描边、偏移3px；共享 Button 为2px焦点阴影；设置控件用2px强调色轮廓。三者尚未统一。来源：E12、E16、E22。

实际颜色静态计算：浅色主按钮白字在 `#ed7051` 上约 `2.98:1`，悬停 `#dc5d3f` 上约 `3.70:1`；深色主按钮 `#242522` 字在 `#f08c6e` 上约 `6.37:1`。这是按 CSS 实色的 sRGB 相对亮度计算，不是运行中截图或完整可访问性验收。后续应决定按钮字色或交互橙深度，品牌标志橙可以独立保留。

## 7. 加载、空态与错误

### 7.1 加载和任务状态（已实现）

- 六态：等待中、下载中、已暂停、已完成、下载失败、已取消。
- 下载百分比达到100%但尚未终态时显示“正在处理与校验”，不能提前称为完成。
- 下载详情可显示百分比、已下载/总量、速度与剩余时间；本地文件检查显示“正在检查本地文件”。
- 新建下载有解析、取消解析、正在添加等明确阶段；提交期间禁用重复操作。只有创建成功后才计入“已添加”。
- 导出使用 `aria-live="polite"`、原生 `<progress>` 和取消动作；正在导出/提交时禁止重复导出。
- 主下载进度仍为普通 `div/i`，不能声称全局均使用 `progressbar` 语义。部分一般任务操作未统一暴露 pending 状态。
- `prefers-reduced-motion` 已大幅缩短工作台动画与过渡。

来源：E23、E24、E25、E26。

建议（未实施）：异步动作保留动作名称与占位宽度，给出阶段文字；主下载/检查与共享 Button 补齐一致的 busy/进度语义。能确定进度时显示真实进度，不能确定时用阶段文字，不伪造百分比。

### 7.2 空态（按实际入口区分）

| 场景 | 当前表现 | 待完善 |
|---|---|---|
| 首次没有任务 | 侧栏“新建下载，开始第一个任务”；详情“还没有下载任务”，说明“添加视频链接，开始第一个下载。” | 已提供“新建下载”按钮，复用现有添加对话框；关闭不创建任务 |
| 筛选/搜索无匹配任务 | “没有匹配的任务”，说明“试试其他关键词，或查看全部任务。” | “显示全部任务”清除搜索、状态与需处理筛选，恢复已有列表 |
| 旧 `TaskList` 空态 | 独立 `EmptyState` 含“添加第一个下载任务 / 粘贴视频链接” | 当前工作台未引用，不能写成已接入 |
| 本地成品缺失或不支持预览 | “本地文件缺失或暂不支持预览”，提示检查原保存位置 | 区分文件缺失与仅预览编码不支持，继续保留系统打开/恢复路径 |

来源：E21、E24、E27。

### 7.3 失败、连接和反馈（已实现）

- 失败恢复按原因提供动作：公开下载、网页登录/打开作品网页、网络设置、下载工具、保存位置、应用更新、导出诊断。已删除内容不盲目重试；缺媒体工具不直接重试；成品验证失败重新下载前确认保留已有文件。
- 主详情失败提示用红色浅底、红字和混合描边，同时展示解释。提示容器通常圆角7px、内边距12×14px。
- 内置播放器不能播放时提示可用系统播放器打开；该情况不自动等同于下载失败。
- 只有连接状态为 `failed` 时 `Shell` 切换整页 `ConnectionGate`；连接中/重连中仍显示工作台。失败页有 `role="alert"`、重连、日志目录和运行版本；忙碌时不重复重连。
- 全局 Toast 用 `role="status"`；普通通知4秒关闭，sticky保留；焦点位于通知内时不自动关闭。它位于工作台外，样式依赖共享表面。
- 确认弹窗用 `alertdialog`，默认聚焦取消、限制Tab循环并恢复原焦点；忙碌时禁用操作、阻止Esc或背景取消。

来源：E13、E17、E24、E28、E29、E30。

建议（未实施）：保留“发生了什么 → 可理解原因 → 下一步动作”的错误结构；任务自身错误优先留在任务区域，短操作结果用Toast，破坏性动作再用确认。不要借视觉规范变更下载、重试或文件保留语义。

## 8. 需要用户决定的冲突

以下事项尚未决定；加入本文件只记录现状和选择，不在工作树中实施视觉迁移。

| 事项 | 当前差异 | 建议的最小决策 |
|---|---|---|
| 品牌适用范围 | 工作台/扩展已珊瑚暖炭，设置/共享token/官网仍冷黑蓝色 | 确认是否按“工作台→设置与共享组件→官网”逐步统一；本文建议按此顺序 |
| 旧规范更新 | 两份原规范仍“待实现”，强调蓝色、短下划线、强玻璃；现代码已换方向 | 本文记录0.3.17当前工作台事实；是否重写原规范与采用哪项未来视觉提案仍待确认 |
| 按钮与圆角 | 两套primary、32/40px高度及6/8/更多圆角并存 | 先分清业务/基础用途；下一轮决定是否合并组件，不批量替换 |
| 焦点与按钮文字 | 三种焦点环；浅色橙底白字对比偏低 | 保留清晰焦点；决定统一2px或3px及按钮字色/交互橙深度 |
| 字号、间距、小窗 | 旧严格档位与当前650字重、27px等特例不一致；小窗规则历史叠加 | 先记录实际值，获准运行UI后再按截图整理，不强套旧规则 |
| 本地化与异步语义 | 当前工作台部分硬编码中文，loading/aria语义分散 | 作为后续组件整理范围，不视为本次已完成 |

供 `opendesign-downany` 及后续文本设计指导使用的约束：先按现有真实产品与任务分析，保留当前珊瑚橙/暖炭品牌、状态语义和文件安全；使用系统字体与现有矢量；任何视觉建议需标成建议。文本 skill 的接入不授权顺带安装软件、执行脚本、改 UI 或业务、运行应用、扩大系统权限、部署或接入付费服务。

## 9. 证据索引

下列行号对应2026-10-18检查时的**未提交工作树**，HEAD本身不包含所有品牌WIP。链接相对项目根目录；后续代码变动可能使行号变化，应以对应源码为准。

| 编号 | 源文件与起始行 |
|---|---|
| E01 | [desktop/package.json:3](desktop/package.json#L3) |
| E02 | [src/sidecar/protocol.py:8](src/sidecar/protocol.py#L8) |
| E03 | [browser-extension/manifest.json:4](browser-extension/manifest.json#L4) |
| E04 | [docs/DESIGN-SYSTEM.md:3](docs/DESIGN-SYSTEM.md#L3)；[AGENTS.md:7](AGENTS.md#L7) |
| E05 | [docs/UI-DESIGN-LANGUAGE.md:3](docs/UI-DESIGN-LANGUAGE.md#L3)，旧导航/强调见29、36、37行 |
| E06 | [assets/brand/README.md:3](assets/brand/README.md#L3)，颜色见15–17行 |
| E07 | [desktop/renderer/components/ui/BrandMark.tsx:1](desktop/renderer/components/ui/BrandMark.tsx#L1) |
| E08 | [desktop/renderer/styles/workbench.css:1](desktop/renderer/styles/workbench.css#L1)，浅色10–34行，深色37–63行，最终根样式89–93行 |
| E09 | [design-system/tokens.css:1](design-system/tokens.css#L1)，浅色39–73行，字体/间距/圆角115–138行 |
| E10 | [browser-extension/popup.css:1](browser-extension/popup.css#L1)；[install.css:1](browser-extension/install.css#L1) |
| E11 | [website/src/styles/tokens.css:1](website/src/styles/tokens.css#L1) |
| E12 | [desktop/renderer/styles.css:791](desktop/renderer/styles.css#L791)，设置791–851行；全局Toast540–565行；[settings-main.tsx:4](desktop/renderer/settings-main.tsx#L4) |
| E13 | [desktop/renderer/components/Shell.tsx:117](desktop/renderer/components/Shell.tsx#L117)，快捷键26–41行；[lib/documentTheme.ts:11](desktop/renderer/lib/documentTheme.ts#L11) |
| E14 | [desktop/renderer/styles/desktop-shell.css:2](desktop/renderer/styles/desktop-shell.css#L2)，导航/侧栏2–34行，适配98–103行 |
| E15 | [desktop/renderer/styles/workbench.css:162](desktop/renderer/styles/workbench.css#L162)，详情162–180行，响应427行起，末尾媒体覆盖623–630行 |
| E16 | [desktop/renderer/styles/workbench.css:209](desktop/renderer/styles/workbench.css#L209)，按钮209–219行、禁用/焦点66–75行 |
| E17 | [desktop/renderer/styles/workbench.css:228](desktop/renderer/styles/workbench.css#L228)，提示228–235行，分组237行，Toast346行，空态353行 |
| E18 | [desktop/renderer/styles/new-download.css:16](desktop/renderer/styles/new-download.css#L16)，对话框16–20行、标题38–47行 |
| E19 | [desktop/renderer/styles/desktop-shell.css:34](desktop/renderer/styles/desktop-shell.css#L34)，管理行58行、确认对话框92–97行 |
| E20 | [desktop/renderer/components/task/TaskActionsMenu.tsx:49](desktop/renderer/components/task/TaskActionsMenu.tsx#L49)，菜单面板127–138行 |
| E21 | [desktop/renderer/components/TaskWorkbench.tsx:44](desktop/renderer/components/TaskWorkbench.tsx#L44)，导航/筛选/空态44行起；样式导入21–22行 |
| E22 | [desktop/renderer/components/ui/Button.tsx:9](desktop/renderer/components/ui/Button.tsx#L9)，loading35–65行；[styles/ui.css:1](desktop/renderer/styles/ui.css#L1) |
| E23 | [desktop/renderer/components/task/taskPresentation.ts:33](desktop/renderer/components/task/taskPresentation.ts#L33)，动作118–131行；[lib/workbenchPresentation.ts:7](desktop/renderer/lib/workbenchPresentation.ts#L7) |
| E24 | [desktop/renderer/components/TaskWorkbench.tsx:73](desktop/renderer/components/TaskWorkbench.tsx#L73)，文件/媒体/错误/进度见 TaskDetail |
| E25 | [desktop/renderer/components/NewDownloadDialog.tsx:23](desktop/renderer/components/NewDownloadDialog.tsx#L23)，解析/添加47–71行、阶段按钮94行；[task/useTaskCommands.ts:40](desktop/renderer/components/task/useTaskCommands.ts#L40) |
| E26 | [desktop/renderer/styles/workbench.css:611](desktop/renderer/styles/workbench.css#L611) |
| E27 | [desktop/renderer/components/EmptyState.tsx:11](desktop/renderer/components/EmptyState.tsx#L11) |
| E28 | [desktop/renderer/components/task/failureRecovery.ts:24](desktop/renderer/components/task/failureRecovery.ts#L24)，恢复映射24–95行 |
| E29 | [desktop/renderer/components/ConnectionGate.tsx:20](desktop/renderer/components/ConnectionGate.tsx#L20)；[RuntimeStatus.tsx:12](desktop/renderer/components/RuntimeStatus.tsx#L12) |
| E30 | [desktop/renderer/components/ToastHost.tsx:11](desktop/renderer/components/ToastHost.tsx#L11)；[ConfirmDialog.tsx:4](desktop/renderer/components/ConfirmDialog.tsx#L4) |
| E31 | [desktop/renderer/components/TaskWorkbench.test.tsx:22](desktop/renderer/components/TaskWorkbench.test.tsx#L22)，空库、筛选恢复、旧选中项与中英文空态回归 |

首次接入新增本文件与用户级纯文本 skill；后续仅按授权修正任务空态、增加相关翻译和测试，项目原有 WIP 与下载业务保持不变。
