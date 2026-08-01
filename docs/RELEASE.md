# 发布与签名（M0.4 / M0.5）

证书到位前，发布产物仍为未签名 DMG。脚本 [`scripts/notarize_macos.sh`](../scripts/notarize_macos.sh) 在缺少环境变量时会优雅跳过。

## 签名 + 公证（需 Apple Developer）

```bash
SIGN_IDENTITY="Developer ID Application: … (TEAMID)" \
APPLE_ID="you@example.com" \
APP_PASSWORD="app-specific-password" \
TEAM_ID="XXXXXXXXXX" \
  ./scripts/notarize_macos.sh
```

`desktop/electron-builder.yml` 已开启 `hardenedRuntime: true`；证书就绪后把 `mac.identity` 从 `null` 改为签名身份，或通过 CI 注入。

## 应用自更新（需签名）

1. 托管更新 feed（generic server 或 GitHub Releases）。
2. 设置环境变量 `DOWNANY_UPDATE_FEED`（或在 builder `publish` 中配置）。
3. 引入 `electron-updater`，替换 [`desktop/electron/appUpdater.ts`](../desktop/electron/appUpdater.ts) 中的占位实现。
4. 设置页「检查应用更新」已接 IPC `app:checkUpdate`。

在未配置 feed 时，检查更新会返回 `status: "disabled"` 与说明文案，避免误报。
