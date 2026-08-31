# 发布与签名

## v0.3.0 macOS 本地候选

2026-08-31 已生成并自动核验 Apple Silicon arm64、macOS 11.0 基线的 `0.3.0` cloud-only 未签名 DMG。包内媒体、Sidecar、真实本地下载、DMG 完整性和候选 Electron 隔离启动/扩展桥入队均通过；Developer ID 签名、公证、干净 Mac 安装和远端 CI 尚未完成。完整事实、哈希与边界见 [macOS 本地候选记录](acceptance/v0.3.0-macos-local-candidate.md)。

## v0.3.0 Windows 本地候选门槛

本工作树的桌面与 Sidecar 为 `0.3.0`，Chrome 扩展独立版本为 `0.8.2`。2026-08-28 已完成本地提交、合入 main 与 Windows 原目录覆盖安装，自动核验见 [本地集成与安装记录](acceptance/v0.3.0-windows-local-integration.md)。尚未推送、打标签或公开发布。本轮按用户范围不执行 Mac 构建或人工验收；下文双平台正式发布流程保留为独立流程。

自动门槛依次为完整测试、Main/Renderer 类型检查、真实 Electron 最小窗口检查、同源 Sidecar/NSIS、包内媒体工具、旧数据恢复和隔离 Electron 入队。打包前冻结源文件/资源清单，完成后再次核对。结果见 [候选记录](acceptance/v0.3.0-stable-baseline.md)。

```powershell
# 仓库根；数据与媒体工具变量必须指向隔离目录和已核对的工具。
$env:DOWNANY_REQUIRE_MEDIA_INTEGRATION = '1'
python -m pytest tests/core tests/data tests/sidecar tests/cli -q
node browser-extension/shared.test.js
node browser-extension/sniff-core.test.js
node browser-extension/bridge-timeout.test.js
node --test scripts/package_smoke_helpers.test.mjs scripts/test_packaged_media_tools.test.mjs

# desktop/；宿主 Node 25 的 Vitest 兼容参数不能传给 Electron。
$env:NODE_OPTIONS = '--no-experimental-webstorage'
npm.cmd test
npm.cmd run build
npm.cmd run test:electron-layout:unit
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
npm.cmd run test:electron-layout
# 布局检查生成开发展示页；打包前必须再运行生产构建。
npm.cmd run build
```

包级升级证据分开记录：

- `python scripts/test_packaged_queue_recovery.py --executable <本次包内Sidecar绝对路径> --previous-executable <v0.2.5包内Sidecar绝对路径> --expected-version 0.3.0 --previous-version 0.2.5 --rounds 5`：旧实际进程生成数据，新包接续真实本地 HTTP 音视频下载。
- `python -m scripts.test_packaged_legacy_upgrade --executable <本次包内Sidecar绝对路径> --expected-version 0.3.0`：新包读取 v0.2.1 旧源码生成的格式 fixture，检查配置、六态任务、历史与 Telegram 结果；成品是哈希保留样本，不是媒体播放样本。

所有包测试使用新建隔离目录并保留证据。Electron 测试跳过协议注册，输出必须位于测试数据根内，不得使用日常数据目录。布局检查使用真实页面和隔离接口数据，验证最终样式与可操作几何，不声称验证动画、外部网站或真实账号。

## 未签名 DMG（当前默认）

本阶段不强制 Apple Developer 证书。本地构建：

```bash
./scripts/fetch_release_binaries.sh
./scripts/build_sidecar.sh
./scripts/build_macos_dmg.sh
# 已有 bin + sidecar 时可跳过：
# FETCH_BINS=0 BUILD_SIDECAR=0 ./scripts/build_macos_dmg.sh
```

产物：`desktop/release/Downany-<version>-mac.dmg`（已在 `.gitignore`，勿提交）。

macOS 发布用 FFmpeg / FFprobe 不再下载 Intel-only 的预编译包。`scripts/install_ffmpeg.sh` 会读取
[`packaging/ffmpeg-macos/source.lock.json`](../packaging/ffmpeg-macos/source.lock.json)，在 Apple
Silicon + Xcode Command Line Tools 环境中从同一源码锁构建 arm64、macOS 11.0 基线的静态
FFmpeg 与 FFprobe；两者都会检查架构、部署基线和动态依赖，随后执行真实音视频生成/探测 smoke。

