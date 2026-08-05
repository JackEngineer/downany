# Windows 平台矩阵同发 — 设计规格

日期：2026-08-05  
状态：已评审（对话确认）  
产品：Downany · 百纳  
相关：`docs/roadmap.md`、`docs/RELEASE.md`、`AGENTS.md`

## 1. 背景与动机

Downany 当前以 macOS 为唯一已验证交付面（Electron + Python Sidecar + yt-dlp）。路线图曾将 Windows / Linux 标为「明确不做」。现产品定位改为 **双平台尽量对齐**，且约束为：**每个正式版本必须同时发布 Mac 与 Windows 安装包，功能同发**。

Windows 分发形态基线：**未签名 NSIS**（接受 SmartScreen「更多信息 → 仍要运行」）；代码签名可后补，不阻塞首个同发 tag。

## 2. 目标与非目标

### 目标

- macOS + Windows **同一版本号、同一功能集**发布。
- 一个 GitHub Release tag 至少挂载：
  1. macOS DMG
  2. Windows NSIS 安装包
  3. Chrome 扩展 zip（现有流程）
- 下载主路径、队列、设置、扩展桥、`downany://`、应用内检查更新（打开浏览器）在两端均可用。
- 平台差异收敛到少数适配点；`src/core` / `src/data` / Sidecar 协议 / Renderer 业务逻辑保持共用。

### 非目标（本规格范围外）

- Authenticode / EV 代码签名（文档预留，不作为同发门禁）。
- Linux。
- Safari 扩展；Windows 专用 native messaging 宿主。
- 与 macOS 像素级 UI 一致（vibrancy / hiddenInset 窗框等）。
- Edge 扩展商店上架（可本地加载同一 MV3；上架另开任务）。

## 3. 方案选择

评审过的三条路线：

| 方案 | 简述 | 结论 |
|---|---|---|
| **A. 平台矩阵同发** | 抽象路径/二进制/`.exe`；CI 双平台；NSIS 未签名；macOS 独有能力有等价物或显式降级 | **采用** |
| B. 先 Win 追平再锁同发 | 短期更快出包 | 与「立即每版同发」冲突，否决 |
| C. 大重构统一平台层再加 Win | 长期最干净 | 拖慢同发，否决 |

## 4. 架构原则

1. **共用核心，分支外壳**：平台差异只进入路径解析、二进制命名、进程生命周期、窗口/Tray、打包脚本。
2. **没有 Win 等价物就不做假能力**：Dock 角标、`.webloc`、vibrancy、旧 macOS 数据迁移等 → 显式跳过或替代，不得阻塞启动与下载。
3. **发版门槛**：正式 tag 必须挂齐 DMG + NSIS + 扩展 zip；禁止默认「只发一端」的正式版（紧急单端热修须在 Release 说明中显式标注，非常规）。
4. **CI 双跑**：`macos-latest` + `windows-latest` 至少覆盖 pytest 与 desktop test/build；完整 NSIS 可放在 release job，不强制每个 PR 全量打包。

## 5. 路径与数据目录

### 5.1 Windows 默认路径

| 用途 | Windows | macOS（保持） |
|---|---|---|
| 数据（配置、SQLite、队列、缩略图缓存） | `%LOCALAPPDATA%\Downany` | `~/Library/Application Support/Downany` |
| 日志 | `%LOCALAPPDATA%\Downany\logs` | `~/Library/Logs/Downany` |

选择 `%LOCALAPPDATA%` 而非 `%APPDATA%`：SQLite WAL 与缓存不宜进入漫游配置或 OneDrive 同步路径。

### 5.2 统一入口

- Python：`AppPaths.default()` 为唯一默认路径实现。
- 删除或委托以下重复硬编码回落到 `AppPaths`：
  - `src/data/database.py` 默认 `db_path`
  - `src/core/local_thumbnail.py` 的 `default_data_dir()`
