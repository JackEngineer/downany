# Trae Downloader Swift

这是下载器的 macOS 原生 SwiftUI 迁移版。当前 Python/PyQt 版本仍保留在仓库中，Swift 版以并行工程方式继续推进。

## 构建与测试

```bash
swift build
swift test
```

## 打包 macOS App

在仓库根目录运行：

```bash
./scripts/package_swift_app.sh
```

脚本会生成 `dist/TraeDownloader.app`，并完成这些步骤：

- 构建 SwiftPM 可执行产物
- 写入 `Info.plist`
- 在可用时从 `Resources/AppIcon.svg` 生成 `AppIcon.icns`
- 尝试把 `yt-dlp` 和 `ffmpeg` 放入 app bundle

## 打包参数

```bash
CONFIGURATION=debug ./scripts/package_swift_app.sh
OUTPUT_DIR=/tmp/trae-build ./scripts/package_swift_app.sh
YTDLP_PATH=/path/to/yt-dlp FFMPEG_PATH=/path/to/ffmpeg ./scripts/package_swift_app.sh
SIGN_IDENTITY="-" ./scripts/package_swift_app.sh
SIGN_IDENTITY="Developer ID Application: Example" ./scripts/package_swift_app.sh
```

构建可分发 app 时，建议用 `YTDLP_PATH` 指向独立版 `yt-dlp`。Homebrew 安装的 `yt-dlp` 通常只是一个 Python 启动脚本，依赖本机 Homebrew Python 环境。

`SIGN_IDENTITY="-"` 用于本地 ad-hoc 签名。正式分发和 notarization 需要 Developer ID 证书。