### 用户首次打开（Gatekeeper）

未签名安装包会被 macOS 拦截。任选其一：

1. **访达**：右键 DMG / `.app` →「打开」→ 确认打开  
2. **终端**（安装到 Applications 后）：
   ```bash
   xattr -cr /Applications/Downany.app
   ```
3. **系统设置** → 隐私与安全性 → 仍允许打开

---

## 未签名 NSIS（Windows）

在 Windows 上本地构建（需 Python venv + Node.js；NSIS 不在 macOS 上产出）：

```powershell
.\scripts\build_windows_nsis.ps1
# 已有 bin + sidecar 时可跳过：
# $env:FETCH_BINS=0; $env:BUILD_SIDECAR=0; .\scripts\build_windows_nsis.ps1
```

产物：`desktop/release/Downany-<version>-win-x64.exe`（与 `desktop/electron-builder.yml` 中 `artifactName: Downany-${version}-win-${arch}.${ext}` 一致；已在 `.gitignore`，勿提交）。

### 用户首次运行（SmartScreen）

未签名安装包会被 Windows SmartScreen 拦截。安装或首次启动时：

1. 出现 **「Windows 已保护你的电脑」**
2. 点击 **更多信息**
3. 点击 **仍要运行**

### Windows Defender 误报

未签名的 Sidecar（`DownanySidecar.exe`）与捆绑的 `ffmpeg.exe` / `ffprobe.exe` 可能被 Defender 或第三方杀软标为「未知发布者」或误报。属未签名本地/CI 构建的常见情况；若用户遇到拦截，可在 Defender 中为安装目录添加排除项，或等待正式代码签名后再分发。

---

### GitHub Releases 发布步骤

#### v0.2.1 云端模式发行版（历史发布示例）

当前没有 Telegram 应用凭据时，`v0.2.1` 仍可发布云端模式安装包。带 `v0.2.1` tag 的 CI 会在 macOS arm64 与 Windows x64 上构建 Sidecar、同源 FFmpeg/FFprobe 工具对和安装包，并通过包内运行冒烟；缺少本地 Telegram Bot API/ProcessHost 时，应用安全地使用官方云端 Bot API。该发行版不宣称本地 Bot API 的单文件 2 GB 能力，云端接口上限和视频分段规则见 [`TELEGRAM.md`](TELEGRAM.md)。最终 GitHub Release 仍必须同时包含 DMG、NSIS 和同次构建的 Chrome 扩展 ZIP。

1. 确认 `desktop/package.json` 的正式版本部分与拟发 tag 一致（本历史示例为 `0.2.1`，tag 为 `v0.2.1`；不要对当前候选照抄执行）。
2. 推送含发布说明的提交到 `main`。  
3. 打包 Chrome 扩展（版本取自 `browser-extension/manifest.json`）：
   ```bash
   mkdir -p desktop/release
   (cd browser-extension && zip -r ../desktop/release/Downany-chrome-extension-0.8.2.zip . \
     -x '*.test.js' -x '.*' -x '__MACOSX*' -x '*.DS_Store')
   ```
4. 创建 Release（**DMG + NSIS + 扩展 zip** 同挂一个 tag）：
   ```bash
   gh auth login   # 若尚未登录
   gh release create v0.2.1 \
     desktop/release/Downany-0.2.1-mac.dmg \
     desktop/release/Downany-0.2.1-win-x64.exe \
     desktop/release/Downany-chrome-extension-0.8.2.zip \
     --title "Downany 0.2.1" \
     --notes-file docs/RELEASE-NOTES-0.2.1.md
   ```
   macOS 与 Windows 安装包可在各自平台构建后一并上传；勿只发 DMG 或只发 NSIS。
5. 在另一台未装开发环境的机器上验证：
   - **macOS**：右键打开 DMG → Sidecar 握手 → 扩展桥 `http://127.0.0.1:17888/health` → 入队一条公开链接
   - **Windows**：SmartScreen「仍要运行」→ 安装 → 同上 health / 入队冒烟