- Electron：`resolveDownanyDataDir()`、日志目录 IPC 按 `process.platform` 分支。
- 环境变量覆盖保持不变：`DOWNANY_DATA_DIR` / `DOWNANY_BIN_DIR` / `DOWNANY_PYTHON`（及旧 `VIDEODL_*`）。

### 5.3 迁移

`src/sidecar/migration.py` 的 Trae / VideoDownloader / plist 逻辑仅在 macOS 有意义。Windows 启动时 **跳过迁移**（记录 skipped），不得因缺少 `~/Library` 而报错。

## 6. 二进制与运行时

### 6.1 解析规则

在 `bin_paths.py` 与 Electron `paths.ts`：

- Windows：解析 `ffmpeg.exe`、`yt-dlp.exe`、`deno.exe`、`DownanySidecar.exe`。
- macOS：保持现有无扩展名约定。
- 实现策略：平台分支，或「候选名列表，谁存在用谁」，避免漏检。

### 6.2 开发态 Sidecar

- Windows：`venv\Scripts\python.exe -m src.sidecar`
- `resolveSidecarLaunch()` 必须选 `Scripts\python.exe`，不得硬编码 `venv/bin/python`。

### 6.3 打包态 Sidecar

- PyInstaller onedir（规格不变）。
- Windows 产物：`DownanySidecar.exe`；`bundledSidecarPath()` 必须能解析到该文件。

### 6.4 拉取与自更新

- 构建拉取脚本增加 Windows 资源：静态 `ffmpeg.exe`（例如 gyan.dev / BtbN 一类已知源）、官方 `yt-dlp.exe`。
- `ytdlp_updater.py` 的 `ASSET_NAME` / 落盘路径按 OS 选择（不得继续写死 `yt-dlp_macos`）。
- `deno`：优先 `shutil.which`；Windows 可补充 `%USERPROFILE%\.deno\bin`；移除「仅 Homebrew 路径」作为唯一 fallback。

### 6.5 其它平台相关细节

- 后处理脚本：`shlex.quote` + `shell=True` 在 Windows 不安全；改为平台安全的参数拼装（优先避免 `shell=True`，或使用 Windows 兼容 quoting）。
- HTTP User-Agent 中「Macintosh…」为美化问题，本阶段可不改；若改则按 OS 生成（非门禁）。

## 7. Electron 壳与进程模型

### 7.1 启动与协议循环

保持：`PYTHONUNBUFFERED=1`、stdout 仅协议行、日志走 stderr。  
Windows 管道可能出现 `\r\n`：编解码须容忍并规范为 `\n`。须在真实 Windows 上验证 hello 握手。

### 7.2 进程树终止

macOS：已有 `detached` + 负 PID 进程组。  
Windows：`child.kill("SIGTERM")` **不足以**杀掉 yt-dlp/ffmpeg 子进程。同发前必须实现其一：

- **首选实现路径**：`taskkill /T /PID <pid>`（或等效），保证退出/取消下载后无残留；或
- Job Object 封装（效果更好，可后续替换，但不可长期「只杀父进程」）。

规格要求：**验收时无残留 `DownanySidecar` / `ffmpeg` / `yt-dlp` 进程**，具体采用 `taskkill /T` 或 Job Object 由实现计划选定，门禁以验收为准。

### 7.3 UI / 系统集成映射

| 能力 | macOS | Windows |
|---|---|---|
| 窗框 | `hiddenInset` + vibrancy | `frame: true` 默认框，或轻量自定义标题栏；禁止依赖透明+vibrancy |
| Dock 角标 / menu-bar-only | 保留 | 无 Dock；**启用 Tray**；可选「关闭到托盘」 |
| `.webloc` | 保留 | 不支持；依赖剪贴板 / 扩展 / 协议 |
| 菜单 | 现有 mac 角色可保留 | Electron 会忽略无效 role；快捷键继续 `CmdOrCtrl` |
| Cookie 来源 UI | Chrome / Safari / Firefox / Edge | **隐藏 Safari**；保留 Chrome / Edge / Firefox |
| 通知 | 现有 | 验证 Action Center；失败重试 action 尽量保留 |
| `downany://` | `open-url` | argv + 单实例锁（已有架构）；同发必测 |
| 扩展桥 | `127.0.0.1:17888` | 相同；Chrome / Edge 可加载同一扩展 |

