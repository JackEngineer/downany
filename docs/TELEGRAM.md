# Telegram 自动转发

Downany 的设置页现在支持绑定 Telegram Bot，并把下载完成的文件自动发送到已验证的聊天。

## 使用步骤

1. 在 Telegram 中打开 `@BotFather`，创建 Bot 并复制 Token。
2. 打开 Downany → 设置 → Telegram，粘贴 Token 后点击“绑定 Bot”。
3. 让 Bot 在目标私聊或群组中收到一条消息，然后点击“读取聊天”。
4. 选择接收聊天，先发送一条测试消息确认权限。
5. 打开“下载完成后自动发送”。之后新完成的下载会进入发送队列。

Token 不会进入 JSON 配置、Sidecar、日志或 IPC payload；Electron 使用 macOS Keychain / Windows Credential Manager 提供的 `safeStorage` 保存加密凭据。

## 跨平台说明

Telegram 的绑定、聊天发现、队列和发送逻辑运行在 Electron + Sidecar 的共同协议上，数据目录和加密凭据分别使用 macOS 与 Windows 的系统路径，因此两端行为一致。

发送层已经支持官方 Local Bot API 的回环端点：本地模式使用 `file:` URI，不把大文件读入 Electron；Supervisor 会固定 `127.0.0.1`、独立工作目录和重启状态。上游版本、vcpkg 基线和应用凭据生成器已锁定在 `packaging/telegram-bot-api` 与 `scripts/generate_telegram_build_credentials.mjs`。

Windows 已完成真实桌面端、Chrome 扩展和 Telegram 云端发送验收；云端 Bot API 对超过单文件限制的视频会切成保持原始画面比例、可以独立播放的分段。没有 Local Bot API/ProcessHost 原生资源时，桌面端会安全地使用云端模式，不能宣称支持单文件 2 GB。macOS 的原生资源仍需在具备对应构建凭据后单独验收。

安装包分为两种模式：云端模式不携带 Local Bot API/ProcessHost，使用 `ALLOW_CLOUD_ONLY_PACKAGE=1` 构建并运行包内 Sidecar/Electron 冒烟；原生模式额外构建并校验 Bot API、ProcessHost、manifest 和 `app-credentials.json`。云端模式可以作为没有 Telegram 应用凭据时的公开发行包，但不包含本地 Bot API 的单文件 2 GB 能力。

原生 Bot API 的固定构建入口已经加入：Apple Silicon 使用 `scripts/build_telegram_bot_api_macos.sh`，Windows x64 使用 `scripts/build_telegram_bot_api_windows.ps1`。两个脚本都只接受 `packaging/telegram-bot-api/source.lock.json` 中的源码与依赖版本，缺少 CMake/编译器或 SHA 校验失败会立即退出，不会留下伪成功资源。ProcessHost 仍需在同一平台构建并通过真实父进程退出验收后，才能把本地模式放进正式安装包。

受控宿主源码位于 `native/process-host`，构建入口为 `scripts/build_process_host_macos.sh` 与 `scripts/build_process_host_windows.ps1`，真实进程 smoke 入口为 macOS 的 `scripts/test_process_host.py` 和 Windows 的 `scripts/test_process_host_windows.mjs`。宿主只通过 fd3/继承 handle 接收 `resume`，在 macOS 使用独立 process group、Windows 使用 Job Object；缺少对应编译器或无法通过真实进程树验收时，构建必须失败。Windows x64 二进制已在真实工作机通过进程树冒烟；Apple Silicon 仍待 macOS 环境验收。

打包后的 Sidecar 协议可用 `scripts/test_packaged_sidecar.mjs` 做独立 smoke：它会验证 hello、peer hello、`app.ping` 和 `app.shutdown`，不依赖 Electron 窗口。

## 在目标机生成正式双平台包

仓库的 `CI` workflow 在手动运行或版本 tag 上分别使用 `windows-latest` 和 `macos-14` 构建原生资源、ProcessHost、安装包，并运行打包 Sidecar smoke。正式 workflow 需要在 GitHub Actions Secrets 中配置：

- `DOWNANY_TELEGRAM_API_ID`
- `DOWNANY_TELEGRAM_API_HASH`

这两个值是 Telegram Local Bot API 的应用凭据，不是 Bot Token；workflow 只把它们用于生成安装包内的 `app-credentials.json`，不会把用户 Bot Token 写进仓库或构建日志。Bot Token 仍由用户首次绑定时输入，并保存到本机系统加密存储。

如果没有配置这两个 Secret，不能构建原生模式；`v0.2.0` tag 的 CI 会明确构建云端模式包，不伪造原生资源，也不会把云端包标成支持本地 2 GB。用户仍只需要在应用内输入自己的 Bot Token，Bot Token 不进入构建流程。

Electron 侧的 `processHostAdapter.ts` 已按同一 fd3 handshake 接入 Supervisor：原生资源齐全时会由受控宿主启动 Local Bot API、使用 `file:` URI 发送大文件，并在退出/重启时按持久 owner 快照收敛；资源不完整时不会偷偷启动未受控的本地进程。

网络错误会自动重试；目标权限错误会暂停该聊天的待发送记录，修复权限后可在“最近发送”中重试。后处理脚本失败会立即生成“POSTPROCESS_INTERRUPTED”记录，不必等应用重启，确认文件状态后即可重试。应用退出、切换 Bot 或 Sidecar 重启会中止在途上传，结果未知的记录会显示为“uncertain”，需要用户确认后重试；旧 Worker 的迟到响应不会再写入新账号。