如果将来取得 Telegram 应用凭据，可在 GitHub Actions 手动运行 `CI`，将 `package_mode` 设为 `native`，再对生成的原生资源和安装包做单独验收；这不是当前云端模式发行版的前置条件。

#### 原生 Telegram 模式

原生模式需要配置 `DOWNANY_TELEGRAM_API_ID` 和 `DOWNANY_TELEGRAM_API_HASH` 两个 Actions Secrets。它只用于构建 Local Bot API 的应用凭据，不是用户在应用内填写的 Bot Token。没有这两个值时，不应伪造 `app-credentials.json` 或宣称支持本地 2 GB 上传。

### Chrome 扩展安装（未上架商店）

1. 从 Release 下载 `Downany-chrome-extension-*.zip` 并解压  
2. Chrome → `chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选解压目录  
3. 先启动桌面端，再使用扩展（HTTP 桥 `127.0.0.1:17888`）

### 安装后冒烟清单

| 项 | 期望 |
|----|------|
| 启动 | 无崩溃；命令中心可连 Sidecar |
| `GET /health` | `{"ok":true,"sidecarReady":true}` |
| Windows 媒体工具 | `resources/bin/ffmpeg.exe` 与 `resources/bin/ffprobe.exe` 均可执行 |
| macOS 媒体工具 | `Downany.app/Contents/Resources/bin/ffmpeg` 与 `ffprobe` 均可执行 |
| Sidecar | `…/Resources/sidecar/DownanySidecar/DownanySidecar` |
| 扩展桥入队 | `POST /enqueue` 返回 `taskIds` |
| 设置 → 检查应用更新 | 查询 GitHub Releases；有新版则「前往下载」 |

回归记录见 [REGRESSION-2026-08.md](REGRESSION-2026-08.md)。

### FFmpeg / FFprobe 成对发布不变量

- Windows 的 `ffmpeg.exe` 与 `ffprobe.exe` 必须来自同一个已锁定、SHA-256 已验证的 BtbN 归档，并位于归档内同一 `bin` 目录。
- macOS 的 `ffmpeg` 与 `ffprobe` 必须来自同一个 `source.lock.json` 源码构建；`media-tools.sha256` 必须只包含这两个相对文件名。
- NSIS / DMG 在替换既有候选产物前必须检查两者存在且可执行，并用 `scripts/test_packaged_media_tools.mjs` 生成含视频和音频的样本，再由 FFprobe 验证流与容器。
- CI 必须分别对 `desktop/resources/bin` 和安装包内的 `Resources/bin` 执行同一 smoke；缺少任一工具、版本命令失败、探测 JSON 无效或样本缺少预期流都会阻止打包交付。

---

## 签名 + 公证（需 Apple Developer，$99/年）

证书到位后：

```bash
SIGN_IDENTITY="Developer ID Application: … (TEAMID)" \
APPLE_ID="you@example.com" \
APP_PASSWORD="app-specific-password" \
TEAM_ID="XXXXXXXXXX" \
  ./scripts/notarize_macos.sh
```

`desktop/electron-builder.yml` 已开启 `hardenedRuntime: true`；把 `mac.identity` 从 `null` 改为签名身份，或通过 CI 注入。脚本 [`scripts/notarize_macos.sh`](../scripts/notarize_macos.sh) 在缺少环境变量时会优雅跳过。

---

## 应用更新

### 当前（未签名）：GitHub Releases 版本检查

[`desktop/electron/appUpdater.ts`](../desktop/electron/appUpdater.ts) 请求 `JackEngineer/downany` 的 `releases/latest`，semver 比较后提示用户。设置页「检查应用更新」+「前往下载」打开 Release 页。

| 环境变量 | 作用 |
|----------|------|
| `DOWNANY_GITHUB_REPO` | 覆盖仓库（默认 `JackEngineer/downany`） |
| `DOWNANY_UPDATE_DISABLED=1` | 关闭检查 |

### 证书到位后：electron-updater 自动替换

1. 在 `electron-builder.yml` 配置 `publish`（GitHub Releases 或 generic feed）。  
2. 引入 `electron-updater` 替换轻量检查为静默下载 + 重启安装。  
3. 仅签名构建可在 macOS 上完成自动替换。