## 8. 打包与发版

### 8.1 electron-builder

- `desktop/electron-builder.yml` 增加 `win` / `nsis` 目标与 Windows 图标（`.ico`）。
- `desktop/package.json` 增加 `dist:win`；根脚本增加对应编排（可与现有 `build_macos_dmg.sh` 并列）。
- 提供 Windows 构建编排脚本（PowerShell 或跨平台 Node），负责：拉取 Win 二进制 → 构建 Sidecar → `electron-builder --win`。

### 8.2 Release 产物矩阵

每个正式 tag：

1. `Downany-*-mac.dmg`（或现有命名）
2. `Downany-*-win-x64.exe`（NSIS，未签名）
3. `Downany-chrome-extension-<ver>.zip`

### 8.3 文档

- `docs/RELEASE.md` 增加 Windows 章节：构建步骤、SmartScreen 操作说明、Defender 误报提示。
- `docs/roadmap.md`：删除「明确不做 Windows」；改为「双平台同发；NSIS 未签名为当前基线；签名后补」。
- `AGENTS.md` / `CLAUDE.md`：补充 Windows 开发命令（venv Scripts、数据目录、打包入口）。

### 8.4 CI

| 触发 | macOS | Windows |
|---|---|---|
| PR | pytest + desktop test/build + 扩展测试 | pytest + desktop test/build |
| Release | DMG（现有） | NSIS |

## 9. 风险

1. **Stdio 握手**：Windows 管道缓冲/换行与 PyInstaller onedir 组合未验证。
2. **杀进程树**：不处理则 ffmpeg 占锁、任务卡死。
3. **杀毒 / SmartScreen**：未签名 + 网络写入型 sidecar 易误报；靠文档与后续签名缓解。
4. **文件锁 / rename**：AV 实时扫描导致 `PermissionError` 概率高于 macOS。
5. **MAX_PATH**：长下载目录 + 标题；依赖现有文件名截断，必要时再加长路径策略。
6. **Cookie 解密**：yt-dlp `--cookies-from-browser` 在 Windows DPAPI 下更脆，需烟雾测试。

## 10. 验收标准

- [ ] 干净 Windows 机：安装 NSIS → 启动 → Sidecar hello → 成功下载至少一条公开视频。
- [ ] Chrome 或 Edge 加载扩展后入队成功。
- [ ] `downany://` 第二次唤起同一实例并入队。
- [ ] 应用退出后无 `DownanySidecar` / `ffmpeg` / `yt-dlp` 残留进程。
- [ ] macOS DMG 流程不回归。
- [ ] 同一 GitHub Release 挂齐 DMG + NSIS + 扩展 zip。
- [ ] PR CI 在 `windows-latest` 上 pytest + desktop test/build 通过。

## 11. 建议实施切片（实现计划将展开为任务）

1. **地基**：路径 / `.exe` / venv / 进程树 + Windows CI 测试。
2. **可装**：Win Sidecar + 二进制拉取 + electron-builder NSIS。
3. **壳层**：Tray、窗框分支、Cookie 选项、用户文档。
4. **闸门**：更新 RELEASE / roadmap / AGENTS；打第一个双平台 tag。

估度量级：**L**（数人周，强依赖真实 Windows 联调）。

## 12. 决策记录

| 决策 | 选择 |
|---|---|
| 动机 | 产品双平台对齐 |
| 发版节奏 | 每版 Mac + Win 功能同发 |
| Win 产物 | 未签名 NSIS |
| 技术方案 | 平台矩阵同发（方案 A） |
| 数据目录 | `%LOCALAPPDATA%\Downany` |
| 签名 | 本阶段不做，文档说明 SmartScreen |
