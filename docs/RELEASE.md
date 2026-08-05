# 发布与签名

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

### 用户首次打开（Gatekeeper）

未签名安装包会被 macOS 拦截。任选其一：

1. **访达**：右键 DMG / `.app` →「打开」→ 确认打开  
2. **终端**（安装到 Applications 后）：
   ```bash
   xattr -cr /Applications/Downany.app
   ```
3. **系统设置** → 隐私与安全性 → 仍允许打开

### GitHub Releases 发布步骤

1. 确认 `desktop/package.json` 的 `version` 与拟发 tag 一致（当前 `0.1.0`）。  
2. 推送含发布说明的提交到 `main`。  
3. 打包 Chrome 扩展（版本取自 `browser-extension/manifest.json`）：
   ```bash
   mkdir -p desktop/release
   (cd browser-extension && zip -r ../desktop/release/Downany-chrome-extension-0.8.1.zip . \
     -x '*.test.js' -x '.*' -x '__MACOSX*' -x '*.DS_Store')
   ```
4. 创建 Release（DMG + 扩展 zip）：
   ```bash
   gh auth login   # 若尚未登录
   gh release create v0.1.0 \
     desktop/release/Downany-0.1.0-mac.dmg \
     desktop/release/Downany-chrome-extension-0.8.1.zip \
     --title "Downany 0.1.0" \
     --notes-file docs/RELEASE-NOTES-0.1.0.md
   ```
5. 在另一台未装开发环境的 Mac 上验证：右键打开 → Sidecar 握手 → 扩展桥 `http://127.0.0.1:17888/health` → 入队一条公开链接。

### Chrome 扩展安装（未上架商店）

1. 从 Release 下载 `Downany-chrome-extension-*.zip` 并解压  
2. Chrome → `chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选解压目录  
3. 先启动桌面端，再使用扩展（HTTP 桥 `127.0.0.1:17888`）

### 安装后冒烟清单

| 项 | 期望 |
|----|------|
| 启动 | 无崩溃；命令中心可连 Sidecar |
| `GET /health` | `{"ok":true,"sidecarReady":true}` |
| ffmpeg | `Downany.app/Contents/Resources/bin/ffmpeg` 可执行 |
| Sidecar | `…/Resources/sidecar/DownanySidecar/DownanySidecar` |
| 扩展桥入队 | `POST /enqueue` 返回 `taskIds` |
| 设置 → 检查应用更新 | 查询 GitHub Releases；有新版则「前往下载」 |

回归记录见 [REGRESSION-2026-08.md](REGRESSION-2026-08.md)。

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
