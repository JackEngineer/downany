# 产品路线图：从 yt-dlp GUI 到专业下载器

日期：2026-08-01  
状态：待评审  
标杆：Downie 4（macOS 专业百纳）

## 1. 当前基线

Electron 主线（`desktop/` + `src/sidecar/` + `src/core/`）已具备的能力：

- **下载核心**：6 态任务机（pending / downloading / paused / completed / failed / cancelled）、优先级调度、并发上限、限速、暂停恢复（中断 + 重新入队，依赖 yt-dlp 续传）、崩溃恢复
- **持久化**：`task_queue` 队列表、`download_history` 历史表、`JsonConfig` 15 项设置
- **协议**：Sidecar JSON Lines，24 个 request method + 11 个 event
- **入队入口**：手动粘贴、拖放 URL、剪贴板监控、Chrome 扩展（HTTP 桥 127.0.0.1:17888）、`downany://`、`.webloc`
- **桌面集成**：原生菜单、通知（含失败重试 action）、Dock 角标与进度、可选菜单栏 Tray、窗口几何持久化、浅深主题
- **平台**：显式识别 YouTube / Bilibili / 抖音 / TikTok / Twitter / Instagram / Pornhub，其余交由 yt-dlp（1752 个 extractor）
- **维护**：yt-dlp 应用内更新、旧 Trae 数据迁移

骨架已经完整。以下路线图只聚焦"骨架之外"的差距。

## 2. 差距地图

| 能力 | Downie 4 | 当前实现 | 差距 |
|---|---|---|---|
| 内置浏览器抓取 / 登录墙 | 核心能力 | 无 | 致命 |
| 浏览器 Cookie 导入 | 内建 + 站点账号 | 仅扩展传 header cookie（`ytdlp_cookies.py`） | 致命 |
| 播放列表 / 合集 / 频道 | 选集面板 + 分组 | `noplaylist: True` 硬禁用 | 高 |
| 字幕（语言 / 内嵌 / 翻译） | 完整 | 布尔开关 + 自动字幕 | 高 |
| 封面 / 元数据 / 章节嵌入 | 默认写入 | 无 | 高 |
| 应用自更新 + 签名公证 | Sparkle + 已公证 | 无自更新、未签名 | 高 |
| 队列拖拽排序 / 多选 | 有 | 仅整数 `priority` | 中 |
| 分片并发加速 | 有 | 无 `concurrent_fragment_downloads` | 中（体感最强） |
| 后处理链 | 可组合 + 外部应用 | 单选 none/mp4/mp3/script | 中 |
| 自动化（Shortcuts / AppleScript / CLI） | 全部支持 | 仅 `downany://add` | 中 |
| 多浏览器扩展 | Safari / Chrome / Firefox / Edge | 仅 Chrome MV3 | 中 |
| 多语言 | 20+ | 文案硬编码中文 | 低 |
| 片段裁剪 / SponsorBlock | 不支持 | 不支持 | 差异化机会 |

**核心判断**：Downie 的专业感来自三点——命中率（下不了的也能下）、成品质量（下完即可用）、产品化（能交付给别人）。M0–M2 全部围绕这三点。

## 3. 里程碑

### M0 — 收敛与地基

**问题**（历史）：旁线 UI 与主线争资源，CI 曾未覆盖 `desktop/`。现已收敛为 Electron + Sidecar 唯一主线。

| # | 任务 | 落点 |
|---|---|---|
| 0.1 | 移除 PyQt / Swift 旁线，README / AGENTS.md 声明 Electron 主线唯一 | 已完成 |
| 0.2 | CI 覆盖主线：`tsc --noEmit`、`npm test`、`npm run build`、扩展 `shared.test.js`；pytest 收窄到 `tests/core tests/data tests/sidecar` | `.github/workflows/ci.yml` |
| 0.3 | 签名 + 公证走通，产出可分发 DMG | `scripts/notarize_macos.sh`、`desktop/electron-builder.yml` |
| 0.4 | 应用自更新通道（electron-updater + 更新 feed），设置页可查看/触发 | `desktop/electron/`、`SettingsApp.tsx` |
| 0.5 | 导出诊断包：近期日志 + yt-dlp / ffmpeg 版本 + 失败任务 verbose 输出 | Sidecar 新增 `app.exportDiagnostics` |

