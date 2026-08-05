# 回归验收记录（2026-08-05）

对照 [roadmap.md](roadmap.md) M1/M2 验收标准。自动化基线全部通过后再做解析层真实 URL 抽检。

## 自动化基线

| 套件 | 结果 |
|------|------|
| `pytest tests/core tests/data tests/sidecar -q` | 通过（修复错误码后复跑） |
| `cd desktop && npm test && npm run build` | 67 tests + build 通过 |
| `node browser-extension/shared.test.js` | 通过 |

## 解析层真实 URL

| 场景 | URL / 手段 | 结果 | error_code | 备注 |
|------|------------|------|------------|------|
| YouTube 单条 | `jNQXAC9IVRw` | 失败（预期） | `need_login` | 2026 年 bot 墙；Cookie 路径代码正确写入 `cookiesfrombrowser`，本机 Chrome Cookie 仍不足以绕过 |
| YouTube playlist | 公开 list（抽检） | 依赖 Cookie / 可用 list | — | 入队前 `allow_playlist` 展开逻辑已有单测；现网常需 Cookie |
| 已删除视频 | 无效 youtube id | 正确失败 | `removed` | |
| 非视频页 | `example.com/not-a-video` | 曾误标 `removed` | → 修为 `unsupported` | 见缺陷 H1 |
| Bilibili 公开单条 | `BV1xx411c7mD` | 成功 | — | 标题/时长/platform 正常 |
| Cookie 导入 | `cookies_from_browser=chrome` | 选项生效 | — | Keychain 加密 Cookie 在部分环境下仍会被 yt-dlp 拒绝，属环境限制 |

## 代码路径抽检（无 UI）

| 能力 | 状态 |
|------|------|
| 结构化错误码 + DownloadCard 操作按钮 | 已落地；补强分类边界 |
| 内置浏览器抓取 (`extractWindow` / `mediaSniff`) | 已落地；`parseM3U8` 仅单测，未接入嗅探主路径（中） |
| 播放列表选集 / 分组 | `AddConfirmDialog` + `PlaylistGroupCard`；单任务仍 `noplaylist`（先展开再下） |
| 元数据嵌入 | `embed_metadata` 默认开，opts 完整 |
| 分片并发 | 设置项 + opts 已接 |
| 字幕语言 / 内嵌 / SponsorBlock / 片段裁剪 | 核心 opts 已有；**设置 UI 此前缺失 → 本次补上** |

## 缺陷清单

| ID | 级别 | 描述 | 处理 |
|----|------|------|------|
| H1 | 高 | `[generic]` 404 被标为 `removed`，非视频页无法引导「不支持」 | 已修：`UNSUPPORTED` 提前并匹配 `[generic]` |
| H2 | 高 | `HTTP Error 403` 落为 `unknown` | 已修：归入 `network` |
| H3 | 高 | `members-only`（连字符）落到 `private` 而非 `need_login` | 已修：`members.?only` 归登录 |
| H4 | 高 | 设置页无法配置字幕语言 / 内嵌字幕 / SponsorBlock / 片段裁剪 | 已修：质量 Tab 增加控件 |
| M1 | 中 | uploader closed account 文案未识别 | 已修：归入 `removed` |
| M2 | 中 | `parseM3U8` 未接入 extract 嗅探 | 记入 roadmap，本次不改 |
| M3 | 中 | YouTube 现网强依赖有效 Cookie；无 Cookie 时体验依赖失败引导 | 设计如此；文档提示 |
| L1 | 低 | roadmap 差距表未同步已实现能力 | 后续文档清理 |

## 结论

致命级：无。高级别均已在本次修复。发布前建议在有浏览器登录态的机器上再手测：扩展入队、extract 窗口、一条完整下载成品（封面/字幕）。
