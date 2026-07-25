# Electron 迁移阶段 3：桌面集成与迁移 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐 macOS 桌面集成（菜单、通知、Dock 徽标、窗口几何、系统主题）、首次启动旧 Trae 数据迁移，以及 yt-dlp 应用内独立更新。

**Architecture:** 菜单/通知/Dock/窗口几何由 Electron Main 负责；主题跟随用 `nativeTheme`；迁移与 yt-dlp 更新在 Sidecar（拥有配置与数据目录），Main 在握手后调用 `app.runMigration` / `updater.*`，Renderer 展示结果。

**Tech Stack:** Electron `Menu`/`Notification`/`nativeTheme`；Python `plistlib` + `sqlite3`；yt-dlp GitHub release 下载与校验。

**规格来源:** 设计文档 §6.6、§9、§10、§13 阶段 3。

## Global Constraints

- 迁移：复制不移动、幂等、失败不破坏旧版、不自动删旧目录。
- yt-dlp 更新：用户显式触发；校验失败回退内置/当前可用版本。
- 通知仅在应用后台时发送。
- 不提交无关 WIP；标识符无 Trae。

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/sidecar/migration.py` | 新建 | Trae → VideoDownloader 迁移 |
| `src/sidecar/ytdlp_updater.py` | 新建 | 检查/下载/校验/切换 yt-dlp |
| `src/sidecar/handlers.py` | 修改 | `app.runMigration`、实装 updater |
| `src/sidecar/protocol.py` | 修改 | 如需新增 method 常量 |
| `desktop/electron/main.ts` | 修改 | 菜单、通知、Dock、窗口几何、nativeTheme |
| `desktop/electron/preload.ts` | 修改 | 暴露迁移结果/主题事件（按需） |
| `desktop/renderer/pages/SettingsPage.tsx` | 修改 | yt-dlp 更新 UI + 迁移结果展示 |
| `tests/sidecar/test_migration.py` | 新建 | 迁移幂等与安全 |
| `tests/sidecar/test_ytdlp_updater.py` | 新建 | 更新校验与回退（mock 网络） |

---

### Task 0: 分支

```bash
git checkout electron-phase-2
git checkout -b electron-phase-3
```

### Task 1: 旧数据迁移（Sidecar）

- 源：`~/Library/Preferences/com.Trae.Downloader.plist`、`~/.trae_downloader/history.db`
- 目标：`AppPaths` 下 config.json + history.db
- 标记文件：`data_dir/.migration_v1_done`
- method：`app.runMigration` → `{ status: "skipped"|"migrated"|"failed", message, details }`
- 启动时 server 可自动跑一次（幂等）

### Task 2: yt-dlp 独立更新

- `updater.checkYtDlp` / `updater.updateYtDlp`
- 下载到 `data_dir/bin/yt-dlp`；自检 `--version`；失败保留旧文件
- 设置页按钮：「检查更新」「更新 yt-dlp」

### Task 3: Electron 菜单与快捷键

- 应用菜单：新建任务、队列、历史、设置、退出
- 加速键与 Renderer 路由 IPC 同步（`app:navigate`）

### Task 4: 通知、Dock、窗口几何、系统主题

- 任务完成/失败且窗口失焦 → `Notification`
- Dock badge = 活跃任务数（Main 听 sidecar 事件或轮询 snapshot）
- `window-state.json` 持久化 bounds
- `nativeTheme` 变化通知 Renderer；`theme_mode=system` 时应用

### Task 5: 验收

- pytest sidecar 新测 + 全量 sidecar
- desktop test + build
- 手工冒烟菜单/迁移（可用假 plist）

---

## 自审

- Finder 打开/显示已在阶段 2；本阶段补菜单与通知即可。
- 不在本阶段做签名/DMG（阶段 4）。