**验收**：CI 在 PR 上跑通主线三项检查；在一台未安装开发环境的 Mac 上双击 DMG 可直接运行（无 Gatekeeper 拦截）；应用内可检测到新版本并完成一次自更新。

### M1 — 命中率（护城河，投入产出最高）

| # | 任务 | 说明 |
|---|---|---|
| 1.1 | **内置浏览器抓取窗口** | Electron 窗口 + 独立 persist session 保住登录态，`webRequest` 监听 m3u8/mpd/mp4。**复用 `browser-extension/shared.js`**：DOM 扫描、master playlist 解析、分片过滤、Twitter CDN 孤儿流过滤等逻辑已实现，可直接搬入桌面端 |
| 1.2 | 解析失败自动引导至 1.1，并支持手动"用浏览器打开" | `download.parseUrls` 失败路径 |
| 1.3 | **Cookie 导入**：yt-dlp `cookiesfrombrowser`（Chrome / Safari / Firefox / Edge）+ 手动 Netscape 文件导入 | 扩展 `src/core/ytdlp_cookies.py` |
| 1.4 | 站点凭据管理页，密钥存 Keychain | 新增设置 Tab |
| 1.5 | **结构化错误码**：need_login / geo_blocked / private / removed / network / ytdlp_outdated / need_po_token / unsupported，替代裸 `error_message` | `download_task.py`、`downloader.py`、`protocol.py` |
| 1.6 | 失败卡片行内可操作按钮：导入 Cookie、用浏览器抓取、更新 yt-dlp、换代理重试 | `DownloadCard.tsx` |
| 1.7 | yt-dlp 健康自检：启动时静默检查版本与 EJS/deno 运行时可用性，可选 nightly 通道 | `ytdlp_opts.py`、`ytdlp_updater.py` |
| 1.8 | 扩展适配 Firefox / Edge（Safari 需 Xcode wrapper，延后至 M4） | `browser-extension/` |

**验收**：准备一组回归 URL（需登录站点、纯 HLS 播放器页、地区限制页、已删除视频），每条都能下载成功或给出正确分类的错误码与可操作建议；内置浏览器抓取在登录后可成功入队。

### M2 — 成品质量（下完即可用）

| # | 任务 | 说明 |
|---|---|---|
| 2.1 | **播放列表 / 合集 / 频道**：解除 `noplaylist`，`download.parseUrls` 增加 playlist 模式返回条目列表 | `downloader.py` L157、`url_parser.py` |
| 2.2 | 选集面板（全选 / 范围 / 反选）+ 任务分组折叠 | 新增 `PlaylistPicker.tsx`，`task_queue` 加 `group_id` |
| 2.3 | 覆盖 YouTube playlist、Bilibili 多 P 与合集、抖音合集 | 各平台回归用例 |
| 2.4 | **字幕体系**：语言多选（含 `zh-Hans` / `en` / 自动字幕）、内嵌 vs 独立文件、`--convert-subs` 格式转换 | `download_manager.py` L510 |
| 2.5 | **元数据嵌入**：`writethumbnail` + `embedthumbnail` + `embedmetadata` + `embedchapters` | `download_manager.py` opts 组装 |
| 2.6 | **落盘规则**：按站点 / 播放列表建子文件夹、非法字符与超长路径处理、重名冲突策略、临时目录 + 完成后移动（避免云同步目录被 `.part` 污染） | `filename_template` 扩展 |
| 2.7 | **后处理管线**：由单选改为可组合（提取音频 → 转码 → 嵌入元数据 → 加入 Music.app → 自定义脚本），支持预设 | `postprocessing` 字段升级为数组 |
| 2.8 | 差异化：`--download-sections` 时间段裁剪 | Downie 不具备 |
| 2.9 | 差异化：`--sponsorblock-remove` 自动去广告 / 片头 | Downie 不具备 |

**验收**：一条 YouTube playlist 可选择性下载并落入独立子文件夹；产出的 mp4 / m4a 在访达与 Music.app 中显示正确标题、封面、章节；字幕语言按设置生效。

**注意**：2.7 涉及 `options_json` 结构变更，需要 `queue_store.py` 的向前兼容迁移。

### M3 — 队列与交互

| # | 任务 |
|---|---|
| 3.1 | `concurrent_fragment_downloads` 分片并发（HLS 常见提速 3–8 倍）+ 单任务限速实时生效 |
| 3.2 | 队列拖拽排序（需 Sidecar 新增 reorder API，替代仅靠 `priority` 排序）|
| 3.3 | 多选（⌘ / ⇧）+ 批量操作 + 键盘导航 |
| 3.4 | 原生右键菜单（当前 `desktop/` 全无 `contextmenu`）|
| 3.5 | 拖 URL 到 Dock 图标入队（Downie 招牌交互）、macOS Services 菜单、全局快捷键 |
| 3.6 | 队列调度：整队暂停、"稍后下载"篮子、限定时段下载 |
| 3.7 | 首启引导与空态：引导装扩展、选目录、试跑一条链接 |

**验收**：同一条 HLS 视频在开启分片并发后下载耗时显著下降；队列可拖拽重排且重启后顺序保留。

### M4 — 自动化与生态

| # | 任务 |
|---|---|
| 4.1 | CLI：`downany add <url> --audio --quality 1080p`（本质是第二个 Sidecar 客户端，架构天然支持）|
| 4.2 | macOS Shortcuts（App Intents）+ AppleScript 支持 |
| 4.3 | `downany://` 参数化：quality / audio / folder / subs |
| 4.4 | 监听文件夹、`.txt` 批量导入、队列导出 |
| 4.5 | i18n（zh-CN + en 起步）——文案当前全硬编码，越晚拆越贵 |
| 4.6 | 应用内"支持站点"页：把 `docs/yt-dlp-extractors.md` 的 1752 个 extractor 做成可搜索页 |
| 4.7 | Safari 扩展（Xcode Web Extension wrapper）|

### M5 — 可持续（若商业化）

- 官网 + 更新 feed + 许可 / 试用
- 可选的匿名失败上报：知道哪些站点失败率高，是持续维持命中率的数据基础

## 4. 若只做三件事

1. **内置浏览器抓取 + Cookie 导入**（M1.1 / M1.3）——从"能下大站"到"什么都能下"，且大量复用现成扩展代码
2. **播放列表 + 元数据嵌入**（M2.1 / M2.5）——从"下到文件"到"下到能用的文件"
3. **签名公证 + 应用自更新**（M0.3 / M0.4）——从"自己用的工具"到"能给别人用的软件"

## 5. 明确不做

- **Windows / Linux**：当前代码高度 macOS 化（Dock、Tray、vibrancy、Keychain、公证），跨平台会分散全部精力
- **DRM 站点**（Netflix 等）：技术与法律双重不可行
- **自研下载引擎替代 yt-dlp**：yt-dlp 的 extractor 维护量无法自建
- **把站内搜索做大**：浏览器扩展 + 内置浏览器抓取已覆盖发现入口，Downie 亦无此功能

## 6. 分支管理

- **`main` 始终可发布**；不做长寿命里程碑分支。
- **一叶子任务一分支一 PR**，命名 `feat/m{N}-{slug}` / `chore/{slug}` / `fix/{slug}`（例：`feat/m1-sniff-core`）。
- 并行任务用 `.worktrees/<branch>/` 隔离，合入后删除分支与 worktree。
- 第一批建议：`chore/ci-and-freeze-legacy`（M0.1+M0.2）→ `feat/m0-diagnostics`；可并行 `feat/m2-embed-metadata` 与 `feat/m1-sniff-core`。
- 开工前清理/归档旧分支（如 `feature/pornhub-search-support`、`feature/search-preview`）。

详细约定见执行计划中的「分支与工作区管理」一节。

## 7. 相关文档

- 分支约定：[`BRANCHING.md`](BRANCHING.md)
- 发布流程：[`RELEASE.md`](RELEASE.md)
- 商业化备忘：[`COMMERCIAL.md`](COMMERCIAL.md)
- yt-dlp 站点清单：[`yt-dlp-extractors.md`](yt-dlp-extractors.md)
