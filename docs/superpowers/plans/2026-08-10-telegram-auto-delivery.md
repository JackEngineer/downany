# Telegram 自动发送 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Downany 用户只输入专用 Telegram Bot Token、选择一个接收位置，即可在每个新下载完成最终后处理后，把最终文件可靠发送到 Telegram；下载结果与发送结果彼此独立，并在 macOS DMG 与 Windows NSIS 中随附官方本地 Bot API 服务。

**Architecture:** Python Sidecar 是下载输出与发送队列的事实来源；Electron Main 独占 Bot Token、系统加密凭据、本地 Bot API 进程和串行发送工作器；Renderer 只能通过具名 preload IPC 完成绑定、目标选择、开关和重试。Sidecar 通过持久化 output-ready 生命周期把最终文件原子加入 SQLite 队列，Electron 通过租约领取并调用监听随机回环端口的 `telegram-bot-api --local`，在网络请求开始前写入 `sending`，以 `uncertain` 阻止崩溃后的静默重复发送。

**Tech Stack:** Python 3.11、SQLite、Electron 33、TypeScript、React、Zod、Electron `safeStorage` / `net.fetch`、Vitest、pytest、electron-builder、官方 `tdlib/telegram-bot-api` commit `adfd7f6a8e990272851777eeb3ae0def4216f161`、CMake、vcpkg。

**Spec:** `docs/superpowers/specs/2026-08-10-telegram-auto-delivery-design.md`

## Global Constraints

- [ ] 执行实现前先使用 `superpowers:using-git-worktrees`。不得把当前脏工作树的 HEAD 猜成“双平台 m0 已完成基线”：先由用户明确给出一个已提交、不可变、包含本规格/计划且已完成 Windows/macOS 基线的 40 位 commit SHA，再从它创建 `feat/m1-telegram-auto-delivery` 工作树。若任一必需基线改动仍只存在于源工作树 WIP，立即停止并由原负责人先独立完成/验证/提交；不得复制、stash、暂存、提交或重置 `feat/m0-windows-foundation` 中任何已有修改或未跟踪文件。
- [ ] 每个实现任务先使用 `superpowers:test-driven-development`，严格按“失败测试 → 最小实现 → 定向测试 → 回归测试 → 单独提交”执行；一个提交只包含该任务列出的文件。
- [ ] Bot Token 只允许存在于绑定 IPC 请求、Electron Main 的短生命周期内存和 `safeStorage` 密文文件；不得进入 Sidecar、JsonConfig、SQLite、Renderer 持久状态、日志、异常、诊断包、URL 回显或测试快照。
- [ ] `api_id` / `api_hash` 只从开发环境变量或构建时生成资源读取，不写进仓库、不打印值；发布构建缺任意一项必须失败。
- [ ] Renderer 不得获得任意 Sidecar 方法调用能力。内部 `claimNext`、`markSending`、`markSent`、`markRetry`、`markRetryNotSubmitted`、`markFailed`、`markUncertain`、`markSkippedOversize`、`getTargetBlock`、`renewLease` 只能由 Electron Main 调用。
- [ ] Telegram 失败不得改变下载任务的 `completed` 状态，不得删除、移动或重命名下载文件，也不得阻断普通下载、历史、浏览器扩展入队和 CLI。
- [ ] 所有新增 Telegram 时间戳写成带 `Z` 的 UTC ISO 8601；解析旧 `completed_at` 时按产生机器的本地时区转换后再比较，不做字符串字典序资格判断。
- [ ] 所有新增 UI 文案同时提供中文与英文，并只描述“连接、接收位置、发送、失败原因、下一步动作”；UI 不出现 Sidecar、Bot API、lease、进程迁移或内部错误栈。
- [ ] 单文件上传上限固定为 `2_000_000_000` 字节。超过上限只发文字通知并落 `skipped_oversize`，不上传、不切片、不压缩、不转码。
- [ ] 不签名的现有发行基线保持不变；不能用单元测试代替 macOS 与 Windows 真实安装包、真实专用 Bot 和真实接收位置验收。
- [ ] 原生构建脚本清理 `.build/telegram-bot-api`、`.build/ffmpeg-macos`、`.build/vcpkg` 或 `.build/vcpkg_installed` 前必须解析仓库根和目标绝对路径并验证目标严格位于该仓库 `.build` 下；清理 `desktop/resources/telegram-bot-api` 前还必须验证精确路径，先拒绝 root 以及任何直接 child 的 symlink/junction/reparse point，再仅枚举其直接非链接子项；不得对 home、工作区根或未解析变量做递归删除。

---

## Exact File Map

### Python core、data 与 Sidecar

| 文件 | 操作 | 唯一职责 |
|---|---|---|
| `src/data/models.py` | Modify | output-ready 与 Telegram delivery 的枚举、不可变记录类型 |
| `src/data/database.py` | Modify | `download_history` 兼容迁移、UPSERT 保留 output-ready 字段 |
| `src/data/telegram_delivery_store.py` | Create | 队列表、原子领取、续租、状态转换、分页、崩溃恢复 |
| `src/data/json_config.py` | Modify | 仅保存非秘密 Telegram 设置并拒绝秘密键 |
| `src/core/interfaces.py` | Modify | 与 Telegram 解耦的 `OutputReadySink` protocol |
| `src/core/download_manager.py` | Modify | 下载完成、后处理和 output-ready 的准确顺序 |
| `src/core/url_parser.py` | Modify | 冻结态通过 Sidecar 内部 mux 调用 bundled yt-dlp，避免递归进入协议入口 |
| `src/cli/__main__.py` | Modify | CLI 注入同一持久 output-ready sink，不执行全局恢复 |
| `src/sidecar/__main__.py` | Modify | 在 JSON Lines 启动前处理唯一的 `--run-yt-dlp` 内部入口 |
| `src/sidecar/bin_paths.py` | Modify | 删除重复的外置 yt-dlp executable 解析，只保留发布 FFmpeg 路径 |
| `src/sidecar/ytdlp_updater.py` | Modify | 把 yt-dlp 生命周期收归 Downany 应用更新，不再下载无效外置 binary |
| `src/sidecar/diagnostics.py` | Modify | 直接读取 bundled yt-dlp 版本且不 spawn 冻结态 Python |
| `src/sidecar/telegram_delivery_service.py` | Create（Task 2）、Modify（Task 11） | 配置线性化、output-ready 入队、协议 DTO 与事件 |
| `src/sidecar/protocol.py` | Modify | Telegram 内部方法、事件和结构化错误码 |
| `src/sidecar/handlers.py` | Modify | 参数校验与 delivery service 调用 |
| `src/sidecar/server.py` | Modify | 严格初始化/恢复/订阅/启动顺序 |
| `tests/data/test_database.py` | Modify | 旧库迁移和 UPSERT 保留 readiness |
| `tests/data/test_telegram_delivery_store.py` | Create | schema、幂等、租约、状态机、恢复、分页 |
| `tests/data/test_json_config.py` | Modify | 非秘密配置与秘密键拒绝 |
| `tests/core/test_download_manager.py` | Modify | 后处理前后顺序与 sink 隔离 |
| `tests/core/test_url_parser.py` | Modify | 开发态与冻结态 yt-dlp 命令入口 |
| `tests/cli/test_cli.py` | Create | CLI 正常完成与脚本中断的持久 lifecycle |
| `tests/sidecar/test_main.py` | Create | `--run-yt-dlp` mux 与普通协议入口隔离 |
| `tests/sidecar/test_bin_paths.py` | Modify | 发布路径不再解析额外 yt-dlp executable |
| `tests/sidecar/test_ytdlp_updater.py` | Modify | 独立更新返回 `APP_UPDATE_REQUIRED` 且不落文件 |
| `tests/sidecar/test_ytdlp_health.py` | Modify | bundled yt-dlp 精确版本与健康状态 |
| `tests/sidecar/test_diagnostics.py` | Modify | 冻结态版本诊断不启动子 Python |
| `tests/sidecar/test_telegram_delivery_service.py` | Create | 启用边界、配置快照、恢复和事件 |
| `tests/sidecar/test_protocol.py` | Modify | 方法/事件枚举和错误码 |
| `tests/sidecar/test_handlers.py` | Modify | handler 参数、lease、分页和秘密拒绝 |
| `tests/sidecar/test_server.py` | Modify | 初始化顺序和 event wiring |
| `tests/sidecar/test_e2e_subprocess.py` | Modify | JSON Lines 端到端队列与纯净 stdout |

### Electron Main 与 preload

| 文件 | 操作 | 唯一职责 |
|---|---|---|
| `desktop/electron/protocol.ts` | Modify | Renderer Sidecar 方法白名单与内部方法分离 |
| `desktop/electron/preload.ts` | Modify | 具名 Telegram API、schema 校验、通用 request 收窄 |
| `desktop/electron/main.ts` | Modify | Telegram runtime 接线、Sidecar 事件路由、可等待退出 |
| `desktop/electron/sidecar.ts` | Modify | 保留 Sidecar 结构化错误并提供可确认的进程树停止合同 |
| `desktop/electron/sidecar.test.ts` | Create（Task 9）、Modify（Task 10） | 结构化错误透传、graceful/force 退出与后代残留竞态 |
| `desktop/electron/processTree.ts` | Modify | 本地服务进程树的 graceful/force 两阶段终止 |
| `desktop/electron/processTree.test.ts` | Modify | 两阶段退出、超时和失败保留 owner state |
| `desktop/electron/telegram/types.ts` | Create | Main、preload、Renderer 共用的严格类型 |
| `desktop/electron/telegram/ipcSchemas.ts` | Create | 所有 Renderer Telegram 入参/返回/事件的 Zod schema |
| `desktop/electron/telegram/ipcSchemas.test.ts` | Create | 严格 result/error envelope 与未知字段拒绝 |
| `desktop/electron/telegram/redaction.ts` | Create | Token、Bot URL、异常与子进程输出脱敏 |
| `desktop/electron/telegram/credentialVault.ts` | Create | `safeStorage` 密文凭据的原子读写与删除 |
| `desktop/electron/telegram/paths.ts` | Create | 二进制、工作目录、临时目录、凭据目录的跨平台解析 |
| `desktop/electron/telegram/appCredentials.ts` | Create | 开发环境变量/打包资源中的 `api_id`、`api_hash` 读取 |
| `desktop/electron/telegram/childEnv.ts` | Create | Bot API 与 Sidecar 子进程的最小白名单环境构造 |
| `desktop/electron/telegram/supervisor.ts` | Create | 随机回环端口、本地服务启动、探活、有限重启、进程树关闭 |
| `desktop/electron/telegram/client.ts` | Create | 云端迁移、本地发现、测试、文字和本地路径文件发送 |
| `desktop/electron/telegram/sidecarGateway.ts` | Create | Electron worker 独占的强类型队列协议封装 |
| `desktop/electron/telegram/deliveryWorker.ts` | Create | 串行 claim/prepare/send/mark、续租、重试、oversize、fallback |
| `desktop/electron/telegram/controller.ts` | Create | 绑定、换 Bot、发现、验证、开关、断开和 worker 编排 |
| `desktop/electron/telegram/ipc.ts` | Create | 固定 IPC channel 注册、广播和 schema 边界 |
| `desktop/electron/protocol.test.ts` | Modify | Renderer Sidecar 方法白名单 |
| `desktop/electron/telegram/redaction.test.ts` | Create | Token 与 Bot URL 脱敏 |
| `desktop/electron/telegram/credentialVault.test.ts` | Create | safeStorage 密文原子读写 |
| `desktop/electron/telegram/paths.test.ts` | Create | macOS/Windows 路径与 containment |
| `desktop/electron/telegram/appCredentials.test.ts` | Create | build credentials schema 与不回显 |
| `desktop/electron/telegram/childEnv.test.ts` | Create | 两类 child 完整环境的秘密剔除与必需键保留 |
| `desktop/electron/telegram/supervisor.test.ts` | Create | 随机回环端口和进程生命周期 |
| `desktop/electron/telegram/client.test.ts` | Create | API 方法、file URI 与错误分类 |
| `desktop/electron/telegram/sidecarGateway.test.ts` | Create | Main-only 强类型协议封装 |
| `desktop/electron/telegram/deliveryWorker.test.ts` | Create | 串行发送、重试、续租与崩溃边界 |
| `desktop/electron/telegram/controller.test.ts` | Create | 绑定、发现、断开和恢复编排 |
| `desktop/electron/telegram/ipc.test.ts` | Create | 窄 IPC、schema 与安全事件广播 |
| `desktop/electron/telegram/packaging.test.ts` | Create | electron-builder YAML 合并与资源布局 |
| `desktop/electron/packageSmoke.ts` | Create | 安装包专用的可等待启动与正常退出入口 |
| `desktop/electron/packageSmoke.test.ts` | Create | 安装包 smoke 模式的正常启动、收敛与退出契约 |
| `native/process-host/CMakeLists.txt` | Create | 无第三方依赖的跨平台受控子进程宿主构建 |
| `native/process-host/main.cpp` | Create | Windows Job Object / macOS process-group 的先登记后放行宿主 |
| `native/process-host/README.md` | Create | fd3 控制协议、父进程死亡与退出语义 |

### Renderer

| 文件 | 操作 | 唯一职责 |
|---|---|---|
| `desktop/renderer/components/TelegramSettingsTab.tsx` | Create | Token 绑定、目标发现/测试、自动发送开关、断开 |
| `desktop/renderer/components/TelegramSettingsTab.test.tsx` | Create | 四种连接态、Token 清空、启用门槛 |
| `desktop/renderer/components/TelegramDeliveryList.tsx` | Create | 最近发送、失败重试、uncertain 二次确认 |
| `desktop/renderer/components/TelegramDeliveryList.test.tsx` | Create | 分页、状态文案和重试行为 |
| `desktop/renderer/components/TelegramDeliveryBadge.tsx` | Create | 下载卡片的发送状态摘要 |
| `desktop/renderer/components/TelegramDeliveryBadge.test.tsx` | Create | 状态到产品文案/样式映射 |
| `desktop/renderer/SettingsApp.tsx` | Modify | 新增“发送”页签且不把 Token 纳入普通设置 autosave |
| `desktop/renderer/SettingsApp.test.tsx` | Create | 普通设置 autosave 与 yt-dlp 随应用更新文案 |
| `desktop/renderer/main.tsx` | Modify | 主窗口只装配一次 Telegram realtime coordinator |
| `desktop/renderer/settings-main.tsx` | Modify | 设置窗口只装配一次 Telegram realtime coordinator |
| `desktop/renderer/components/DownloadCard.tsx` | Modify | 展示单任务 Telegram delivery badge |
| `desktop/renderer/lib/types.ts` | Modify | 非秘密设置、snapshot 和 delivery DTO |
| `desktop/renderer/lib/api.ts` | Modify | RendererMethod 泛型收窄 |
| `desktop/renderer/lib/telegramRuntime.ts` | Create | 订阅优先、snapshot 水合、事件回放与幂等卸载 |
| `desktop/renderer/lib/telegramRuntime.test.ts` | Create | 水合竞态、StrictMode 重挂载与 listener 清理 |
| `desktop/renderer/store/appStore.ts` | Modify | delivery 按 taskId 水合与单调事件合并 |
| `desktop/renderer/store/appStore.test.ts` | Modify | 乱序事件、终态不回退和 task 映射 |
| `desktop/renderer/i18n.ts` | Modify | 中英文 Telegram 产品文案 |
| `desktop/renderer/styles.css` | Modify | 设置、列表、徽标和响应式样式 |
| `desktop/renderer/vite-env.d.ts` | Modify | `window.api` 的具名 Telegram 方法类型 |

### 官方本地服务、打包、CI 与文档

| 文件 | 操作 | 唯一职责 |
|---|---|---|
| `packaging/telegram-bot-api/source.lock.json` | Create | 固定官方 commit、仓库、平台和构建元数据 |
| `packaging/telegram-bot-api/vcpkg.json` | Create | Windows x64 构建依赖 |
| `packaging/telegram-bot-api/vcpkg-configuration.json` | Create | 固定 vcpkg baseline |
| `packaging/telegram-bot-api/windows-system-dll-policy.json` | Create | 固定 Windows 系统 DLL 的路径、签名与拒绝规则 |
| `packaging/telegram-bot-api/licenses/BSL-1.0.txt` | Create | 官方服务许可证原文 |
| `packaging/telegram-bot-api/licenses/OpenSSL.txt` | Create | 固定 OpenSSL 3 官方许可证原文 |
| `packaging/telegram-bot-api/licenses/zlib.txt` | Create | 固定 zlib 官方许可证原文 |
| `packaging/ffmpeg-macos/source.lock.json` | Create | 固定 FFmpeg 7.1.1 官方源码 commit、arm64 与 macOS 11 基线 |
| `packaging/ffmpeg-macos/COPYING.LGPLv2.1` | Create | macOS FFmpeg 构建对应的官方许可证原文 |
| `packaging/ffmpeg-macos/lame-3.100-macos.patch` | Create | 仅移除 macOS 不可用的旧 LAME export |
| `packaging/ffmpeg-macos/LAME-COPYING` | Create | LAME 3.100 对应许可证原文 |
| `packaging/ffmpeg-windows/source.lock.json` | Create | 把 Windows LGPL binary 绑定到 BtbN build 与 FFmpeg commit |
| `packaging/ffmpeg-windows/COPYING.LGPLv3` | Create | Windows LGPLv3 FFmpeg 许可证原文 |
| `packaging/ffmpeg-windows/THIRD_PARTY_LICENSES.txt` | Create | BtbN 选中 LGPL build stages 的依赖声明 |
| `packaging/requirements-sidecar.txt` | Modify | 固定 Sidecar 直接依赖版本 |
| `packaging/requirements-sidecar-macos-arm64.lock.txt` | Create | macOS arm64 完整 hash-locked Python 依赖 |
| `packaging/requirements-sidecar-windows-x64.lock.txt` | Create | Windows x64 完整 hash-locked Python 依赖 |
| `packaging/sidecar-sources.lock.json` | Create | 两个平台 lock 并集的 sdist、SHA 与许可证映射 |
| `packaging/sidecar-install-artifacts.lock.json` | Create | 两个平台实际安装 wheel 的文件名、URL 与 SHA256 精确集合 |
| `packaging/curl-cffi-native.lock.json` | Create | curl-cffi wheel、libcurl-impersonate 原生资产与静态组件源码闭包 |
| `packaging/sidecar-windows-runtime-policy.json` | Create | 冻结 Sidecar 的 CPython/MSVC/UCRT 导入解析、签名与 bundle 规则 |
| `packaging/cpython-windows-runtime.lock.json` | Create（Task 13）、Modify（Task 15） | Windows Sidecar 全部非系统 PE 的精确路径、组件、来源与许可证闭包 |
| `packaging/cpython-macos-runtime.lock.json` | Create（Task 13）、Modify（Task 15） | 固定 macOS arm64 构建解释器资产、Sidecar 全部 Mach-O、逐成员 imports、组件源码与许可证闭包 |
| `packaging/cpython-windows-runtime-licenses/CPython-PSF-2.0.txt` | Create | CPython 3.11.9 官方许可证原文 |
| `packaging/cpython-windows-runtime-licenses/OpenSSL-Apache-2.0.txt` | Create | CPython Windows OpenSSL 3.0.13 官方许可证原文 |
| `packaging/cpython-windows-runtime-licenses/SQLite-Public-Domain.txt` | Create | CPython Windows SQLite 3.45.1 官方 public-domain dedication |
| `packaging/cpython-windows-runtime-licenses/bzip2-License.txt` | Create | CPython Windows bzip2 1.0.8 官方许可证原文 |
| `packaging/cpython-windows-runtime-licenses/XZ-COPYING.txt` | Create | CPython Windows XZ 5.2.5 完整复合许可证原文 |
| `packaging/cpython-windows-runtime-licenses/libffi-MIT.txt` | Create | CPython Windows libffi 3.4.4 官方许可证原文 |
| `packaging/cpython-windows-runtime-licenses/zlib-Zlib.txt` | Create | CPython Windows zlib 1.3.1 官方许可证原文 |
| `packaging/cpython-windows-runtime-licenses/Microsoft-Visual-Cpp-Runtime.txt` | Create | 随包 MSVC runtime 的官方 redistributable 条款与来源声明 |
| `packaging/curl-cffi-native-licenses/curl-cffi-MIT.txt` | Create | curl-cffi 固定 commit 的 MIT 原文 |
| `packaging/curl-cffi-native-licenses/curl-impersonate-MIT.txt` | Create | curl-impersonate 固定 commit 的 MIT 原文 |
| `packaging/curl-cffi-native-licenses/curl-curl.txt` | Create | curl 固定 commit 的许可证原文 |
| `packaging/curl-cffi-native-licenses/BoringSSL.txt` | Create | BoringSSL 固定 commit 的完整复合许可证原文 |
| `packaging/curl-cffi-native-licenses/zlib-Zlib.txt` | Create | zlib 固定 commit 的 Zlib 许可证原文 |
| `packaging/curl-cffi-native-licenses/zstd-BSD-3-Clause.txt` | Create | zstd 固定 commit 的 BSD-3-Clause 原文 |
| `packaging/curl-cffi-native-licenses/brotli-MIT.txt` | Create | brotli 固定 commit 的 MIT 原文 |
| `packaging/curl-cffi-native-licenses/nghttp2-MIT.txt` | Create | nghttp2 固定 commit 的 MIT 原文 |
| `packaging/curl-cffi-native-licenses/nghttp3-MIT.txt` | Create | nghttp3 固定 commit 的 MIT 原文 |
| `packaging/curl-cffi-native-licenses/ngtcp2-MIT.txt` | Create | ngtcp2 固定 commit 的 MIT 原文 |
| `packaging/curl-cffi-native-licenses/sfparse-MIT.txt` | Create | nghttp3 实际编译的 sfparse 子模块 MIT 原文 |
| `packaging/sidecar-THIRD_PARTY_LICENSES.txt` | Create | Sidecar、CPython 与全部 Python 依赖许可证集合 |
| `packaging/SOURCE-OFFER.txt.in` | Create | 同 tag 对应源码包的固定下载声明模板 |
| `packaging/release-binaries.lock.json` | Create | 固定 Windows 月末 LGPL FFmpeg URL、大小与 SHA256 |
| `packaging/sidecar.spec` | Modify | 只内嵌 yt-dlp 模块，不再复制独立 executable |
| `THIRD_PARTY_NOTICES.md` | Create | 实际分发二进制及依赖声明 |
| `desktop/resources/telegram-bot-api/.gitkeep` | Create | 资源目录骨架；构建产物与凭据保持忽略 |
| `desktop/resources/process-host/.gitkeep` | Create | 受控进程宿主资源目录骨架；平台构建物保持忽略 |
| `desktop/resources/third-party-licenses/.gitkeep` | Create | 平台许可证与 source offer 的资源目录骨架 |
| `.gitignore` | Modify | 忽略 Telegram 二进制、DLL、manifest 和构建凭据 |
| `scripts/lib/telegramPackaging.mjs` | Create | 凭据/资源 manifest 的纯函数 |
| `scripts/tests/telegramPackaging.test.mjs` | Create（Task 13）、Modify（Task 14/15） | secret 不回显、schema 和 SHA256 测试 |
| `scripts/generate_telegram_build_credentials.mjs` | Create | 从环境生成临时 app credentials |
| `scripts/generate_telegram_resource_manifest.mjs` | Create | 生成不含秘密值的资源 manifest |
| `scripts/audit_telegram_secrets.ps1` | Create | 对 Git HEAD/index、工作树、构建产物与诊断输入执行同一套无回显秘密扫描 |
| `scripts/read_release_versions.mjs` | Create | 跨 PowerShell 版本读取 HEAD/worktree 的桌面、lock 根包与独立扩展 semver |
| `scripts/run_telegram_release_bootstrap.ps1` | Create（Task 17A） | 由工作区外 SHA 锚定、以 no-follow handle 装载 runner/private lock 的最小双平台自举实现 |
| `scripts/run_telegram_release_acceptance.ps1` | Create（Task 15）、Modify（Task 17A） | 唯一编排入口与可恢复 formal/acceptance/publication transaction |
| `scripts/tests/telegramReleaseAcceptance.test.mjs` | Create（Task 15）、Modify（Task 17A） | preflight receipts、ledger/canonical ingest、强杀、late run、rollback、clean HEAD 与秘密 finally 测试 |
| `scripts/prepare_telegram_release_versions.mjs` | Create | 从可信 abandoned marker 校验并同步更新桌面 package/lock 与独立扩展 semver |
| `scripts/tests/telegramReleaseVersions.test.mjs` | Create | 独立版本递增、部分写入重跑、额外文件拒绝与确定性输出 |
| `scripts/install_sidecar_locked.py` | Create | 只安装平台 artifact lock 允许的 wheel 并生成规范化安装报告 |
| `scripts/verify_curl_cffi_native.py` | Create | 验证 curl-cffi wheel 原生成员、架构、imports、构建配方与源码闭包 |
| `scripts/verify_cpython_windows_runtime.py` | Create | 枚举 Windows onedir 全部 PE 并生成/复核路径、SHA、组件和源码报告 |
| `scripts/build_release_source_bundle.sh` | Create | 生成与 release binary 精确对应的第三方源码包 |
| `scripts/verify_release_source_bundle.mjs` | Create | 验证源码包结构、SHA、路径安全与 lock 完整性 |
| `scripts/build_telegram_bot_api_macos.sh` | Create | 固定 commit、macOS 11 基线的原生构建与依赖检查 |
| `scripts/build_telegram_bot_api_windows.ps1` | Create | 固定 commit、x64 static triplet 的 Windows 原生构建 |
| `scripts/build_process_host_macos.sh` | Create | 构建并验证 arm64/macOS 11 受控进程宿主 |
| `scripts/build_process_host_windows.ps1` | Create | 构建并验证 x64 Windows Job Object 宿主 |
| `scripts/test_process_host.py` | Create | 真进程父崩溃、后代收敛、stdio/control 隔离 smoke |
| `scripts/verify_telegram_bot_api_resource.sh` | Create | macOS 架构、权限、动态依赖、凭据前置检查 |
| `scripts/verify_telegram_bot_api_resource.ps1` | Create | Windows PE、static 依赖、System32 签名策略、启动和凭据前置检查 |
| `scripts/install_ffmpeg.sh` | Modify | 以固定官方源码构建 arm64 FFmpeg，删除 Intel-only 下载路径 |
| `scripts/fetch_release_binaries.sh` | Modify | 按 lock 构建 macOS FFmpeg 或校验 Windows LGPL FFmpeg，不再下载 yt-dlp executable |
| `scripts/fetch_release_binaries.ps1` | Modify | Windows 原生下载器只按同一 lock 获取 LGPL FFmpeg |
| `scripts/build_sidecar.sh` | Modify | release 只安装平台 hash lock 并验证 bundled yt-dlp |
| `scripts/verify_macos_package_arch.sh` | Create | 枚举安装包全部 Mach-O 并验证 arm64/minOS |
| `desktop/package.json` | Modify（Task 15/17P/17R） | 固定 builder/test依赖并准备未使用的桌面正式版本 |
| `desktop/package-lock.json` | Modify（Task 15/17P/17R） | 锁定测试依赖并与桌面版本保持 top/root 一致 |
| `browser-extension/manifest.json` | Modify（Task 17P/17R conditional） | 扩展保持独立 semver；仅扩展自身发布或 formal run 被放弃时独立递增，绝不强绑桌面版本 |
| `desktop/electron-builder.yml` | Modify | 以 `extraResources` 装入平台本地服务 |
| `scripts/build_macos_dmg.sh` | Modify | 构建/校验/生成凭据/清理凭据的完整编排 |
| `scripts/build_windows_nsis.ps1` | Modify | Windows 对称编排与 `finally` 清理 |
| `.github/workflows/release-packages.yml` | Create | tag/manual 双平台构建、源码包校验与 tag-push 精确四件 draft 暂存 |
| `README.md` | Modify | 用户功能、限制和隐私边界 |
| `docs/TELEGRAM-BOT-API-BUILD.md` | Create | 固定输入、可审计构建和双平台验证 |
| `docs/RELEASE.md` | Modify | DMG/NSIS/扩展 zip 与 Telegram 资源发版门禁 |
| `docs/COMMERCIAL.md` | Modify | 体积、凭据、隐私和支持成本 |
| `docs/REGRESSION-2026-08.md` | Modify | 真实 Bot 与双平台回归证据模板 |
| `docs/REGRESSION-2026-08.json` | Create | 绑定验收前 HEAD、workflow run、四份发布物与四份原生审计报告的机器可读证据 |
| `docs/REGRESSION-2026-08-windows.json` | Create | Windows 安装、artifact SHA 与平台秘密扫描证据 |
| `docs/REGRESSION-2026-08-macos.json` | Create | macOS 安装、artifact SHA 与平台秘密扫描证据 |
| `docs/REGRESSION-2026-08-manual.json` | Create | 2GB 边界与 output lifecycle 真实验收证据 |

---

## Phase 0 — 隔离与基线

### Task 0: 创建干净实施工作树并冻结基线

**Files:**
- Read only: current dirty worktree
- Create through Git: clean worktree on `feat/m1-telegram-auto-delivery`

- [ ] **Step 1: 读取并遵循 worktree 技能**

使用 `superpowers:using-git-worktrees`。先记录当前工作树状态，并要求用户明确提供已完成 m0 基线的 immutable commit（以下通过非秘密会话变量传入；不能由脚本默取脏工作树 HEAD）：

```powershell
$SourceRoot = 'D:\work\downany\.worktrees\windows-m0-git'
$PlanPath = 'docs/superpowers/plans/2026-08-10-telegram-auto-delivery.md'
$PlanCommit = (git -C $SourceRoot log -n 1 --format=%H -- $PlanPath).Trim()
if ($LASTEXITCODE -ne 0 -or $PlanCommit -notmatch '^[0-9a-f]{40}$') { throw 'cannot resolve committed plan' }
$ApprovedM0BaseCommit = [string]$env:DOWNANY_APPROVED_M0_BASE_COMMIT
if ($ApprovedM0BaseCommit -notmatch '^[0-9a-f]{40}$') { throw 'explicit approved m0 base commit is required' }
git -C $SourceRoot cat-file -e "$ApprovedM0BaseCommit`^{commit}"
if ($LASTEXITCODE -ne 0) { throw 'approved m0 base commit does not exist' }
git -C $SourceRoot merge-base --is-ancestor $PlanCommit $ApprovedM0BaseCommit
if ($LASTEXITCODE -ne 0) { throw 'approved m0 base does not contain this plan' }
git -C $SourceRoot status --short
if ($LASTEXITCODE -ne 0) { throw 'cannot inspect source worktree' }
```

Expected: 用户已明确确认 `$ApprovedM0BaseCommit` 对应的提交本身包含完整双平台 m0 基线与本计划；status 仍显示用户现有 WIP，且命令不改动它。若用户确认任何必需基线仍在该 WIP 中，本任务在此阻塞，不能创建新工作树。

- [ ] **Step 2: 创建隔离分支与工作树**

按技能选出的安全目录创建分支 `feat/m1-telegram-auto-delivery`。如果目标目录采用仓库现有约定，命令为：

```powershell
$SourceRoot = 'D:\work\downany\.worktrees\windows-m0-git'
$TargetRoot = 'D:\work\downany\.worktrees\telegram-auto-delivery'
$ApprovedM0BaseCommit = [string]$env:DOWNANY_APPROVED_M0_BASE_COMMIT
if ($ApprovedM0BaseCommit -notmatch '^[0-9a-f]{40}$') { throw 'explicit approved m0 base commit is required' }
git -C $SourceRoot worktree add -b feat/m1-telegram-auto-delivery $TargetRoot $ApprovedM0BaseCommit
if ($LASTEXITCODE -ne 0) { throw 'cannot create isolated implementation worktree' }
```

`$ApprovedM0BaseCommit` 必须是用户明确确认的完整 40 位 SHA；校验失败立即停止。实现者不得为了绕过此门禁把源工作树 diff 带入新工作树。

- [ ] **Step 3: 验证隔离**

```powershell
git -C D:\work\downany\.worktrees\telegram-auto-delivery status --short
git -C D:\work\downany\.worktrees\telegram-auto-delivery branch --show-current
git -C D:\work\downany\.worktrees\windows-m0-git status --short
Set-Location D:\work\downany\.worktrees\telegram-auto-delivery
```

Expected: 新工作树 clean 且分支名正确；旧工作树 WIP 清单逐项未变。Task 0 之后本计划所有相对路径命令都必须以新工作树为 cwd；每次恢复执行先用 `git branch --show-current` 确认当前分支。

- [ ] **Step 4: 跑不改产品状态的基线测试**

```powershell
pytest tests/core tests/data tests/sidecar -q
npm.cmd --prefix desktop test
npm.cmd --prefix desktop run build
node browser-extension/shared.test.js
node browser-extension/sniff-core.test.js
```

Expected: 全部 PASS；若有基线失败，先记录完整失败并单独修复，不能把基线失败混进 Telegram 提交。

---

## Phase 1 — Sidecar 持久化事实来源

### Task 1: 建立 output-ready 与 Telegram delivery 数据模型

**Files:**
- Modify: `src/data/models.py`
- Modify: `src/data/database.py`
- Create: `src/data/telegram_delivery_store.py`
- Modify: `tests/data/test_database.py`
- Create: `tests/data/test_telegram_delivery_store.py`

- [ ] **Step 1: 写旧库迁移、幂等入队和租约失败测试**

测试至少创建三类数据库：没有新列的旧库、只有 `download_history` 的空库、完整新库。断言：

```python
assert history_record.output_state == "pending"
assert history_record.output_ready_at is None
first = store.record_output_ready_and_enqueue(task_id, draft, ready_at, owner_id=None)
second = store.record_output_ready_and_enqueue(task_id, draft, ready_at, owner_id=None)
assert first.created is True and first.record is not None and first.record.id == delivery_id
assert second.created is False and second.record is not None and second.record.id == delivery_id
assert len(store.list_deliveries(limit=50, offset=0).items) == 1
```

并为两个独立 SQLite connection 同时 `claim_next` 写测试，断言仅一个得到记录；错误 `lease_id` 调用 `mark_sent` 必须抛 `DeliveryStateConflict`。

- [ ] **Step 2: 确认测试失败**

Run:

```powershell
pytest tests/data/test_database.py tests/data/test_telegram_delivery_store.py -q
```

Expected: FAIL，原因是 schema、类型和 store 尚不存在。

- [ ] **Step 3: 增加明确类型**

在 `src/data/models.py` 增加：

```python
class OutputState(str, Enum):
    PENDING = "pending"
    PROCESSING = "processing"
    READY = "ready"
    INTERRUPTED = "interrupted"


class TelegramDeliveryStatus(str, Enum):
    PENDING = "pending"
    PREPARING = "preparing"
    SENDING = "sending"
    RETRY_WAIT = "retry_wait"
    SENT = "sent"
    FAILED = "failed"
    UNCERTAIN = "uncertain"
    CANCELLED = "cancelled"
    SKIPPED_OVERSIZE = "skipped_oversize"


@dataclass(frozen=True)
class TelegramDeliveryDraft:
    task_id: str
    account_id: str
    target_chat_id: str
    target_chat_type: str
    target_chat_title: str
    source_url: str
    title: str
    file_path: str
    file_size: int
    file_mtime_ns: int
    media_kind: str


@dataclass(frozen=True)
class TelegramDeliveryRecord:
    id: str
    task_id: str
    account_id: str
    target_chat_id: str
    target_chat_type: str
    target_chat_title: str
    source_url: str
    title: str
    file_path: str
    file_size: int
    file_mtime_ns: int
    media_kind: str
    status: str
    attempt_count: int
    retry_sequence_count: int
    request_attempt_charged: bool
    fallback_used: bool
    next_attempt_at: str | None
    lease_id: str | None
    lease_expires_at: str | None
    request_started_at: str | None
    last_error_code: str
    last_error_message: str
    telegram_message_id: str | None
    created_at: str
    updated_at: str
    sent_at: str | None


@dataclass(frozen=True)
class RecoveryResult:
    requeued_count: int
    uncertain_count: int
    recovered_ready_count: int
    recovered_unmarked_count: int
    interrupted_task_ids: tuple[str, ...]


@dataclass(frozen=True)
class OutputReadyEnqueueResult:
    record: TelegramDeliveryRecord | None
    created: bool


WriterFenceResult = TypeVar("WriterFenceResult")


class TelegramDeliveryWriterFence(Protocol):
    def record_output_ready_and_enqueue(
        self,
        task_id: str,
        draft: TelegramDeliveryDraft | None,
        ready_at: str,
        owner_id: str | None,
    ) -> OutputReadyEnqueueResult: ...

    def resolve_expired_processing_output(
        self,
        *,
        task_id: str,
        expected_owner_id: str | None,
        expected_lease_expires_at: str | None,
        draft: TelegramDeliveryDraft | None,
        recovered_at: str,
    ) -> "ExpiredProcessingResolution | None": ...


@dataclass(frozen=True)
class ExpiredProcessingResolution:
    history_record: DownloadRecord
    delivery_record: TelegramDeliveryRecord | None
    delivery_created: bool


@dataclass(frozen=True)
class TelegramTargetBlock:
    account_id: str
    target_chat_id: str
    error_code: str
    error_message: str
    blocked_at: str


@dataclass(frozen=True)
class TelegramDeliveryPage:
    items: tuple[TelegramDeliveryRecord, ...]
    total: int
    offset: int
    limit: int


OutputRecoveryPhase = Literal[
    "expired_processing",
    "safe_unmarked",
    "ready_without_delivery",
]


@dataclass(frozen=True)
class OutputRecoveryCursor:
    sort_at: str
    task_id: str


@dataclass(frozen=True)
class OutputRecoveryHoldSnapshot:
    account_id: str
    intent: Literal["replace_account", "disconnect"]
    created_at: str


@dataclass(frozen=True)
class OutputRecoveryConfigSnapshot:
    revision: str
    account_id: str | None
    target_chat_id: str | None
    target_chat_type: str | None
    target_chat_title: str | None
    target_verified_at: str | None
    auto_send_enabled: bool
    enabled_at: str | None
    delivery_recovery_hold: OutputRecoveryHoldSnapshot | None


@dataclass(frozen=True)
class OutputRecoveryScan:
    high_water_history_rowid: int
    recovered_at: str
    config: OutputRecoveryConfigSnapshot


@dataclass(frozen=True)
class OutputRecoveryContinuation:
    scan: OutputRecoveryScan | None
    phase: OutputRecoveryPhase
    after: OutputRecoveryCursor | None


STARTUP_OUTPUT_RECOVERY_BUDGET_SECONDS = 2.0


@dataclass(frozen=True)
class OutputRecoveryCandidatePage:
    items: tuple[DownloadRecord, ...]
    next_cursor: OutputRecoveryCursor | None
    exhausted: bool


@dataclass(frozen=True)
class OutputRecoveryPageResult:
    phase: OutputRecoveryPhase
    next_cursor: OutputRecoveryCursor | None
    exhausted: bool
    database_busy: bool
    config_changed: bool
    delta: RecoveryResult
```

`TelegramDeliveryRecord` 的 27 个字段与批准 SQL schema 逐项对应；`file_mtime_ns` 按规范非负十进制 TEXT 持久化，Python model 转任意精度 `int`，进入 JSON/TypeScript claim 时再转十进制字符串，绝不经过 JS `number`。`request_attempt_charged` 是 Main-only 的内部状态，不进入 claim/list/event DTO；`retry_sequence_count` 是持久自动重试序号，只进入 Main-only claim DTO，不进入 Renderer summary。在现有 `DownloadRecord` 末尾追加：

```python
output_state: str = OutputState.PENDING.value
output_ready_at: str | None = None
output_recovery_safe: bool = False
output_owner_id: str | None = None
output_lease_expires_at: str | None = None
```

- [ ] **Step 4: 实现兼容迁移和不破坏 readiness 的 UPSERT**

`HistoryDB` 初始化时用 `PRAGMA table_info(download_history)` 检测并分别执行：

```sql
ALTER TABLE download_history ADD COLUMN output_state TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE download_history ADD COLUMN output_ready_at TEXT;
ALTER TABLE download_history ADD COLUMN output_recovery_safe INTEGER NOT NULL DEFAULT 0;
ALTER TABLE download_history ADD COLUMN output_owner_id TEXT;
ALTER TABLE download_history ADD COLUMN output_lease_expires_at TEXT;
```

把当前 `INSERT OR REPLACE` 改成 SQLite UPSERT，并把 API 固定为 `add_download_record(record, *, output_state_override: OutputState | None = None, output_recovery_safe_override: bool | None = None, output_owner_id_override: str | None = None, output_lease_expires_at_override: str | None = None)`。普通调用在 `ON CONFLICT(id) DO UPDATE` 中保留现有五个 output lifecycle 字段；只有显式 lifecycle override 时才在同一 UPSERT 写新的初始状态/恢复标志/owner lease 并把 `output_ready_at` 清空。旧库新增列的 `output_recovery_safe=0` 是关键防线：历史 completed 记录不得被误当成“新版本无脚本崩溃窗口”。`output_recovery_safe` 只允许 0/1；owner 与 lease 必须同时为空或同时为非空。测试先写 ready 记录再做普通更新，readiness 必须保留；再分别写 no-script `PENDING/safe=1/no owner` 与 script `PROCESSING/safe=0/owner+lease`，五字段必须原子一致。

- [ ] **Step 5: 实现完整队列表和事务状态机**

在 `src/data/telegram_delivery_store.py` 创建批准规格中的 `telegram_delivery_queue` 表和 `idx_telegram_delivery_due` 索引，并加入 `retry_sequence_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_sequence_count >= 0)` 与只供原子计次回滚使用的 `request_attempt_charged INTEGER NOT NULL DEFAULT 0 CHECK (request_attempt_charged IN (0,1))`；`attempt_count` 只统计可能到达本地服务的发送周期，`retry_sequence_count` 单独保证未提交失败也能跨进程递进退避。无论批准 schema 中是否保留复合 unique，另加 `CREATE UNIQUE INDEX uq_telegram_delivery_task ON telegram_delivery_queue(task_id)`，把“每个下载任务最多一个 delivery snapshot”交给数据库最终保证；换 Bot/目标只影响新 task，不允许同 task 创建第二条。另建持久目标封锁表：

```sql
CREATE TABLE telegram_delivery_target_blocks (
    account_id TEXT NOT NULL,
    target_chat_id TEXT NOT NULL,
    error_code TEXT NOT NULL,
    error_message TEXT NOT NULL DEFAULT '',
    blocked_at TEXT NOT NULL,
    PRIMARY KEY(account_id, target_chat_id)
);
```

然后实现以下精确 contract：

| 方法 | 输入与返回 |
|---|---|
| `record_output_ready_and_enqueue` | `(task_id: str, draft: TelegramDeliveryDraft or None, ready_at: str, owner_id: str or None) -> OutputReadyEnqueueResult`; processing 要求 owner 匹配，pending-safe 允许 owner 为 None |
| `with_writer_fence` | `(operation: Callable[[TelegramDeliveryWriterFence], WriterFenceResult], *, busy_timeout_ms: int = 5000) -> WriterFenceResult`；在同一 history DB connection 上先 `BEGIN IMMEDIATE`，把唯一 connection-bound fence 传给 callback，成功后 commit、异常时 rollback；fence exact公开面只包含不再自行 begin/commit 的 `record_output_ready_and_enqueue(...)` 与 `resolve_expired_processing_output(...)` |
| `mark_output_processing` | `(task_id: str, owner_id: str, lease_expires_at: str) -> None`；只允许同 owner 的 processing |
| `renew_output_processing` | `(task_id: str, owner_id: str, lease_expires_at: str) -> None`；错 owner/state 抛 conflict |
| `max_download_history_rowid` | `() -> int`；在恢复开始时读取 `MAX(download_history.rowid)`，空表返回 0，作为本轮有限扫描上界 |
| `list_expired_processing_outputs` | keyword-only `(recovered_at: str, high_water_history_rowid: int, after: OutputRecoveryCursor or None, limit: int) -> OutputRecoveryCandidatePage`；只读返回无 owner/过期 lease 的 processing 完整快照，按不可变 `(completed_at,id)` keyset，不改变状态 |
| `resolve_expired_processing_output` | keyword-only `(task_id: str, expected_owner_id: str or None, expected_lease_expires_at: str or None, draft: TelegramDeliveryDraft or None, recovered_at: str) -> ExpiredProcessingResolution or None`；公开便利入口只包一层 `with_writer_fence`，connection-bound fence 同名方法不再 begin/commit；同一事务重验 lease，已有 delivery 收敛 ready，否则落 interrupted并按资格创建唯一 failed snapshot |
| `recover_unmarked_outputs` | keyword-only `(high_water_history_rowid: int, after: OutputRecoveryCursor or None, limit: int) -> OutputRecoveryCandidatePage`；只枚举新版本 completed + pending + safe=1 + ready_at null，按不可变 `(completed_at,id)` keyset 返回完整快照 |
| `recover_pending_outputs` | keyword-only `(enabled_at: str, high_water_history_rowid: int, after: OutputRecoveryCursor or None, limit: int) -> OutputRecoveryCandidatePage`；只返回 ready 且尚无任意 account/target delivery，按不可变 `(output_ready_at,id)` keyset返回完整历史快照 |
| `list_deliveries` | keyword-only `offset`, `limit`, optional `status` -> `TelegramDeliveryPage` |
| `claim_next` | keyword-only `account_id`, `now`, `lease_id`, `lease_expires_at` -> matching-account record or `None`；同一事务可领取 pending、到期 retry_wait 或 lease 为空/到期的 preparing，绝不领取 sending |
| `renew_lease` | `(delivery_id, lease_id, lease_expires_at) -> record` |
| `release_claim` | `(delivery_id, lease_id, released_at) -> pending record; only preparing is allowed` |
| `mark_sending` | `(delivery_id, lease_id, request_started_at, media_kind, fallback_used, charge_attempt) -> record` |
| `mark_sent` | `(delivery_id, lease_id, message_id, sent_at) -> record` |
| `mark_skipped_oversize` | `(delivery_id, lease_id, message_id, sent_at) -> record` |
| `mark_retry` | `(delivery_id, lease_id, code, message, next_attempt_at) -> record` |
| `mark_retry_not_submitted` | `(delivery_id, lease_id, code, message, next_attempt_at) -> record` |
| `mark_failed` | `(delivery_id, lease_id, code, message, failed_at) -> record`；`preparing` 只接受 `FILE_MISSING/FILE_UNREADABLE/FILE_CHANGED`，`sending` 只接受 `MEDIA_INVALID` |
| `mark_uncertain` | `(delivery_id, lease_id, code, message, failed_at) -> record` |
| `get_for_retry` | `(delivery_id) -> internal record`；只供 service 编排人工重试，绝不进入协议/Renderer DTO |
| `retry` | keyword-only `(delivery_id, now, confirm_possible_duplicate, confirm_interrupted_output, expected_account_id, expected_status, expected_error_code, expected_updated_at, expected_file_path, refreshed_file_size, refreshed_file_mtime_ns, refreshed_media_kind) -> record`；后三个 refreshed 字段必须全为 `None` 或全为非空 |
| `cancel_pending` | `(optional account_id, now) -> tuple[TelegramDeliveryRecord, ...] for pending/preparing/retry_wait`，按 `id` 排序 |
| `block_target_and_fail_pending` | `(delivery_id, lease_id, account_id, target_chat_id, code, safe_message, failed_at) -> tuple[TelegramDeliveryRecord, ...]`，按 id 排序 |
| `get_target_block` | `(account_id, target_chat_id) -> TelegramTargetBlock or None` |
| `clear_target_block` | `(account_id, target_chat_id) -> bool indicating a removed block` |
| `recover_delivery_leases` | `(now) -> (requeued_count, uncertain_count)`；只在 Sidecar 启动时调用，以一个 `BEGIN IMMEDIATE` 收敛 delivery lease，不碰 output processing lease |

增加具体异常 `DeliveryNotFound(LookupError)`、`DeliveryStateConflict(RuntimeError)` 与 `TargetStillBlocked(DeliveryStateConflict)`。`claim_next` 必须 `BEGIN IMMEDIATE`，并用 `NOT EXISTS` 排除 target block 表中相同 account/chat 的记录；候选条件精确为 `pending`、`retry_wait AND next_attempt_at <= now`、或 `preparing AND (lease_expires_at IS NULL OR lease_expires_at <= now)`，选中旧 preparing 时在同一 UPDATE 覆盖旧 lease、清空旧 request 字段并保持 attempt/retry 计数，不能先提交一次 pending。两个 connection 同时领取到期 preparing时只能一个成功；任何 `sending` 即使 lease 过期也永不由 claim/reaper自动重发。所有其他租约更新必须包含 `WHERE id = ? AND lease_id = ? AND status = ?` 并检查 `rowcount == 1`。`block_target_and_fail_pending` 在一个 transaction 内 upsert block、把当前 sending 记录及相同 account/chat 的 pending/preparing/retry_wait 批量置 failed、清空租约和 `request_attempt_charged`，返回 data record；只有 service 可调用 `_to_summary`。

`record_output_ready_and_enqueue` 必须先 `BEGIN IMMEDIATE`，重读 history 并按本轮状态验证：processing 必须 owner 精确匹配，pending-safe 必须 owner 为 None，already-ready 只允许幂等读取。随后只按 `task_id` 查询任意既有 delivery。若存在，绝不读取/应用当前 draft，但仍须在同一事务把本轮 processing/pending history 收敛为 `ready`、写本轮 `ready_at`、清 owner/lease，再原样返回旧 snapshot 且 `created=false`；already-ready 保留最初 `output_ready_at`。若不存在，才按同样已验证的 history、当前 draft与 target block 写 ready + 唯一 queue row。未封锁插入 pending；已封锁仍把 output 标记 ready，但 delivery 直接以该 block 稳定 code/message 落为 failed；新建两者均 `created=true`。数据库 task unique index 是两个配置实例并发时的最终门禁。这样 taskId 全局幂等不能跳过本轮 output lifecycle。

`record_output_ready_and_enqueue` 与 `resolve_expired_processing_output` 两个公开便利入口都必须只通过 `with_writer_fence` 调用各自同名的 connection-bound 实现；持有 `TelegramDeliveryWriterFence` 时再次调用任一公开入口或另开 writer connection 立即失败，防止嵌套事务。Task 2 的配置写与 `refresh_config=true` 入队都必须复用这个 writer fence，锁顺序固定为 service RLock → SQLite writer fence → JsonConfig RLock；任何代码不得反向取得这些锁。`busy_timeout_ms=0` 只供下述 output recovery 使用，普通下载完成/configure仍保留5000ms并显式处理失败。

人工 retry 不能把旧文件快照原样改回 `pending`。service 先用 `get_for_retry` 读取内部 record；在任何文件 probe 前，先短暂取得 service `RLock`、`reload_from_disk()` 并要求当前 strict config 的 `deliveryRecoveryHold is None` 且 record.account_id 等于当前非空 accountId，否则保持原记录并抛 `DeliveryStateConflict`。当 error code 为 `FILE_CHANGED/FILE_MISSING/FILE_UNREADABLE/POSTPROCESS_INTERRUPTED` 时，必须在任何 DB transaction 和 service lock 外用同一个有界 async probe 连续执行两次 `open → fstat → close`，每次 deadline 2 秒、间隔 250ms。只有两次都得到相同的 `{size,mtimeNs}` 才把 Python 非负整数 `mtimeNs` 转为规范十进制字符串、按当前未变的 `filePath` 扩展名重新计算权威 `mediaKind`。提交前再次取得同一 service `RLock`、重读 config/hold/account；只有仍满足上述条件，才在不释放该锁时把当前 accountId 作为 `expected_account_id` 调用 store `retry`，锁顺序固定为 service RLock → SQLite transaction。探测期间换 Bot、断开或进入 destructive hold 因而只能使重试稳定失败，不能把旧账号记录改成新 worker 永不领取的 pending。探测缺失、不可读、超时、close fault或两次不稳定时，原 failed record 全字段不变并返回其安全 summary，不得假报 pending。Renderer 永远只传 delivery ID 与两个确认布尔值，绝不传路径、size、mtime或 media kind。

store `retry` 在单一 `BEGIN IMMEDIATE` 中重读记录并逐字段 CAS `account_id=expected_account_id` 与 `status/error_code/updated_at/file_path`，再检查相同 account/chat 的 target block；任一不匹配整体 rollback并抛 `DeliveryStateConflict`，命中 block 保持旧记录并抛 `TargetStillBlocked`。上述四种文件错误必须收到全套 refreshed snapshot，原子覆盖 `file_size/file_mtime_ns/media_kind` 后进入 pending；`POSTPROCESS_INTERRUPTED` 还必须在同一 transaction 把对应 history 从 interrupted 收敛为 ready。其他普通 failed/已确认 uncertain 只接受 refreshed 三字段全为 `None`。成功 retry 清旧错误、lease/request字段、把 retry sequence 归零并更新时间；uncertain 仍要求 `confirm_possible_duplicate=true`，`POSTPROCESS_INTERRUPTED` 仍要求 `confirm_interrupted_output=true`。这样用户修复或同路径替换文件后可以真正重试，而 Worker 的发送前双 probe 仍作为第二道竞态防线。测试必须覆盖 Bot A 的 failed/uncertain 记录在切换到 Bot B 后点击重试时零字段变化并返回 `STATE_CONFLICT`，以及同一账号重新连接后仍可重试；文件 probe 期间发生换 Bot、断开或写入 hold 时最终 CAS 前门禁同样失败。

三个 output candidate 查询共享同一个有限 scan：service 在 RLock 内用 `open_output_recovery_scan()` 调用 `with_writer_fence(...,busy_timeout_ms=0)`，在该 fence 内先 `config.reload_from_disk()`、读取完整非秘密 config snapshot，再固定 `recovered_at` 与 `high_water_history_rowid=MAX(download_history.rowid)`，因此 scan snapshot 与并发 configure/CLI mark-ready 服从同一全序。snapshot 的 `revision` 固定为对 `TelegramDeliveryConfigDTO` 全字段按UTF-8键名字节序、无空白JSON规范化后取小写SHA-256 hex；它不是持久设置，也不含秘密。该方法与每个 output-recovery candidate read/write 都必须使用独立短 connection、`timeout=0` 且显式 `PRAGMA busy_timeout=0`；只对 `SQLITE_BUSY/SQLITE_LOCKED` 做正常 defer，任何其他 SQLite 错误仍向上抛出。打开 scan 遇锁返回 `None`；page 遇锁必须 rollback、零 history/queue/event mutation，并返回 `{phase, next_cursor: after, exhausted:false, database_busy:true, config_changed:false, delta: zeroRecoveryResult}`。每个候选的修改事务都必须用 `with_writer_fence(...,busy_timeout_ms=0)`，在读取/修改history之前先 reload当前config并重算revision；不等于scan revision时零修改、零事件、停止本页并返回 `{phase, next_cursor: after, exhausted:false, database_busy:false, config_changed:true, delta: zeroRecoveryResult}`。这样旧scan可以读取候选，但永远不能在disable/换target/换Bot/断开返回后按旧snapshot提交新delivery；变化前已提交的旧account记录由同一writer全序中随后的cancel捕获。三个查询都加 `rowid <= high_water_history_rowid`，expired-processing 与 safe-unmarked 按不可变 `(completed_at,id)`，ready-without-delivery 按不可变 `(output_ready_at,id)` 做 `key > after ORDER BY key LIMIT limit`；相同时间戳用 id 打破平局。`1 <= limit <= 50`。每页正常结果必须显式`database_busy=false/config_changed=false`；`next_cursor`取最后一个读取到的候选，不能取最后一个成功修改的候选；缺文件、文件不稳定、并发续租使 resolve 返回 None 也推进。页数少于 limit 时 `exhausted=true`，恰好等于 limit 时允许再读一个空页。这样未变化的前页不会饿死后续候选，scan 开始后的新记录不会混入本轮；它们及本轮未解决候选留给下一个全新 scan。`list_expired_processing_outputs` 的每个候选由 service 基于同一 config snapshot 构造 draft，并在上述 revision 校验已经通过的同一个 callback 内调用 `fence.resolve_expired_processing_output(...)`；严禁调用会再开 `with_writer_fence` 的公开便利入口。connection-bound 方法继续用该 fence connection 重读 task，要求 state 仍为 processing、owner/lease 与候选完全相等且 lease 仍为空/`<= recovered_at`，否则返回 `None`，绝不打断刚续租任务。随后在同一事务按全局 taskId 查询 delivery：若已有任意状态 snapshot，保持它全字段不变，把 history 收敛为 ready，`output_ready_at=COALESCE(output_ready_at,delivery.created_at,recovered_at)`并清 owner/lease，返回 `delivery_created=false`；若没有 delivery，把 history置 interrupted、清 owner/lease，并仅在 draft 非空时插入唯一 `failed/POSTPROCESS_INTERRUPTED` snapshot。事务前崩溃保留 processing，事务内任一步失败整体回滚；绝不能留下 interrupted + 本应存在但缺失的 failed。service 只有结果 history 仍为 interrupted 时才加入 `interrupted_task_ids`，只有 `delivery_created=true` 才在 commit 后 emit。成功 ready、interrupted、普通 terminal 都清 output owner/lease。`get_target_block` 是重启恢复警告的唯一查询入口；`clear_target_block` 只能由 Controller 在该 target 测试消息成功后调用。`retry` 在单一 transaction 中先查相同 account/chat block；命中保持旧记录并抛 `TargetStillBlocked`；成功人工 retry 把 retry sequence 归零。对 `POSTPROCESS_INTERRUPTED` 的确认 retry 必须原子执行 history ready + queue pending。

上一段“变化前记录由随后 cancel 捕获”只适用于 Task 10 的换 Bot/断开 destructive flow。普通关闭自动发送或换接收位置在线性化点前已提交的记录必须保留，并继续使用其创建时捕获的路由；config 返回后才禁止提交旧资格/旧路由。

`recover_delivery_leases(now)` 的 SQL 语义不能留给实现者推断：它以单个 `BEGIN IMMEDIATE` 重读全表，并在同一事务执行三类互斥转换。`preparing` 只在 `lease_expires_at IS NULL OR lease_expires_at <= now` 时回到 `pending`；所有启动时遗留的 `sending` 无论 lease 是否到期都改为 `uncertain`，错误固定为 `APP_RESTART_RESULT_UNKNOWN`，因为请求结果已经不可证明；`retry_wait` 一律保持原状态、`next_attempt_at` 和计数不变，只能由之后的 `claim_next` 在 `next_attempt_at <= now` 时领取。前两类转换都原子清空 `lease_id/lease_expires_at/request_started_at/request_attempt_charged`，分别计入 `requeued_count/uncertain_count`；任何一条 SQL 或 commit fault 使整个恢复回滚。30 秒 output timer 永不调用此启动专用方法，但正常 `claim_next` 必须按上文在其事务内接管随后到期的 preparing。状态矩阵测试必须覆盖 lease 恰好等于 now、未过期 preparing 启动时不动但到期后可被唯一 claim、未过期 sending 仍 uncertain、运行期 sending 永不被自动领取、未来/到期 retry_wait、双 connection与每条 SQL fault-injection。

`recover_unmarked_outputs(...keyset...)` 固定查询 `status='completed' AND output_state='pending' AND output_ready_at IS NULL AND output_recovery_safe=1 AND output_owner_id IS NULL AND output_lease_expires_at IS NULL`，再叠加 rowid high-water 与 `(completed_at,id)` after/limit 条件并返回完整 `DownloadRecord`；旧库默认 safe=0，永不进入。service 对每个候选调用下述 `probe_readable_file` 两次，间隔 250ms；每次都必须实际以只读模式打开文件、对已打开描述符做 `fstat`、确认 regular file并在 `finally` 关闭，不能用路径 `stat` 冒充可读性。两次 size/mtime 完全一致的稳定者才调用同一个原子 ready/enqueue；缺失、不可读、关闭失败或变化者保留 pending并写对应稳定非秘密诊断，供下轮恢复。`recover_pending_outputs(...keyset...)` 固定执行 SQL 条件：`output_state='ready' AND output_ready_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM telegram_delivery_queue q WHERE q.task_id=download_history.id)`，再叠加 rowid high-water 与 `(output_ready_at,id)` keyset；`NOT EXISTS` 不按当前 account/target过滤，避免换目标后重复补发。它把旧 `completed_at` 按产生机器本地时区解析成 UTC，仅保留 `completed_at >= enabled_at`。无 `output_ready_at`、已有任意终态/非终态 delivery、启用前1微秒、无法安全解析时间的行都不返回。
`media_kind` 只接受 `video/audio/document/oversize_notice`；`mark_sending` 允许 `preparing → sending`，也允许同一 lease 的 `sending → sending` 仅用于一次媒体 fallback 更新 `document/fallback_used=true`。首个文件/通知请求传 `charge_attempt=true`，原子把 `attempt_count` 加 1 并写 `request_attempt_charged=true`；同一 lease 的 fallback 请求传 `charge_attempt=false`，保留已有次数并把 `request_attempt_charged=false`，因为前一个媒体请求已经得到明确响应。`mark_failed` 同样按 source state 做单一 SQL CAS：匹配 lease 的 `preparing` 只允许 `FILE_MISSING`、`FILE_UNREADABLE` 或 `FILE_CHANGED`，不增加 `attempt_count/retry_sequence_count`，并原子清空 lease、request time 与 request flag；匹配 lease 的 `sending` 只允许 `MEDIA_INVALID` 且保留已消耗次数。任一 code/state 交叉组合或非 preparing/sending source 都抛 `DeliveryStateConflict`，绝不能留下占租约的 preparing。
`mark_retry_not_submitted` 只接受 preparing 或同一 lease 的 sending：preparing 直接进入 retry_wait；sending 仅在 `request_attempt_charged=true` 时原子回退刚增加的 1 次（不得低于 0），fallback 的 false 不回退先前已完成的媒体尝试；随后两者都把 `retry_sequence_count` 加 1，并清 lease、`request_started_at` 和 request flag。它只供 client 能证明请求未到本地服务时使用。`mark_retry` 保留已消耗次数；除 `AUTH_INVALID` 外，每次明确进入自动 retry 都把 `retry_sequence_count` 加 1，401 的凭据暂停路径保留该序号。`renew_lease` 只允许同一 lease 的 preparing/sending；`release_claim` 只允许 preparing 并清 lease。所有 retry/failed/uncertain/cancelled/sent/skipped 转换都在同一更新中清 `lease_id/lease_expires_at/request_attempt_charged`；自动退避必须使用 claim 时持久化的 `retry_sequence_count` 选择本次延迟，不能使用可能被回退的 `attempt_count`。

上文 `revision` 的 canonical input 必须收窄为只影响入队资格/路由的 `{accountId,target,targetVerifiedAt,autoSendEnabled,enabledAt,deliveryRecoveryHold}`；`discoveredTargets`、`nextUpdateOffset` 与 migration 字段不参与，普通刷新不得让长 scan 反复失效。`deliveryRecoveryHold` 非空时任何 output-ready 路径都只收敛 history、绝不创建新 delivery。其余“对 `TelegramDeliveryConfigDTO` 全字段”字样由本句替代。

- [ ] **Step 6: 增加状态转换矩阵测试**

覆盖：

```text
pending -> preparing -> sending -> sent
pending -> preparing -> sending -> retry_wait -> preparing
pending -> preparing -> retry_wait (service unavailable before request)
pending -> preparing -> failed (FILE_MISSING, FILE_UNREADABLE or FILE_CHANGED before request)
pending -> preparing -> sending -> retry_wait (proven not submitted, charged attempt rolled back)
pending -> preparing -> sending -> failed
pending -> preparing -> sending -> uncertain
pending -> preparing -> sending(oversize_notice) -> skipped_oversize
pending/retry_wait -> cancelled
failed -> pending
uncertain + confirm_possible_duplicate=true -> pending
```

同时断言 `sent`、`skipped_oversize`、`cancelled` 不能重新 claim，`uncertain` 缺确认不能 retry，切换默认目标不改已有快照；`record_output_ready_and_enqueue` 首次返回 `created=true`，随后分别带不同 account、target 和两个 connection 并发重放都返回最初 record 且 `created=false`，总数始终为一。再分别把同一 task 的 history 模拟重入为 processing(owner+lease) 与 pending-safe 后调用 fast path：必须验证 owner/state、原子回到 ready、清 lease且不改变旧 delivery snapshot；错 owner 必须 conflict。模拟 no-script 在重入 history commit 后崩溃，`recover_unmarked_outputs` 走同一 fast path 后不得继续出现在下一轮。
人工重试矩阵必须覆盖：A 文件因 `FILE_CHANGED` 失败后被同路径稳定 B 替换，双 probe 刷新 size/mtime/mediaKind 后可发送；`FILE_MISSING/FILE_UNREADABLE` 修复后可重排；`POSTPROCESS_INTERRUPTED` 只有确认且文件稳定时原子 history ready + queue pending；探测失败/不稳定保持原 failed；探测后记录的 status/error/updatedAt/path 或 target block 并发变化使 CAS 全量失败且不覆盖新真值。再让 retry commit 后、Worker probe 前替换文件，断言 Worker 第二道检查仍落 `FILE_CHANGED`。所有返回/event/snapshot逐字段证明不泄漏 filePath、mtime或 probe error。
再创建两个 account 的 pending 记录，断言 `claim_next(account_id="bot-a")` 永远不能拿到 `bot-b` 记录。
再断言首次 `mark_sending(charge_attempt=true)` 把 attempt 从 0 变 1，fallback 不重复计次；preparing 服务不可用不增 attempt，明确未提交可回退，已接收但响应丢失只能 uncertain。对 preparing 分别以缺失/非 regular 文件写 `FILE_MISSING`、以拒绝读取或 close fault 写 `FILE_UNREADABLE`、以两次 readable snapshot 或入队快照不一致写 `FILE_CHANGED`，三者均零 attempt、清 lease；再交叉传永久 sending code、从 sending 传三个 FILE code、错 lease，全部 conflict 且原记录不变。Windows 用注入的 access-denied adapter，POSIX 用 `000` fixture（root 环境改用拒绝读取 adapter），并断言两次 probe 都执行 open→fstat→close、任一 open/fstat/close fault 都零 `mark_sending`。连续三次 proven-not-submitted 后 retry sequence 持久递增。错误 lease 不能续租，terminal 清 lease；target block 跨重开阻止 claim/retry，clear 后才可人工重排。为 pending/unmarked recovery 覆盖启用边界、全局 taskId、旧库 safe=0、稳定/变化/缺失/不可读文件。为 processing owner 覆盖 renew、错 owner、未过期、恰到期只读候选、候选后续租使 resolve 返回 None、无旧 delivery 时同一 transaction 落 interrupted+failed、有旧 sent/failed/uncertain delivery 时旧 snapshot不变且 history 收敛 ready。用每条 SQL fault-injection并重开，结果只能是 processing原状、ready+旧 delivery或 interrupted+failed；绝不能 interrupted+缺 failed。

writer fence测试用两个connection证明callback期间独占同一history DB writer、成功commit/异常rollback；fence-bound ready/expired-processing 两个方法都不得另开connection，两个公开便利入口都只包一层fence，任一公开入口在callback内嵌套调用都稳定失败。另用并发config/hold barrier证明revision校验后只能经同一 `fence.resolve_expired_processing_output` 提交，期间不存在释放writer再用旧draft落库的窗口。分别断言普通默认5000ms与recovery显式0ms，`SQLITE_BUSY/LOCKED`保留原错误码供service defer，其他数据库错误不被吞掉。

- [ ] **Step 7: 跑定向和 data 回归**

```powershell
pytest tests/data/test_database.py tests/data/test_telegram_delivery_store.py -q
pytest tests/data -q
```

Expected: PASS。

- [ ] **Step 8: Commit**

```powershell
git add src/data/models.py src/data/database.py src/data/telegram_delivery_store.py tests/data/test_database.py tests/data/test_telegram_delivery_store.py
git commit -m "feat(data): add durable telegram delivery queue"
```

---

### Task 2: 保存非秘密配置并线性化 output-ready 入队

**Files:**
- Modify: `src/data/json_config.py`
- Create: `src/sidecar/telegram_delivery_service.py`
- Modify: `src/sidecar/handlers.py`
- Modify: `tests/data/test_json_config.py`
- Create: `tests/sidecar/test_telegram_delivery_service.py`
- Modify: `tests/sidecar/test_handlers.py`

- [ ] **Step 1: 写配置与边界失败测试**

测试断言这些字段可 round-trip：

```python
TELEGRAM_CONFIG_KEYS = {
    "telegram_auto_send_enabled",
    "telegram_enabled_at",
    "telegram_account_id",
    "telegram_account_username",
    "telegram_target_chat_id",
    "telegram_target_chat_type",
    "telegram_target_chat_title",
    "telegram_target_verified_at",
    "telegram_next_update_offset",
    "telegram_discovered_targets",
    "telegram_migration_state",
    "telegram_migration_account_id",
    "telegram_migration_started_at",
    "telegram_delivery_recovery_hold",
}
```

同时参数化拒绝 `telegram_bot_token`、`bot_token`、`token`、`telegram_api_id`、`telegram_api_hash`、`api_hash`。普通 `settings.update` 还必须拒绝所有 `telegram_` 前缀字段，防止 Renderer 绕过测试消息门槛直接启用；只有 delivery service 的专用内部写入口能更新这些非秘密字段。`settings.get`、`settings.update` 返回值和 app snapshot 的普通 `settings` DTO 必须零 `telegram_` 字段，Telegram 状态只从 Controller IPC 返回。增加“Bot 已绑定后修改主题/下载目录仍成功”的回归测试，以及普通 settings update 与 Telegram configure 并发 100 次不丢字段的测试。非法 chat type、数字 chat ID、Renderer 自带 `enabled_at` 均返回验证错误。

- [ ] **Step 2: 确认测试失败**

```powershell
pytest tests/data/test_json_config.py tests/sidecar/test_telegram_delivery_service.py tests/sidecar/test_handlers.py -q
```

Expected: FAIL，现有配置没有白名单与 service。

- [ ] **Step 3: 实现非秘密配置**

`JsonConfig` 增加上述默认值，`telegram_discovered_targets` 默认 `[]`，`telegram_migration_state` 默认 `idle` 且只允许 `idle/logout_started/cloud_logged_out`，`telegram_delivery_recovery_hold` 默认 `null`，ID 全部保存为字符串。hold 非空时必须是 strict `{accountId,intent,createdAt}`，其中 `intent` 只允许 `replace_account/disconnect`，不含 Token、路径或错误文本。构造时创建一个 `threading.RLock`，所有 `_data` 读取、合并、赋值与 `_save` 都在同一锁内完成。增加只供 Sidecar delivery service 调用的 `update_telegram_delivery_config(partial)`、`to_renderer_settings()`，以及 `reload_from_disk() -> dict`；现有 `update_from_dict` 遇到任意 `telegram_` 前缀键必须拒绝。秘密键在两个写入口都拒绝。`reload_from_disk` 在同一个 RLock 内打开当前 path、解析完整 object、合并 defaults、执行同一 Telegram 类型校验后一次替换 `_data`，不回写文件；`_save` 使用同目录临时文件 + `os.replace`。单独一次 JSON open/read 不是跨进程线性化点：只有 Task 1 同一 history DB 的 `BEGIN IMMEDIATE` writer fence 从 config snapshot 读取前一直持有到 history/queue commit 后，才能线性化 CLI 完成入队；所有 Telegram config 写也必须持有同一个 fence 直到 JSON 原子替换完成。JSON 损坏时保持旧 `_data` 并失败，不能用半份配置继续入队。常量为：

```python
ALLOWED_TELEGRAM_CHAT_TYPES = frozenset({"private", "group", "supergroup", "channel"})
FORBIDDEN_SECRET_KEYS = frozenset({
    "telegram_bot_token", "bot_token", "token",
    "telegram_api_id", "telegram_api_hash", "api_hash",
})
```

`update_from_dict` 遇到 `FORBIDDEN_SECRET_KEYS` 或任意 `telegram_` key 必须抛 `ValueError`，不得静默忽略；`update_telegram_delivery_config` 只接受 `TELEGRAM_CONFIG_KEYS` 且同样拒绝秘密。`to_dict()` 仅供 Sidecar 内部读取完整非秘密持久配置；`to_renderer_settings()` 过滤所有 `telegram_` key。`_settings_get`、`_settings_update` 和 app snapshot 普通 settings 都必须调用后者，永不把 Telegram 配置带入 SettingsApp 全对象 autosave。

配置加载还必须在合并 defaults 之前，对磁盘解析得到的 raw object 执行一次受同一 `RLock` 与同目录原子替换保护的旧键迁移。运行时唯一合法字段是 `telegram_next_update_offset`：若 raw object 只存在旧 `telegram_last_update_id`，先把它按非负规范十进制字符串解析为任意精度整数，再写入 `telegram_next_update_offset = last + 1` 并在同一次文件替换中删除旧键；若 raw object 新旧两键同时存在、旧值畸形/为负或任一值不是规范十进制字符串，则以稳定配置迁移错误 fail closed，文件与内存都保持原样。迁移成功后才合并 defaults；旧键从此属于禁止输入，任何普通/Telegram patch 都不得重新创建。测试覆盖 `42 → 43`、大于 `Number.MAX_SAFE_INTEGER`、双键冲突零写入、畸形/负数、原子替换 fault、成功后重开只剩新键，以及旧键被所有写入口拒绝。

- [ ] **Step 4: 实现 service 的配置锁和 output-ready 原子入口**

```python
class TelegramTargetDTO(TypedDict):
    id: str
    type: Literal["private", "group", "supergroup", "channel"]
    title: str
    discoveredAt: str


class TelegramDeliveryRecoveryHoldDTO(TypedDict):
    accountId: str
    intent: Literal["replace_account", "disconnect"]
    createdAt: str


class TelegramDeliveryConfigPatch(TypedDict, total=False):
    accountId: str | None
    accountUsername: str | None
    target: TelegramTargetDTO | None
    targetVerifiedAt: str | None
    autoSendEnabled: bool
    discoveredTargets: list[TelegramTargetDTO]
    nextUpdateOffset: str | None
    migrationState: Literal["idle", "logout_started", "cloud_logged_out"]
    migrationAccountId: str | None
    migrationStartedAt: str | None
    deliveryRecoveryHold: TelegramDeliveryRecoveryHoldDTO | None


class TelegramDeliveryConfigDTO(TypedDict):
    accountId: str | None
    accountUsername: str | None
    target: TelegramTargetDTO | None
    targetVerifiedAt: str | None
    autoSendEnabled: bool
    enabledAt: str | None
    discoveredTargets: list[TelegramTargetDTO]
    nextUpdateOffset: str | None
    migrationState: Literal["idle", "logout_started", "cloud_logged_out"]
    migrationAccountId: str | None
    migrationStartedAt: str | None
    deliveryRecoveryHold: TelegramDeliveryRecoveryHoldDTO | None


class TelegramDeliverySummaryDTO(TypedDict):
    id: str
    taskId: str
    status: str
    title: str
    targetTitle: str
    attemptCount: int
    updatedAt: str
    messageKey: str
    errorCode: str
    retryConfirmation: Literal["none", "possible_duplicate", "interrupted_output"]


class TelegramDeliveryPageDTO(TypedDict):
    items: list[TelegramDeliverySummaryDTO]
    total: int
    offset: int
    limit: int


class TelegramClaimedDeliveryDTO(TypedDict):
    id: str
    taskId: str
    accountId: str
    targetChatId: str
    targetChatType: Literal["private", "group", "supergroup", "channel"]
    targetChatTitle: str
    sourceUrl: str
    title: str
    filePath: str
    fileSize: int
    fileMtimeNs: str
    mediaKind: Literal["video", "audio", "document", "oversize_notice"]
    attemptCount: int
    retrySequenceCount: int
    fallbackUsed: bool


class TelegramClaimDTO(TypedDict):
    delivery: TelegramClaimedDeliveryDTO
    leaseId: str


class TelegramTargetBlockDTO(TypedDict):
    accountId: str
    targetChatId: str
    errorCode: Literal["TARGET_PERMISSION_DENIED", "TARGET_NOT_FOUND"]
    blockedAt: str


class ReadableFileSnapshot(TypedDict):
    isFile: Literal[True]
    size: int
    mtimeNs: int


class AsyncReadableFileProbe(Protocol):
    async def __call__(self, path: str, *, timeout_seconds: float) -> ReadableFileSnapshot: ...


RECOVERY_FILE_PROBE_TIMEOUT_SECONDS = 2.0


def probe_readable_file(path: str) -> ReadableFileSnapshot: ...


class TelegramDeliveryService:
    def __init__(
        self,
        config: JsonConfig,
        store: TelegramDeliveryStore,
        now: Callable[[], datetime],
        new_id: Callable[[], str],
        probe_readable_file: Callable[[str], ReadableFileSnapshot],
        probe_readable_file_async: AsyncReadableFileProbe,
        sleep: Callable[[float], Awaitable[None]],
    ) -> None: ...
    def configure(self, patch: TelegramDeliveryConfigPatch) -> TelegramDeliveryConfigDTO: ...
    def get_config(self) -> TelegramDeliveryConfigDTO: ...
    def mark_processing(self, task: DownloadTask, owner_id: str, lease_expires_at: str) -> None: ...
    def renew_processing(self, task_id: str, owner_id: str, lease_expires_at: str) -> None: ...
    def mark_ready(self, task: DownloadTask, owner_id: str | None, *, refresh_config: bool = False) -> str | None: ...
    def list_summaries(self, *, offset: int, limit: int, status: str | None) -> TelegramDeliveryPageDTO: ...
    def claim_next(self, *, account_id: str, now: str, lease_expires_at: str) -> TelegramClaimDTO | None: ...
    def renew_lease(self, delivery_id: str, lease_id: str, lease_expires_at: str) -> None: ...
    def release_claim(self, delivery_id: str, lease_id: str, released_at: str) -> TelegramDeliverySummaryDTO: ...
    def mark_sending(self, delivery_id: str, lease_id: str, request_started_at: str, media_kind: str, fallback_used: bool, charge_attempt: bool) -> TelegramDeliverySummaryDTO: ...
    def mark_sent(self, delivery_id: str, lease_id: str, message_id: str, sent_at: str) -> TelegramDeliverySummaryDTO: ...
    def mark_retry(self, delivery_id: str, lease_id: str, code: str, message: str, next_attempt_at: str) -> TelegramDeliverySummaryDTO: ...
    def mark_retry_not_submitted(self, delivery_id: str, lease_id: str, code: Literal["NETWORK_NOT_SUBMITTED", "LOCAL_SERVICE_EXITED"], message: str, next_attempt_at: str) -> TelegramDeliverySummaryDTO: ...
    def mark_failed(self, delivery_id: str, lease_id: str, code: str, message: str, failed_at: str) -> TelegramDeliverySummaryDTO: ...
    def mark_target_failed(self, delivery_id: str, lease_id: str, account_id: str, target_chat_id: str, code: Literal["TARGET_PERMISSION_DENIED", "TARGET_NOT_FOUND"], safe_message: str, failed_at: str) -> list[TelegramDeliverySummaryDTO]: ...
    def mark_uncertain(self, delivery_id: str, lease_id: str, code: str, message: str, failed_at: str) -> TelegramDeliverySummaryDTO: ...
    def mark_skipped_oversize(self, delivery_id: str, lease_id: str, message_id: str, sent_at: str) -> TelegramDeliverySummaryDTO: ...
    def get_target_block(self, account_id: str, target_chat_id: str) -> TelegramTargetBlockDTO | None: ...
    def clear_target_block(self, account_id: str, target_chat_id: str) -> bool: ...
    async def retry(self, delivery_id: str, now: str, confirm_possible_duplicate: bool, confirm_interrupted_output: bool) -> TelegramDeliverySummaryDTO: ...
    def cancel_pending(self, account_id: str | None, now: str) -> int: ...
    def recover_delivery_leases(self) -> RecoveryResult: ...
    def open_output_recovery_scan(self) -> OutputRecoveryScan | None: ...
    async def recover_output_lifecycle_page(self, *, scan: OutputRecoveryScan, phase: OutputRecoveryPhase, after: OutputRecoveryCursor | None, limit: int) -> OutputRecoveryPageResult: ...
    def summaries_by_task(self) -> dict[str, TelegramDeliverySummaryDTO]: ...
    def set_event_emitter(self, emit: Callable[[str, dict[str, object]], None]) -> None: ...
```

这些是 service 的完整公开面；协议 handler 只调用它们，不得访问 `service._store`、`TelegramDeliveryStore` 或自行构造 summary/lease，且 retry handler 必须 `await service.retry(...)`。模块级 production `probe_readable_file` 固定执行 `open(path, "rb") → os.fstat(handle.fileno()) → stat.S_ISREG → finally close`，只返回 `ReadableFileSnapshot`；它只供同步 `mark_ready`/CLI 使用。CLI精确注入永远抛固定`CLI_OUTPUT_RECOVERY_FORBIDDEN`的async adapter且永不调用recovery facade；正常Sidecar恢复与人工文件重试的两次探测都必须`await probe_readable_file_async(path,timeout_seconds=2.0)`，不得直接调用同步probe、`asyncio.to_thread`或默认executor。production async adapter固定为`RecoveryFileProbePool(sync_probe,loop,max_workers=2,max_pending=2)`，其中max_pending是运行+排队总future上限而非额外queue容量，因此总future和daemon worker均最多2。每个probe有generation与墙钟deadline，可取消；timeout/cancel/`close_accepting()`后的迟到结果全部丢弃且不得写SQLite/事件。两个worker均挂起时新probe立即得到稳定unavailable，不增线程/队列；close幂等取消未开始future且永不join。missing/unreadable/close failure/timeout只留候选给后续scan或保持人工重试记录 failed，并写无路径诊断。`claim_next`通过注入`new_id()`生成lease ID。上述TypedDict逐字段匹配Task4 claim/summary/page/target-block JSON。TypeScript对称拆config patch/full config；Gateway configure只接patch并拒绝空/未知/enabledAt/秘密字段。

`TelegramDeliveryService.claim_next` 必须与 `configure` 共用同一个 service `RLock`：取得锁后先读取内存中的 strict `deliveryRecoveryHold`，非空立即返回 `None`，为空才在仍持锁时调用 store 的完整 `BEGIN IMMEDIATE` claim transaction，commit/rollback 后才释放锁。禁止“先查hold、解锁、再claim”。因此 destructive hold writer fence 与 claim 只有两个合法全序：claim先commit则随后 `worker.stop()` 收敛该active；hold先commit则之后 claim/send 调用数为0。锁顺序仍是 service RLock → SQLite writer fence/claim transaction，不能反向。

`get_config` 只通过 Main-only `telegramDelivery.getConfig` 暴露，不进入普通 settings DTO。`list_summaries` 是完整 DB record 到 Renderer-safe summary 的唯一转换入口，复用同一个私有 `_to_summary` 给 list、snapshot 和事件；store 的 bulk-fail/cancel 永远先返回 records，service 才排序并 `_to_summary`。`configure` 与 `mark_ready` 共用 `_lock`，并且二者都必须调用 store 的 `with_writer_fence`。`configure` 在 fence callback 内执行 config validate + 原子 JSON replace，只有 DB fence commit 后才返回。调用方只有在持有“原 configure handler 已产生唯一 correlated terminal frame、后续 `get_config` 必然排在它之后”的进程内终态证明时，才可重新 `get_config` 幂等确认；timeout、连接断开或缺失 response 无此证明，旧进程不得回读或盲目反向覆盖，只能进入重启恢复。`false → true` 时由 Sidecar 生成新的 `telegram_enabled_at`；`true → false` 必须同时清空它，确保再次启用不会补发关闭期间完成的文件。只有 account、target 和 `telegram_target_verified_at` 都存在时允许启用。`mark_ready` 先在任何 DB lock 之外用注入的 `probe_readable_file` 确认最终绝对路径可读且为 regular file，并以该打开句柄的 `size` 与纳秒级 `mtimeNs` snapshot 准备 draft 输入；store 把 `file_mtime_ns` 保存为规范非负十进制 TEXT，不得以路径 `stat` 或毫秒浮点值代替。新记录在这里按最终扩展名初始化持久 `media_kind`（`.mp4=video`、`.mp3/.m4a=audio`、其余 document），Worker 后续不重新猜。随后进入唯一 writer fence callback：若 `refresh_config=true`，先在 fence 内调用 `config.reload_from_disk()`，紧接着读取完整 account/target/enabledAt 快照并构造最终 draft；再调用 connection-bound `fence.record_output_ready_and_enqueue`，在同一 transaction 校验 processing owner（无脚本 pending-safe 则 owner 必须为 None）、写 `output_state=ready`、`output_ready_at`、清 owner lease，并按 `completed_at >= enabled_at` 决定是否插入 delivery。只有“取得 writer fence → 读取 config snapshot → history/queue commit”整个区间才是资格、目标与关闭动作的跨进程线性化点。Sidecar 同进程调用保留默认 false但仍走 fence；独立 CLI sink 必须传 true。

上段所有 draft/insert 条件还必须同时要求 `deliveryRecoveryHold is None`；hold 非空时仍原子写 history ready、清 output owner/lease，但绝不创建 delivery。`mark_ready` 必须在同一个 writer fence 内读取 hold，恢复暂停因此和关闭、换 Bot、断开拥有同一跨进程线性化点；任何较早的“只读 account/target/enabledAt”或“仅按 completed_at 判断插入”字样均由本句收窄。

事件映射固定且 transaction 必须先 commit、后 emit：新建未封锁 delivery 发 `telegramDelivery.queued`；因 target block 新建的 failed 发 `failed`；claim、release、markSending、markRetry、markRetryNotSubmitted、成功进入 pending 的人工 retry 发 `updated`；人工文件重试探测失败并返回未改变的 failed summary 时零 event；markSent 与 markSkippedOversize 发 `sent`；markFailed 发 `failed`；markUncertain 发 `uncertain`；markTargetFailed 对返回的每个受影响 summary 按 `id` 排序各发一次 `failed`；cancelPending 对实际改变的 records 按 `id` 排序各发一次 `updated`。renewLease、list/getConfig/configure、get/clear target block 不发 delivery event。emitter 抛错只把经过稳定脱敏的消息写 stderr，不回滚已提交数据，也不重复 emit。`cancel_pending` 调 store 得到 records 后逐项 emit，最后返回 `len(records)`。

- [ ] **Step 5: 固定启用时间与恢复语义**

测试使用可控时钟验证：

- 启用前 1 微秒完成的任务不入队。
- 恰好等于 `enabled_at` 的任务入队。
- 切换目标后，旧记录继续使用旧 chat ID，新记录使用新 chat ID。
- `processing` 只有 owner lease 为空或到期时才会被只读列为候选；service 用当次持久 config snapshot 构造 draft 后，调用单一 `resolve_expired_processing_output` transaction 重验 owner/lease。候选后若 CLI 刚续租则返回 None，不触碰/emit；无旧 delivery 才原子落 `interrupted` 与唯一 `failed/POSTPROCESS_INTERRUPTED`，已有旧 snapshot则保持它不变并把本轮 history 收敛 ready。CLI 每 30 秒续 120 秒 lease 时 Sidecar 不得打断；CLI 强杀后最迟下一 recovery tick 收敛。人工重试 interrupted 记录必须确认本地文件可用，再由 store 原子 ready+重排。
- 无自定义脚本的新版本记录只有 `output_recovery_safe=1` 才可从 pending 恢复；文件两次实际只读打开并以 descriptor `fstat` 确认为可读 regular file，且 size/mtime 稳定时才补记 ready/enqueue。有脚本与旧库历史 safe=0，绝不能猜测 ready。
- event emitter 失败只写 stderr 日志，已提交 SQLite transaction 不回滚。
- `telegram_discovered_targets` 按 chat ID 去重并最多保留最近 200 个，防止普通配置无限增长。
- 两个独立 `JsonConfig` 实例模拟 Sidecar 与长时间 CLI：CLI 下载启动后，另一实例分别 disable、重新 enable 和换 target；CLI 完成调用 `mark_ready(refresh_config=true)` 必须使用完成线性化点看到的新配置，disable 时不入队、enable 时按新 enabledAt 判资格、换目标时只写新 target，绝不发送到启动时旧 chat。
- 启动恢复拆成两个不可互换的入口：`recover_delivery_leases()` 只做上文完整单事务 queue 收敛，必须在 early hello 与 peer hello 都成功后、业务 request loop 与 `app.ready` 前执行，绝不受启动预算截断；`open_output_recovery_scan()` 在 service RLock 下尝试取得完整 config snapshot、固定 recoveredAt 与 rowid high-water。output recovery 是可续跑的非阻塞启动工作：`finish_startup_output_recovery(batch_size=50, budget_seconds=2.0) -> OutputRecoveryContinuation | None` 先创建 `{scan:null,phase:"expired_processing",after:null}`；scan 打开遇 DB busy 立即原样返回该 continuation，取得 scan 后才按 `expired_processing → safe_unmarked → ready_without_delivery` 推进。startup 阶段每次固定 `limit=1`，并以从启动单调时钟计算的绝对 2 秒 deadline 包围每次 page 调用；`database_busy=true` 时立即返回完全相同的 scan/phase/cursor给30秒timer，禁止同一 tick自旋；`config_changed=true` 时丢弃整个旧scan/cursor，并返回新的 `{scan:null,phase:"expired_processing",after:null}`，同一 tick不再开scan，下一tick才按新配置/新high-water开始。到 deadline 立即返回当前 phase 与最后一个已成功返回 page 的 cursor；不得猜测已读取但响应未返回的 cursor，若事务已提交而响应丢失，下次从旧 cursor 重放并依赖既有 task-idempotent transaction 收敛。只有 timeout、明确 DB busy和config revision变化属于正常 defer，其他异常仍使启动失败且零 `app.ready`。service 只在短事务内持有 RLock/SQLite lock，任何 `await self._sleep(0.25)`、async file probe 或事件投递期间都不得持锁；event loop 上的 recovery DB 调用因 `busy_timeout=0` 不得等待另一个 writer。30 秒串行 timer 在 `app.ready` 前安装并接管同一个 continuation：只要 continuation 非空，后续 tick 只能沿同一 scan/phase/cursor继续；`scan=null` 时只重试取得一次scan，三个 phase 全部 exhausted 后才允许下个 tick创建新 scan，禁止每 tick 从 null重扫或busy-loop造成后部候选饥饿。每次 store 读取不超过传入 limit，cursor 对每个读到的候选都前进；safe pending 逐个异步等待 250ms做两次有界 readable probe后原子 ready/enqueue。只有 revision仍匹配且snapshot 中 auto-send已启用、account/target/verifiedAt/enabledAt完整时才构造 delivery draft；否则 revision变化走上述重开，配置本身未启用则单事务仍修正output state但不排队。ready phase对每个候选用原`output_ready_at`调同一个task-idempotent transaction；只有`created=true`分别增加`recovered_unmarked_count/recovered_ready_count`。命中target block直接生成failed。旧历史、已有任意delivery和重复recovery都不会补发。shutdown丢弃内存continuation即可；下次进程以新scan按DB真值幂等恢复。`summaries_by_task()`只经store安全查询读取每个task最新record并逐项调用同一个`_to_summary`，不得暴露完整record。测试以虚拟时钟阻塞probe，同时发`app.ping`必须仍响应；永久挂起probe时`app.shutdown`须在2秒内退出且迟到结果零提交；再用第二个真实SQLite connection持有writer锁跨过2秒deadline，断言scan/page均立即defer、ping持续响应、只发一次`app.ready(outputRecoveryPending=true)`、锁释放后同一continuation最终完成且零重复；若检测到RLock跨await持有或recovery connection的busy timeout非0则立即失败。

- 上述 recovery draft 资格同样必须要求 `deliveryRecoveryHold is None`；hold 进入 revision 后，任何页发现它变化都按 `config_changed` 丢弃旧 continuation，下一 tick 以持久 hold 重开且只修正 history、不排队。
- 参数化覆盖 service 每个公开方法（包括四个新增 facade）、config patch 缺席字段保留、空/未知/秘密 patch、`true→false` 清 enabledAt、再次启用生成新 enabledAt、完整 snapshot、所有事件映射、batch排序且恰好一次，以及 emitter失败后数据库仍已提交。用两个真实进程/独立 JsonConfig+store 和可控 barrier 覆盖跨进程 fence：CLI 与普通 disable 或换target并发时，若 CLI 先取得 writer fence并提交旧 snapshot，该既有记录必须保留并继续使用已捕获的旧target；若 config 操作先提交并返回，CLI 必须看到 disabled 或新target。普通 disable/换target都不得取消线性化点前已经入队的记录，只有 Task 10 的解绑或更换 Bot 流程才取消旧账号尚未开始的记录；任何 config 操作返回后都绝不能再提交使用过期 enabled/account/target 的新 delivery。JSON replace、DB begin/commit 与进程强杀逐点 fault injection只能留下可由`get_config`幂等确认的完整旧/新配置，不能半写。恢复测试覆盖 0/1/50/51/120/数百候选、前50 missing+次50 unstable+末20 stable仍不饥饿、第二个新 scan 重见前100、scan中插入较小 key但更大rowid只在下轮出现、相同时间戳按ID无重无漏、候选读取后续租仍推进 cursor、三phase独立cursor、2秒预算后唯一app.ready且同一continuation后台最终exhaust、history commit后mark_ready前强杀的safe pending；ready-without-delivery；启用边界；关闭期间ready在再次启用后仍不补；换account/target后重放仍返回首个snapshot且本轮history ready/lease cleared；target blocked；两次恢复计数；活跃CLI lease不被打断；CLI强杀后到期以单事务恢复；SQL fault injection不产生interrupted-without-delivery；`RecoveryResult.recovered_unmarked_count/recovered_ready_count/interrupted_task_ids`。另让数百候选continuation在第2页后依次发生disable、换target、换Bot与断开+cancel；旧scan每次都必须检测revision变化、零cursor/零旧account-target新记录并在下一tick以新scan重开，cancel返回后永不重新出现旧pending。
- `deliveryRecoveryHold` 测试必须覆盖默认null、strict round-trip、未知intent/额外字段/错account拒绝、普通settings零泄漏，以及hold writer fence与CLI mark-ready并发的两种全序：hold先commit则只写history不排队，CLI先commit则该既有记录之后由同一 destructive flow 的cancel捕获。再用 idle Worker 的 claim barrier 覆盖 hold 与 claim：hold 先commit时 claim/send=0；claim 先commit时 stop 必须看到并收敛这条 active。hold设置后长recovery scan必须因revision变化丢弃，下一tick零新delivery；清hold失败或response丢失绝不能半清或自动恢复发送：只有Main已取得同request terminal-frame proof时才可用后续`get_config`看到完整旧/新对象，无proof则旧进程零回读/零反向写并进入重启恢复。

- [ ] **Step 6: 跑定向测试**

```powershell
pytest tests/data/test_json_config.py tests/sidecar/test_telegram_delivery_service.py tests/sidecar/test_handlers.py -q
```

Expected: PASS。

- [ ] **Step 7: Commit**

```powershell
git add src/data/json_config.py src/sidecar/telegram_delivery_service.py src/sidecar/handlers.py tests/data/test_json_config.py tests/sidecar/test_telegram_delivery_service.py tests/sidecar/test_handlers.py
git commit -m "feat(sidecar): add telegram delivery orchestration"
```

---

### Task 3: 在最终后处理之后发出 output-ready

**Files:**
- Modify: `src/core/interfaces.py`
- Modify: `src/core/download_manager.py`
- Modify: `src/cli/__main__.py`
- Modify: `tests/core/test_download_manager.py`
- Create: `tests/cli/test_cli.py`

- [ ] **Step 1: 写顺序和隔离失败测试**

使用记录调用顺序的 fake sink 与 fake script runner，断言：

```python
assert calls == [
    "download-completed",
    "task-completed-event",
    "output-processing",
    "custom-script-returned",
    "output-ready",
]
assert task.status == TaskStatus.COMPLETED
```

另测：无脚本时 completed 后立即 ready；脚本返回非零仍 ready；sink 抛异常仍保持 completed；同一 task 重入即使其间换 account/target 也不重复 enqueue。再用真实 `python -m src.cli add` 子进程、受控 fake downloader 与阻塞 custom script 验证 CLI：history 初次 commit 已原子带 processing owner/120 秒 lease；脚本每 30 秒续租；脚本仍运行时启动 Sidecar 并跨过两个 recovery tick 不得 interrupted；正常退出清 lease并持久化 ready/唯一 queue；强杀后在 lease 到期前不恢复、到期后的 tick 得到 interrupted + 唯一 `POSTPROCESS_INTERRUPTED` failed delivery，绝不自动发送。无脚本子进程精确强杀在 history commit 与 `mark_ready` 之间，Sidecar 两次 readable probe 后必须补为 ready/enqueue；旧库 safe=0 fixture 不补。

- [ ] **Step 2: 确认失败**

```powershell
pytest tests/core/test_download_manager.py -q
```

Expected: FAIL，当前 `task_completed` 发生在脚本之前且没有 sink。

- [ ] **Step 3: 定义 Telegram 无关接口**

在 `src/core/interfaces.py` 增加：

```python
class OutputReadySink(Protocol):
    def mark_processing(self, task: DownloadTask, owner_id: str, lease_expires_at: str) -> None:
        raise NotImplementedError

    def renew_processing(self, task_id: str, owner_id: str, lease_expires_at: str) -> None:
        raise NotImplementedError

    def mark_ready(self, task: DownloadTask, owner_id: str | None) -> str | None:
        raise NotImplementedError
```

接口文件只引用 core task 类型，不导入任何 Telegram data/sidecar 模块。

- [ ] **Step 4: 注入并调用 sink**

给 `DownloadManager.__init__` 增加 `output_ready_sink: OutputReadySink | None = None`、可注入 `output_owner_id: str | None` 与 UTC clock；真实 Sidecar/CLI 构造时各生成一个随机 128-bit owner ID，同一 manager 生命周期固定复用，测试注入稳定值。保持现有下载完成、历史保存和 `task_completed` 语义，然后执行：

```python
heartbeat = None
if custom_script and self._output_ready_sink is not None:
    self._safe_mark_output_processing(task, owner_id, now_plus_120s)
    heartbeat = self._start_output_lease_heartbeat(
        task.id,
        owner_id,
        every_seconds=30,
        ttl_seconds=120,
    )
if custom_script:
    try:
        self._run_postprocess_script(task)
    finally:
        if heartbeat is not None:
            heartbeat.stop_and_join()
if self._output_ready_sink is not None:
    self._safe_mark_output_ready(task, owner_id if custom_script else None)
```

把 `_save_to_history` 扩成接收 Task 1 的五个 lifecycle override。仅当 sink 存在时：completed 脚本任务在初次 history UPSERT 就原子写 `PROCESSING/safe=0/owner_id/now+120s`，无脚本任务写 `PENDING/safe=1/no owner`；不带 sink 的孤立 core 单测不启用 lifecycle。脚本的 owner lease 因而不存在“history 已 processing 但无恢复身份”的窗口，随后 `mark_processing` 只是同 owner 的确认/续租。heartbeat helper 的 exact keyword-only 参数固定为 `every_seconds: float` 与 `ttl_seconds: float`，production 逐字传30和120；它使用 daemon thread + stop event，但 `stop_and_join` 有界等待且测试结束零残留线程；每次续租基于当次 clock 生成新 `now+ttl_seconds`。三个 `_safe_` 方法捕获 sink 异常并只记录 task ID/异常类型；heartbeat 连续失败也不改变 completed 下载状态，持久 lease 到期后由 Sidecar恢复。普通 history UPSERT 保留 lifecycle 字段；成功 ready 原子清 owner/lease。为避免类型循环，`OutputReadySink` 对 `DownloadTask` 的导入放在 `TYPE_CHECKING` 分支。

`src/cli/__main__.py::_build_manager` 不得再走无 sink 路径，也不能用 Telegram store 替代现有下载队列 store。完整装配固定为：

```python
import asyncio
import os
import time
from datetime import datetime, timezone
from uuid import uuid4


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _new_id() -> str:
    return uuid4().hex


async def _cli_output_recovery_forbidden(
    _path: str,
    *,
    timeout_seconds: float,
) -> ReadableFileSnapshot:
    raise RuntimeError("CLI_OUTPUT_RECOVERY_FORBIDDEN")


class CliOutputReadySink:
    def __init__(self, service: TelegramDeliveryService) -> None:
        self._service = service

    def mark_processing(
        self,
        task: DownloadTask,
        owner_id: str,
        lease_expires_at: str,
    ) -> None:
        self._service.mark_processing(task, owner_id, lease_expires_at)

    def renew_processing(
        self,
        task_id: str,
        owner_id: str,
        lease_expires_at: str,
    ) -> None:
        self._service.renew_processing(task_id, owner_id, lease_expires_at)

    def mark_ready(self, task: DownloadTask, owner_id: str | None) -> str | None:
        return self._service.mark_ready(task, owner_id, refresh_config=True)


HistoryDB._instance = None
config = JsonConfig(str(paths.config_path))
db = HistoryDB(db_path=str(paths.history_db_path))
queue_store = QueueStore(str(paths.history_db_path))
delivery_store = TelegramDeliveryStore(db)
delivery_service = TelegramDeliveryService(
    config=config,
    store=delivery_store,
    now=_utc_now,
    new_id=_new_id,
    probe_readable_file=probe_readable_file,
    probe_readable_file_async=_cli_output_recovery_forbidden,
    sleep=asyncio.sleep,
)
cli_sink = CliOutputReadySink(delivery_service)
manager = DownloadManager(
    config=config,
    db=db,
    queue_store=queue_store,
    temp_dir=str(paths.temp_dir),
    output_ready_sink=cli_sink,
    output_owner_id=_new_id(),
)
manager.restore_tasks()
manager.start()
```

`QueueStore` 与 `TelegramDeliveryStore` 是两个独立对象，但都指向同一个 `paths.history_db_path`；前者继续负责 `restore_tasks/_persist`，后者只负责 delivery/output 原子状态。上面的 `CliOutputReadySink` 是完整 production adapter：两个 processing 方法原样转发 owner lease，`mark_ready` 固定传 `refresh_config=True`，确保长下载结束时从磁盘重读 Telegram 开关/启用时间/目标。CLI 装配测试必须真实调用 `_build_manager(paths)` 完成上述全部构造，而不是只实例化 adapter mock；先用真实 QueueStore 写入一条 paused task，再捕获 manager 的完整 `config/db/queue_store/temp_dir/output_ready_sink/output_owner_id`，断言 `restore_tasks()` 通过它恢复，而 delivery store 中零伪下载队列；两个 store 不是同一对象，但各自持有的规范化 DB path 必须相等，并逐方法验证 adapter 参数及返回值不变。该测试也证明生产 import block 含 `asyncio`，`sleep=asyncio.sleep` 在 factory 求值时不会抛 `NameError`。CLI 永不调用 Sidecar 启动专用的 `recover_delivery_leases()`，否则与同时运行的 Sidecar 竞争时可能把真实 sending 误转 uncertain；该入口只由 Sidecar 在 early/peer hello 成功后且 `app.ready` 前调用，30 秒 output timer也不得调用。CLI 不启动 Electron worker 或 Telegram 本地服务；它只持久化当前任务的 output lifecycle/delivery，桌面端已运行时由 30 秒轮询领取，未运行时留待下次 Sidecar 启动恢复。

- [ ] **Step 5: 跑 core 回归**

```powershell
pytest tests/core/test_download_manager.py tests/cli/test_cli.py -q
pytest tests/core -q
```

Expected: PASS。

- [ ] **Step 6: Commit**

```powershell
git add src/core/interfaces.py src/core/download_manager.py src/cli/__main__.py tests/core/test_download_manager.py tests/cli/test_cli.py
git commit -m "feat(core): expose durable output-ready lifecycle"
```

---

### Task 4: 暴露租约协议并修正 Sidecar 启动顺序

**Files:**
- Modify: `src/core/download_manager.py`
- Modify: `src/sidecar/protocol.py`
- Modify: `src/sidecar/handlers.py`
- Modify: `src/sidecar/server.py`
- Modify: `tests/core/test_download_manager.py`
- Modify: `tests/sidecar/test_protocol.py`
- Modify: `tests/sidecar/test_handlers.py`
- Modify: `tests/sidecar/test_server.py`
- Modify: `tests/sidecar/test_e2e_subprocess.py`

- [ ] **Step 1: 写协议和端到端失败测试**

固定以下内部方法：

```text
telegramDelivery.configure
telegramDelivery.getConfig
telegramDelivery.list
telegramDelivery.claimNext
telegramDelivery.renewLease
telegramDelivery.releaseClaim
telegramDelivery.markSending
telegramDelivery.markSent
telegramDelivery.markRetry
telegramDelivery.markRetryNotSubmitted
telegramDelivery.markFailed
telegramDelivery.markTargetFailed
telegramDelivery.markUncertain
telegramDelivery.markSkippedOversize
telegramDelivery.getTargetBlock
telegramDelivery.clearTargetBlock
telegramDelivery.retry
telegramDelivery.cancelPending
```

固定业务事件 `telegramDelivery.queued/updated/sent/failed/uncertain`，另增加只供 Electron 启动门禁消费的生命周期事件 `app.ready`，payload 精确为 `{startupLeaseRecoveryComplete:true,outputRecoveryPending:boolean}`。完整单事务 delivery lease recovery、最多2秒的首段 output recovery、`manager.start(scheduler_gate=closed_gate)` 与 recovery timer 安装都成功后只发送一次；`outputRecoveryPending` 精确等于是否仍有 `OutputRecoveryContinuation`。该 pending 状态不阻止 Sidecar start、Main bootstrap、普通下载、历史或扩展桥。在同一个 stdout/protocol writer lock 与单个 event-loop turn 内，必须先把同一 dispatcher 原子提升为完整业务 request dispatch，再同步 write+flush `app.ready`，两者之间不得 await/yield；因此 Electron 一旦读到 ready，紧接着发送的 getConfig/claim 已必然由完整 handler 处理。business-event gate 与 scheduler gate 都只能在 ready flush 成功后打开，所以已恢复 queued task 在 ready 前不能启动 downloader、yt-dlp 或 ffmpeg，后台 recovery 事件也只在 ready 后输出。`app.ready` 不进入 Renderer、Controller delivery event或持久日志。端到端测试顺序为 early hello → peer hello → bounded startup recovery → full request dispatch promotion → app.ready → business-event/scheduler gates open → background continuation/configure → 新下载 output-ready → queued event → claim → markSending → markSent → list，并断言 ready可见前处理的业务请求仍返回startup code、app.ready后的即时请求不再返回该code、manager worker在ready前未运行、数千历史也不会把ready推迟超过预算与调度余量、所有stdout行都能被协议JSON parser解码。

- [ ] **Step 2: 确认失败**

```powershell
pytest tests/sidecar/test_protocol.py tests/sidecar/test_handlers.py tests/sidecar/test_server.py tests/sidecar/test_e2e_subprocess.py -q
```

Expected: FAIL，方法、handlers 与 wiring 尚不存在。

- [ ] **Step 3: 扩充枚举与结构化错误**

`Method`、`EventName` 增加上面的精确字符串（含 `EventName.APP_READY = "app.ready"`）；`ErrorCode` 的 exact additions 为 `NOT_FOUND`、`STATE_CONFLICT`、`TARGET_STILL_BLOCKED` 与 `STARTUP_RECOVERY_IN_PROGRESS`。最后一项只在 peer hello 已通过而 `app.ready` 尚未成功 flush 时用于 correlated protocol response：启动期 control allowlist 精确为既有 `Method.APP_PING = "app.ping"` 与 `Method.APP_SHUTDOWN = "app.shutdown"`。`app.ping` 正常返回既有安全 liveness DTO；`app.shutdown` 取消 startup task、关闭 line pump并正常退出。其他语法正确业务请求都原样关联 request id并返回固定安全 message，不含异常、路径或内部状态。`sidecar.health` 仍只允许作为 `EventName.SIDECAR_HEALTH` 事件，若把它作为 request method 必须返回 `METHOD_NOT_FOUND`，不得误放进 startup allowlist。`STARTUP_RECOVERY_IN_PROGRESS` 不进入 Renderer 的 Telegram IPC error union，因为 Main 在 `app.ready` 前不得发送业务请求。protocol enum、schema 与 exhaustive handler test 必须同时覆盖四条分支。`claimNext` 要求当前已验证的 `accountId`，只领取相同 account 的记录，并返回：

```json
{
  "delivery": {
    "id": "delivery-id",
    "taskId": "task-id",
    "accountId": "123456789",
    "targetChatId": "-100123",
    "targetChatType": "channel",
    "targetChatTitle": "我的频道",
    "sourceUrl": "https://example.com/watch/123",
    "title": "Example",
    "filePath": "absolute-main-only-path",
    "fileSize": 1024,
    "fileMtimeNs": "1723284000123456789",
    "mediaKind": "video",
    "attemptCount": 0,
    "retrySequenceCount": 0,
    "fallbackUsed": false
  },
  "leaseId": "lease-id"
}
```

只有 Main-only claim DTO 含 `filePath`、`accountId` 和 `leaseId`。`telegramDelivery.list` 必须在 Sidecar service 中把完整 record 映射成 `{items,total,offset,limit}`，其中每个 item 精确只有 `id/taskId/status/title/targetTitle/attemptCount/updatedAt/messageKey/errorCode/retryConfirmation`；list、snapshot 和事件摘要绝不含本地路径、lease、account/chat ID、source URL 或 raw error message。handler 测试逐字段断言这些敏感字段无法到达 Renderer。

- [ ] **Step 4: 实现 handler 参数边界**

每个 lease/mark 操作都校验 `deliveryId` 与 `leaseId` 为非空字符串。`markSending` 还要求布尔 `chargeAttempt`；`markRetryNotSubmitted` 只接受 `NETWORK_NOT_SUBMITTED` 或 `LOCAL_SERVICE_EXITED`，不能由 Renderer 调用。`limit` 限制 `1..100`，`offset >= 0`。`configure` 遇到任意 token/api secret key 直接返回 `INVALID_PARAMS`；普通 `settings.update` 遇到任何 `telegram_` 字段也返回 `INVALID_PARAMS`。`markTargetFailed` 只能使用稳定 permission/chat-not-found code，account/chat 必须与 claim record 匹配；`getTargetBlock` 和 `clearTargetBlock` 都是 Main-only，前者返回 `null` 或精确 `{accountId,targetChatId,errorCode,blockedAt}`，不返回 raw error message，后者由 Controller 调用。`retry` 对 uncertain 要求 `confirmPossibleDuplicate=true`，对 `POSTPROCESS_INTERRUPTED` 要求 `confirmInterruptedOutput=true`。handler 将 `DeliveryNotFound` 映射 `NOT_FOUND`，将陈旧 lease/非法转换映射 `STATE_CONFLICT`，将原子 retry 命中的 `TargetStillBlocked` 映射 `TARGET_STILL_BLOCKED`；Renderer 只把最后一项显示成“接收位置仍不可用，请重新验证后再重试”，不显示内部异常。

- [ ] **Step 5: 按唯一顺序组装 server**

`HandlerContext` 保留现有 `config/db/manager/emit_event/paths/last_migration` 字段，只追加必需的 `delivery_service: TelegramDeliveryService`；不能用 Telegram 专用 context 替换旧依赖。`src/sidecar/server.py` 自己显式导入 `asyncio`、`os`、`threading`、`time`、`datetime/timezone` 与 `uuid4`，并在该模块定义 `_utc_now()` / `_new_id()`；不得依赖 CLI 模块中的同名 helper。生产入口必须分成不触碰数据库的同步 early hello、同一 event loop 内的 peer handshake/control dispatcher，以及唯一 daemon bootstrap initializer。exact order 为：配置 stdio/解析 argv/只做无 I/O 的路径选择 → 写并 flush 唯一 early `hello` → 创建唯一 `ProtocolLinePump`并在既有deadline内验证唯一peer hello → 立即启动消费同一pump的startup control dispatcher → 才在daemon bootstrap thread运行migration、config/SQLite、stores/service/manager、restore、gated emitter/subscription和完整delivery lease recovery → 在dispatcher持续服务ping/shutdown时做有预算output recovery → 原子把同一dispatcher提升为完整业务dispatch。任何migration、数据库打开、restore或recovery都不得位于peer hello之前，也不得同步占用event loop；从peer hello到退出只能有一个reader thread、一个`stdin.readline()` owner与一个protocol dispatcher。最小入口接口固定为：

```python
def main(argv: Sequence[str] | None = None) -> int:
    _configure_stdio()
    paths = select_paths_without_database_io(argv)
    _write_early_hello_and_flush(sys.stdout)
    return asyncio.run(_run_after_early_hello(paths, sys.stdin, sys.stdout))

async def _run_after_early_hello(paths: AppPaths, stdin: TextIO, stdout: TextIO) -> int:
    loop = asyncio.get_running_loop()
    pump = create_stdin_line_pump(stdin, loop)
    initializer: StartupInitializationHandle | None = None
    try:
        if not await _consume_peer_hello_early(pump, stdout):
            return 1
        dispatcher = StartupProtocolDispatcher(pump, stdout)
        initializer = start_startup_initialization(
            lambda: SidecarServer.from_paths(paths, loop=loop),
            loop,
        )
        server = await dispatcher.await_initialized_or_shutdown(initializer)
        if server is None:
            return 0
        return await server.serve_after_initialization(
            stdout,
            line_pump=pump,
            dispatcher=dispatcher,
            batch_size=50,
            startup_budget_seconds=STARTUP_OUTPUT_RECOVERY_BUDGET_SECONDS,
        )
    finally:
        if initializer is not None:
            initializer.cancel_acceptance()
        pump.stop_accepting()
```

接口同时固定为：

```python
class StartupInitializationHandle(Protocol):
    async def result(self) -> "SidecarServer": ...
    def cancel_acceptance(self) -> None: ...


def start_startup_initialization(
    build: Callable[[], "SidecarServer"],
    loop: asyncio.AbstractEventLoop,
) -> StartupInitializationHandle: ...
```

`StartupProtocolDispatcher` 始终只保留一个 pending `pump.readline()` task；startup gate关闭时只处理 `app.ping/app.shutdown`，其他合法业务请求返回 `STARTUP_RECOVERY_IN_PROGRESS`，把`sidecar.health`当request仍返回`METHOD_NOT_FOUND`。它用`asyncio.wait(FIRST_COMPLETED)`竞争该唯一read task与`initializer.result()`；初始化完成时保留未完成read task并由`serve_after_initialization`原子提升同一dispatcher，绝不取消后另建reader/request loop。`app.shutdown`必须先写并flush correlated成功response，再设置shutdown generation、调用`cancel_acceptance()`、关闭已注册的recovery probe pool、停止pump并取消/await asyncio startup/timer tasks；即使bootstrap或probe永久挂起也须2秒内返回0。初始化异常安全记录后零`app.ready`、关闭同一pump并非零退出。

`SidecarServer.from_paths` 的握手后真实装配固定为：

```python
@classmethod
def from_paths(cls, paths: AppPaths, *, loop: asyncio.AbstractEventLoop) -> "SidecarServer":
    paths.ensure()
    migration_result = run_migration(paths)
    HistoryDB._instance = None
    config = JsonConfig(str(paths.config_path))
    db = HistoryDB(db_path=str(paths.history_db_path))
    queue_store = QueueStore(str(paths.history_db_path))
    delivery_store = TelegramDeliveryStore(db)
    recovery_probe_pool = RecoveryFileProbePool(
        probe_readable_file,
        loop,
        max_workers=2,
        max_pending=2,
    )
    delivery_service = TelegramDeliveryService(
        config=config,
        store=delivery_store,
        now=_utc_now,
        new_id=_new_id,
        probe_readable_file=probe_readable_file,
        probe_readable_file_async=recovery_probe_pool.probe,
        sleep=asyncio.sleep,
    )
    manager = DownloadManager(
        config=config,
        db=db,
        queue_store=queue_store,
        temp_dir=str(paths.temp_dir),
        output_ready_sink=delivery_service,
        output_owner_id=_new_id(),
    )
    manager.restore_tasks()
    ctx = HandlerContext(
        config=config,
        db=db,
        manager=manager,
        emit_event=lambda _name, _payload: None,
        paths=paths,
        last_migration=migration_result,
        delivery_service=delivery_service,
    )
    server = cls(
        ctx,
        paths,
        startup_scheduler_gate=threading.Event(),
        recovery_probe_pool=recovery_probe_pool,
    )
    ctx.emit_event = server._emit_business_event
    delivery_service.set_event_emitter(server._emit_business_event)
    server._unsubscribe = manager.events.subscribe(server._on_manager_event)
    delivery_service.recover_delivery_leases()
    return server
```

`from_paths()` 是只在 `DaemonStartupInitializer` 的唯一 daemon thread里运行的同步 factory；它必须返回 `SidecarServer`，绝不 await、进入serve、启动manager/timer或写业务stdout。initializer不得使用默认executor；`paths.ensure`、migration、config/SQLite/stores、`manager.restore_tasks()`、gated emitter/subscription安装与无文件stat的完整`recover_delivery_leases()`都在该thread顺序完成。`QueueStore`与`TelegramDeliveryStore`共享同一SQLite文件但职责独立，禁止互相替代；store按方法使用短SQLite connection，不得把thread-affine open connection带到event-loop线程。任何`asyncio.Lock/Event/Task/Queue`和dispatcher promotion都必须在`result()`被event loop接受后于loop thread内创建/激活，factory不得跨线程携带loop-affine primitive；factory内唯一允许的startup event gate是thread-safe同步latch，gate关闭时直接drop且绝不触碰stdout，接受server后才接入loop writer。`StartupInitializationHandle.result()`只通过`loop.call_soon_threadsafe`完成；`cancel_acceptance()`后任何迟到成功/异常都不得安装server、写stdout、启动manager/timer或变更startup generation，若迟到返回server则只调用幂等`close_unaccepted()`关闭subscription/probe pool。bootstrap thread必须`daemon=True`且shutdown永不join。

初始化完成后同一dispatcher保持control-only，event loop创建`_finish_startup()`；它调用`finish_startup_output_recovery(batch_size=50,budget_seconds=2.0)`，startup阶段固定`limit=1`并返回continuation或None。其间`app.ping/app.shutdown`仍由同一pending read task响应；Telegram claim、worker wake与manager scheduler均未启动。只有timeout属于正常预算耗尽，其他异常导致零`app.ready`和非零退出。

`DownloadManager.start` 的精确签名扩为 `start(*, scheduler_gate: threading.Event | None = None) -> None`。`None`保持现有CLI立即调度语义；非空时scheduler thread可创建，但第一次dequeue/spawn前必须可中断等待gate，绝不能busy-loop。`SidecarServer.__init__`的精确新增keyword-only参数为`startup_scheduler_gate: threading.Event`与`recovery_probe_pool: RecoveryFileProbePool`并保存只读引用；production由fresh、初始关闭Event和上面pool注入。启动顺序固定为：完整delivery lease recovery（initializer内）→最多2秒output recovery slice→`manager.start(scheduler_gate=startup_scheduler_gate)`→`start_output_recovery_timer(continuation)`→event loop取得唯一stdout/protocol writer lock→在不await/yield的同一turn内把同一dispatcher提升为完整业务request dispatch并同步write+flush `app.ready{startupLeaseRecoveryComplete:true,outputRecoveryPending:continuation is not None}`→flush成功后设置business-event gate=true→释放writer lock→`startup_scheduler_gate.set()`。任何correlated response与protocol error也必须走该writer lock；dispatcher promotion后到ready flush前没有可运行其他request task的让出点，因此不会出现ready前业务response或ready后startup拒绝。若manager.start后但ready flush前失败/shutdown，必须把dispatcher退回closed/stopping、保持event gate关闭，finally再set scheduler gate让线程走停止分支并有界join；不得留下等待gate线程。`_emit_business_event`先取得同一stdout writer lock再检查event gate：关闭时直接丢弃，打开时才写；`_on_manager_event`唯一输出也调用它。hello与app.ready同样走专用writer。任何成功业务response/event都严格晚于app.ready；启动期丢弃状态只由权威snapshot水合，不replay。

禁止旧式同步peer-hello consumer直接读取`sys.stdin`、第二个reader、`asyncio.to_thread(stdin.readline)`或默认executor读取协议stdin。生产只在`_run_after_early_hello`创建一个进程级daemon reader thread；它是唯一调用`stdin.readline()`的位置，每行以`loop.call_soon_threadsafe(queue.put_nowait,line)`交给`asyncio.Queue[str]`。接口精确为`ProtocolLinePump.readline()->Awaitable[str]`与同步幂等`stop_accepting()->None`；`_consume_peer_hello_early`和`StartupProtocolDispatcher`复用同一实例，后者不接受factory或stdin。stop后禁止新callback，阻塞read迟到返回时直接退出并吞掉loop已关闭的`RuntimeError`。thread必须daemon且不join/await。server finally固定为：把request dispatcher切到closed/stopping并关闭business-event gate→`recovery_probe_pool.close_accepting()`→`pump.stop_accepting()`→cancel/await dispatcher/startup/timer asyncio tasks→unsubscribe恰好一次；外层finally只幂等cancel initializer/stop同一pump。startup失败必须零app.ready、非零退出；app.shutdown必须先flush correlated response再执行相同清理并在2秒内返回0，即使Electron保持stdin writer、bootstrap或probe永久阻塞也不受阻挡。

启动恢复期间`_emit_business_event`对逐record delivery/manager事件直接丢弃且不累计，SQLite是唯一权威状态。Renderer Task 11 coordinator先订阅delivery/status，再在app.ready后请求权威snapshot；水合期间实时事件进入有界merge/refetch。复用`SidecarServer._unsubscribe`：构造时幂等空函数，真实订阅后覆盖；shutdown恰好调用一次并恢复为空。30秒timer只串行推进持有的`OutputRecoveryContinuation`，重入只合并一个pending tick，continuation清空后下一tick才可`open_output_recovery_scan()`；绝不能调用`recover_delivery_leases()`。

production-order集成测试分别阻塞migration、DB open、restore与delivery lease recovery，证明early/peer hello已完成、同一control dispatcher仍响应ping且shutdown 2秒内退出；cancel后迟到initializer不得被接受、写stdout或启动manager/timer，从peer hello到退出始终一个daemon stdin reader、一个`stdin.readline()` owner与一个dispatcher。每个同步bootstrap步骤前后检查generation，取消后不开始下一步骤；真实subprocess退出会终止未join daemon thread。再用0/1/数千safe候选和fake monotonic clock覆盖1.999/2.000秒边界、`outputRecoveryPending` true/false、三phase/cursor无重无漏、continuation未清时零新scan、page提交但response取消后的旧cursor幂等重放，以及重启新scan不重复delivery。挂起两个真实probe worker时线程数仍最多2、默认executor零调用、ping可响应、startup在2秒预算后发ready、shutdown 2秒内退出、迟到success零DB/event mutation。分别从handler context、delivery service与manager注入启动期事件，断言app.ready前均无输出，gate后均输出且唯一ready在首个业务事件前；在ready flush前注入getConfig必须返回`STARTUP_RECOVERY_IN_PROGRESS`，client读到app.ready的同一tick立即发送getConfig/claim则必须由完整handler处理且该startup code调用数为0。ready后普通下载、历史与扩展桥立即可用，不等待后台数千项恢复。预置queued task的真实scheduler fake在ready flush前spawn=0、gate后恰好一次；ready writer抛错时request/event gate均关闭、scheduler仅释放供stop且无非daemon残留。factory test断言`from_paths(paths,loop=loop)`只在daemon initializer调用并返回server、delivery lease recovery恰好一次、peer hello/control/full dispatch复用同一pump/pending read、`serve_after_initialization()`只await一次。父进程保持stdin writer时令initializer或startup非timeout异常，真实subprocess须2秒内非零退出；成功/失败/shutdown三路的dispatcher/startup/timer/subscription/pool都只清一次。另用真实临时DB验证两个store独立同路径、paused恢复且delivery不破坏下载队列。

- [ ] **Step 6: 验证秘密和下载状态隔离**

端到端测试发送含 `botToken` 的 configure，断言 structured error 且数据库/配置/所有 stdout 与 stderr 不含测试 token。再模拟 markFailed，断言对应下载历史仍为 `completed`。

- [ ] **Step 7: 跑 Sidecar 与 Python 全量回归**

```powershell
pytest tests/sidecar/test_protocol.py tests/sidecar/test_handlers.py tests/sidecar/test_server.py tests/sidecar/test_e2e_subprocess.py -q
pytest tests/core tests/data tests/sidecar tests/cli -q
```

Expected: PASS。

- [ ] **Step 8: Commit**

```powershell
git add src/core/download_manager.py src/sidecar/protocol.py src/sidecar/handlers.py src/sidecar/server.py tests/core/test_download_manager.py tests/sidecar/test_protocol.py tests/sidecar/test_handlers.py tests/sidecar/test_server.py tests/sidecar/test_e2e_subprocess.py
git commit -m "feat(protocol): expose telegram delivery queue operations"
```

---

## Phase 2 — Electron 安全边界与本地服务

### Task 5: 先封死 Renderer 的通用 Sidecar 权限

**Files:**
- Modify: `desktop/electron/protocol.ts`
- Modify: `desktop/electron/preload.ts`
- Modify: `desktop/electron/main.ts`
- Modify: `desktop/renderer/lib/api.ts`
- Modify: `desktop/renderer/vite-env.d.ts`
- Modify: `desktop/electron/protocol.test.ts`

- [ ] **Step 1: 写越权失败测试**

测试 `RendererMethods` 覆盖所有现有 Renderer 调用，同时明确排除：

```ts
expect(isRendererMethod("app.getSnapshot")).toBe(true);
expect(isRendererMethod("app.exportDiagnostics")).toBe(true);
expect(isRendererMethod("updater.checkHealth")).toBe(true);
expect(isRendererMethod("app.shutdown")).toBe(false);
expect(isRendererMethod("telegramDelivery.claimNext")).toBe(false);
expect(isRendererMethod("telegramDelivery.markSent")).toBe(false);
expect(isRendererMethod("__proto__")).toBe(false);
```

再 mock `ipcMain.handle("sidecar:request")`，断言未知方法和所有 `telegramDelivery.*` 在调用 SidecarProcess 前被拒绝。

- [ ] **Step 2: 确认失败**

```powershell
npm.cmd --prefix desktop test -- protocol.test.ts
```

Expected: FAIL，当前 Main 原样转发任意字符串。

- [ ] **Step 3: 建立两层方法集合**

在 `desktop/electron/protocol.ts` 中：

```ts
export const RendererMethods = [
  "app.getSnapshot",
  "app.runMigration",
  "app.exportDiagnostics",
  "download.parseUrls",
  "download.cancelParse",
  "download.createTasks",
  "download.pause",
  "download.pauseAll",
  "download.resume",
  "download.resumeAll",
  "download.cancel",
  "download.retry",
  "download.remove",
  "download.removeGroup",
  "download.clearFinished",
  "download.updateTask",
  "download.reorder",
  "search.query",
  "history.list",
  "history.delete",
  "history.clear",
  "settings.get",
  "settings.update",
  "updater.checkYtDlp",
  "updater.checkHealth",
  "updater.updateYtDlp",
] as const;

export type RendererMethod = (typeof RendererMethods)[number];
const rendererMethodSet: ReadonlySet<string> = new Set(RendererMethods);
export const isRendererMethod = (value: unknown): value is RendererMethod =>
  typeof value === "string" && rendererMethodSet.has(value);
```

完整 `Methods` 继续与 Python 协议对齐并加入内部 Telegram 方法，但 `RendererMethods` 不含它们。

- [ ] **Step 4: 在 Main、preload 和 Renderer 三层收窄**

- Main 的 `sidecar:request` 先调用 `isRendererMethod`，失败抛固定产品错误，不把恶意 method 写进日志。
- preload 的 `request` 参数改为 `RendererMethod`。
- `renderer/lib/api.ts` 改为 `request<T>(method: RendererMethod, payload)`。
- 修正依赖运行时变量的 `batch` / task action，把参数 union 明确限定为其实际方法集合。
- `vite-env.d.ts` 引用 `DesktopApi`，不复制一份宽松签名。

- [ ] **Step 5: 跑 Electron 与 Renderer 回归**

```powershell
npm.cmd --prefix desktop test -- protocol.test.ts
npm.cmd --prefix desktop test
npm.cmd --prefix desktop run build
```

Expected: PASS，TypeScript 不再允许 Renderer 传任意 string。

- [ ] **Step 6: Commit**

```powershell
git add desktop/electron/protocol.ts desktop/electron/protocol.test.ts desktop/electron/preload.ts desktop/electron/main.ts desktop/renderer/lib/api.ts desktop/renderer/vite-env.d.ts
git commit -m "security(electron): restrict renderer sidecar methods"
```

---

### Task 6: 实现 Telegram 类型、脱敏、凭据保险箱和路径

**Files:**
- Create: `desktop/electron/telegram/types.ts`
- Create: `desktop/electron/telegram/ipcSchemas.ts`
- Create: `desktop/electron/telegram/ipcSchemas.test.ts`
- Create: `desktop/electron/telegram/redaction.ts`
- Create: `desktop/electron/telegram/redaction.test.ts`
- Create: `desktop/electron/telegram/credentialVault.ts`
- Create: `desktop/electron/telegram/credentialVault.test.ts`
- Create: `desktop/electron/telegram/paths.ts`
- Create: `desktop/electron/telegram/paths.test.ts`
- Create: `desktop/electron/telegram/appCredentials.ts`
- Create: `desktop/electron/telegram/appCredentials.test.ts`
- Create: `desktop/electron/telegram/childEnv.ts`
- Create: `desktop/electron/telegram/childEnv.test.ts`

- [ ] **Step 1: 写秘密泄漏和路径失败测试**

使用固定测试 token `123456:ABC_secret-value`、api ID `123456` 和 api hash `0123456789abcdef0123456789abcdef`，覆盖：原文、`/bot123456:ABC_secret-value/getMe`、URL 编码值、嵌套 Error cause、子进程 stderr。每个输出都断言三个值不回显：

```ts
expect(JSON.stringify(output)).not.toContain(testToken);
expect(JSON.stringify(output)).not.toContain(encodeURIComponent(testToken));
expect(JSON.stringify(output)).not.toContain(testApiHash);
```

CredentialVault 测试覆盖加密不可用、加密返回密文、原子替换、损坏 JSON、解密失败、删除幂等；path 测试覆盖合法 resources 与独立 data root、macOS 无后缀、Windows `.exe`、环境覆盖、空覆盖、工作目录 containment、含空格/中文路径、包内资源与六个 private path 各自的 containment、任一祖先 symlink/junction/reparse point、错误 POSIX mode、仍有继承或额外 Allow ACE 的 Windows ACL，并用 spy 证明 chmod/icacls 从不接收 resources 或开发覆盖 executable。Windows fixture 注入当前用户 SID，不依赖 runner 的本地化账户名。`ipcSchemas.test.ts` 对成功/失败 discriminant、每种稳定 code/messageKey、未知字段、raw error/stack/filePath/token 注入做参数化测试。`childEnv.test.ts` 把大小写混合的 Bot Token、测试 Token、GitHub Token、API ID/hash 与无关 secret 放入 base env，逐字段检查两个 fake spawn 将收到的完整环境。

- [ ] **Step 2: 确认失败**

```powershell
npm.cmd --prefix desktop test -- ipcSchemas.test.ts redaction.test.ts credentialVault.test.ts paths.test.ts appCredentials.test.ts childEnv.test.ts
```

Expected: FAIL，新模块尚不存在。

- [ ] **Step 3: 固定共享类型和 schema**

在 `types.ts` 定义：

```ts
export type TelegramConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reauth_required";
export type TelegramLocalServiceState = "stopped" | "starting" | "ready" | "restarting" | "failed";

export type TelegramChatType = "private" | "group" | "supergroup" | "channel";
export type TelegramDeliveryStatus =
  | "pending" | "preparing" | "sending" | "retry_wait"
  | "sent" | "failed" | "uncertain" | "cancelled" | "skipped_oversize";
export type TelegramMediaKind = "video" | "audio" | "document" | "oversize_notice";
export type TelegramDeliveryErrorCode =
  | ""
  | "POSTPROCESS_INTERRUPTED" | "FILE_MISSING" | "FILE_UNREADABLE" | "FILE_CHANGED"
  | "AUTH_INVALID" | "TARGET_PERMISSION_DENIED" | "TARGET_NOT_FOUND"
  | "MEDIA_INVALID" | "RATE_LIMITED" | "SERVER_ERROR"
  | "NETWORK_NOT_SUBMITTED" | "NETWORK_RESULT_UNKNOWN"
  | "INVALID_RESPONSE" | "LOCAL_SERVICE_EXITED"
  | "APP_RESTART_RESULT_UNKNOWN" | "SHUTDOWN_RESULT_UNKNOWN";
export type TelegramDeliveryFailureCode = Exclude<TelegramDeliveryErrorCode, "">;
export type TelegramIpcErrorCode =
  | "INVALID_PARAMS" | "NOT_FOUND" | "STATE_CONFLICT"
  | "TARGET_STILL_BLOCKED" | "ACTIVE_DELIVERY_RECOVERY_PENDING"
  | "AUTH_INVALID" | "LOCAL_SERVICE_UNAVAILABLE"
  | "LOCAL_PROCESS_RECOVERY_REQUIRED" | "OPERATION_FAILED";
export type TelegramIpcErrorMessageKey =
  | "telegram.error.invalidParams" | "telegram.error.notFound"
  | "telegram.error.stateConflict" | "telegram.error.targetStillBlocked"
  | "telegram.error.activeDeliveryRecoveryPending"
  | "telegram.error.authInvalid" | "telegram.error.localServiceUnavailable"
  | "telegram.error.localProcessRecoveryRequired"
  | "telegram.error.operationFailed";
export interface TelegramIpcErrorDTO {
  code: TelegramIpcErrorCode;
  messageKey: TelegramIpcErrorMessageKey;
}
export type TelegramIpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: TelegramIpcErrorDTO };
export type TelegramDeliveryMessageKey =
  | "telegram.delivery.waiting" | "telegram.delivery.sending"
  | "telegram.delivery.retrying" | "telegram.delivery.sent"
  | "telegram.delivery.oversize" | "telegram.delivery.failed"
  | "telegram.delivery.uncertain" | "telegram.delivery.cancelled"
  | "telegram.delivery.postprocessInterrupted" | "telegram.delivery.fileMissing"
  | "telegram.delivery.fileUnreadable" | "telegram.delivery.fileChanged"
  | "telegram.delivery.permissionDenied"
  | "telegram.delivery.authRequired";

export interface TelegramTarget {
  id: string;
  type: TelegramChatType;
  title: string;
  discoveredAt: string;
}

export interface TelegramDeliverySummary {
  id: string;
  taskId: string;
  status: TelegramDeliveryStatus;
  title: string;
  targetTitle: string;
  attemptCount: number;
  updatedAt: string;
  messageKey: TelegramDeliveryMessageKey;
  errorCode: TelegramDeliveryErrorCode;
  retryConfirmation: "none" | "possible_duplicate" | "interrupted_output";
}

export interface TelegramBotSummary {
  id: string;
  username: string;
}

export type TelegramRecoveryAction =
  | null
  | "restart_app"
  | "retry_replace_account"
  | "retry_disconnect";

export interface TelegramStatus {
  connection: TelegramConnectionState;
  serviceState: TelegramLocalServiceState;
  bot: TelegramBotSummary | null;
  target: TelegramTarget | null;
  targetVerifiedAt: string | null;
  autoSendEnabled: boolean;
  autoSendStateKnown: boolean;
  enabledAt: string | null;
  canEnableAutoSend: boolean;
  migrationRetryAt: string | null;
  recoveryAction: TelegramRecoveryAction;
  warningCode: "" | "MIGRATION_RECOVERY_REQUIRED" | "MIGRATION_WAIT" | "LOCAL_LOGOUT_FAILED" | "TARGET_INVALID" | "ACTIVE_DELIVERY_RECOVERY_PENDING" | "LOCAL_SERVICE_UNAVAILABLE" | "LOCAL_PROCESS_RECOVERY_REQUIRED";
}

export interface TelegramBindInput {
  token: string;
  dedicatedBotConfirmed: boolean;
  replaceAccountConfirmed?: boolean;
  restartMigrationConfirmed?: boolean;
}

export interface TelegramBindResult {
  status: TelegramStatus;
  requiresAccountReplacement: boolean;
  replacementBot: TelegramBotSummary | null;
  canRestartMigration: boolean;
}

export interface TelegramDeliveryQuery {
  offset: number;
  limit: number;
  status?: TelegramDeliveryStatus;
}

export interface TelegramDeliveryPage {
  items: TelegramDeliverySummary[];
  total: number;
  offset: number;
  limit: number;
}

export interface TelegramTargetBlock {
  accountId: string;
  targetChatId: string;
  errorCode: "TARGET_PERMISSION_DENIED" | "TARGET_NOT_FOUND";
  blockedAt: string;
}

export interface TelegramDeliveryEvent {
  summary: TelegramDeliverySummary;
}

export interface TelegramStatusEvent {
  status: TelegramStatus;
}

export interface TelegramDeliveryRecoveryHold {
  accountId: string;
  intent: "replace_account" | "disconnect";
  createdAt: string;
}

export interface TelegramSidecarConfigPatch {
  accountId?: string | null;
  accountUsername?: string | null;
  target?: TelegramTarget | null;
  targetVerifiedAt?: string | null;
  autoSendEnabled?: boolean;
  discoveredTargets?: TelegramTarget[];
  nextUpdateOffset?: string | null;
  migrationState?: "idle" | "logout_started" | "cloud_logged_out";
  migrationAccountId?: string | null;
  migrationStartedAt?: string | null;
  deliveryRecoveryHold?: TelegramDeliveryRecoveryHold | null;
}

export interface TelegramSidecarConfig {
  accountId: string | null;
  accountUsername: string | null;
  target: TelegramTarget | null;
  targetVerifiedAt: string | null;
  autoSendEnabled: boolean;
  enabledAt: string | null;
  discoveredTargets: TelegramTarget[];
  nextUpdateOffset: string | null;
  migrationState: "idle" | "logout_started" | "cloud_logged_out";
  migrationAccountId: string | null;
  migrationStartedAt: string | null;
  deliveryRecoveryHold: TelegramDeliveryRecoveryHold | null;
}

export interface TelegramClaimedDelivery {
  id: string;
  taskId: string;
  accountId: string;
  targetChatId: string;
  targetChatType: TelegramChatType;
  targetChatTitle: string;
  sourceUrl: string;
  title: string;
  filePath: string;
  fileSize: number;
  fileMtimeNs: string;
  mediaKind: TelegramMediaKind;
  attemptCount: number;
  retrySequenceCount: number;
  fallbackUsed: boolean;
}

export interface TelegramClaim {
  delivery: TelegramClaimedDelivery;
  leaseId: string;
}

export interface TelegramLeaseInput {
  deliveryId: string;
  leaseId: string;
}

export interface TelegramReleaseClaimInput extends TelegramLeaseInput {
  releasedAt: string;
}

export interface TelegramMarkSendingInput extends TelegramLeaseInput {
  requestStartedAt: string;
  mediaKind: TelegramMediaKind;
  fallbackUsed: boolean;
  chargeAttempt: boolean;
}

export interface TelegramMarkSentInput extends TelegramLeaseInput {
  messageId: string;
  sentAt: string;
}

export interface TelegramMarkRetryInput extends TelegramLeaseInput {
  errorCode: TelegramDeliveryFailureCode;
  errorMessage: string;
  nextAttemptAt: string;
}

export interface TelegramMarkRetryNotSubmittedInput extends TelegramLeaseInput {
  errorCode: "NETWORK_NOT_SUBMITTED" | "LOCAL_SERVICE_EXITED";
  errorMessage: string;
  nextAttemptAt: string;
}

export interface TelegramMarkFailedInput extends TelegramLeaseInput {
  errorCode: TelegramDeliveryFailureCode;
  errorMessage: string;
  failedAt: string;
}

export interface TelegramMarkUncertainInput extends TelegramLeaseInput {
  errorCode: TelegramDeliveryFailureCode;
  errorMessage: string;
  failedAt: string;
}

export interface TelegramMarkTargetFailedInput extends TelegramLeaseInput {
  accountId: string;
  targetChatId: string;
  errorCode: "TARGET_PERMISSION_DENIED" | "TARGET_NOT_FOUND";
  errorMessage: string;
  failedAt: string;
}

export interface TelegramClearTargetBlockInput {
  accountId: string;
  targetChatId: string;
}

export interface TelegramMarkSkippedOversizeInput extends TelegramLeaseInput {
  messageId: string;
  sentAt: string;
}

export interface TelegramRetryInput {
  deliveryId: string;
  confirmPossibleDuplicate: boolean;
  confirmInterruptedOutput: boolean;
}

export interface TelegramWorkerStopResult {
  state: "settled" | "recovery_pending";
  deliveryId: string | null;
}
```

`TelegramSidecarGateway` 对 patch/full config 的 Zod schema 必须把 `deliveryRecoveryHold` 定义成 `.strict()` nested object：`accountId` 使用 unsigned decimal-string schema，`intent` 为精确 enum，`createdAt` 为有效 UTC ISO timestamp；null 只表示没有 destructive recovery。任何额外属性、空账号、未知 intent、非UTC时间或把 hold 传进 Renderer settings 都失败。

`ipcSchemas.ts` 必须导出以下稳定名称；所有 object 使用 `.strict()`，返回 schema 也必须在 Main 发送前和 preload 接收后各解析一次：

```ts
export const telegramUnsignedIdStringSchema =
  z.string().regex(/^(?:0|[1-9][0-9]*)$/);
export const telegramChatIdStringSchema =
  z.string().regex(/^(?:0|[1-9][0-9]*|-[1-9][0-9]*)$/);
export const telegramNoInputSchema: z.ZodType<undefined>;
export const telegramStatusSchema: z.ZodType<TelegramStatus>;
export const telegramBindInputSchema: z.ZodType<TelegramBindInput>;
export const telegramBindResultSchema: z.ZodType<TelegramBindResult>;
export const telegramTargetSchema: z.ZodType<TelegramTarget>;
export const telegramTargetListSchema: z.ZodType<TelegramTarget[]>;
export const telegramSendTestInputSchema: z.ZodType<{ targetId: string }> = z.object({
  targetId: telegramChatIdStringSchema,
}).strict();
export const telegramSetAutoSendInputSchema: z.ZodType<{ enabled: boolean }>;
export const telegramOkSchema: z.ZodType<{ ok: true }>;
export const telegramDeliveryQuerySchema: z.ZodType<TelegramDeliveryQuery>;
export const telegramDeliverySummarySchema: z.ZodType<TelegramDeliverySummary>;
export const telegramDeliveryPageSchema: z.ZodType<TelegramDeliveryPage>;
export const telegramRetryInputSchema: z.ZodType<TelegramRetryInput>;
export const telegramDeliveryEventSchema: z.ZodType<TelegramDeliveryEvent>;
export const telegramStatusEventSchema: z.ZodType<TelegramStatusEvent>;
export const telegramIpcErrorSchema: z.ZodType<TelegramIpcErrorDTO>;
export const telegramStatusResultSchema: z.ZodType<TelegramIpcResult<TelegramStatus>>;
export const telegramBindResultEnvelopeSchema: z.ZodType<TelegramIpcResult<TelegramBindResult>>;
export const telegramTargetListResultSchema: z.ZodType<TelegramIpcResult<TelegramTarget[]>>;
export const telegramOkResultSchema: z.ZodType<TelegramIpcResult<{ ok: true }>>;
export const telegramDeliveryPageResultSchema: z.ZodType<TelegramIpcResult<TelegramDeliveryPage>>;
export const telegramDeliverySummaryResultSchema: z.ZodType<TelegramIpcResult<TelegramDeliverySummary>>;
```

只有 `telegramBindInputSchema` 含 `token` 字段，其余 schema 搜索不到 `token` 属性；`TelegramTarget.id`、`telegramSendTestInputSchema.targetId`及所有`targetChatId`字段必须使用signed `telegramChatIdStringSchema`，account/Bot/message/update offset必须使用unsigned schema，任一层都不得先转JS number。测试覆盖私聊正ID、`-100123`及超`MAX_SAFE_INTEGER`的负群/超级群/频道ID，并拒绝`-0`、负update ID、小数、指数和前导零；同一组 fixture 必须完整通过 preload `sendTest` → IPC schema → Controller，证明负群/频道 ID 可以验证并启用自动发送。`telegramRetryInputSchema` 精确对应 `deliveryId`、`confirmPossibleDuplicate`、`confirmInterruptedOutput`，不得另造 IPC-only retry DTO。每个 result schema 都是 `.strict()` 的 `ok` discriminated union；失败分支精确只有 `code/messageKey`，不得带 `message`、raw Telegram description、stack、cause 或 details。Python `_to_summary`、TypeScript union、Zod 与 i18n 必须共同接受 `APP_RESTART_RESULT_UNKNOWN`：它只配合 `uncertain`，映射 `retryConfirmation="possible_duplicate"` 与 uncertain 产品文案。测试把 startup `sending → uncertain` fixture 依次送过 event、snapshot、list 和 Renderer schema，删掉该 code或加入未知 code均失败。

- [ ] **Step 4: 实现统一脱敏**

```ts
export interface TelegramSecretsForRedaction {
  botToken?: string;
  apiId?: string;
  apiHash?: string;
}

export function redactTelegramSecrets(value: unknown, secrets?: TelegramSecretsForRedaction): string;
export function sanitizeTelegramError(error: unknown, secrets?: TelegramSecretsForRedaction): Error;
```

实现必须先将 unknown 安全转换为有限长度字符串，再替换显式 bot token/api ID/api hash、`bot[0-9]+:[A-Za-z0-9_-]+`、URL 中从 `/bot` 到下一个 `/` 的凭据段和 URL 编码 token；输出上限 4096 字符，不能回传原始 Error object。api ID 仅在完整值边界匹配时替换，避免把普通数字片段误删。

- [ ] **Step 5: 实现 safeStorage 密文保险箱**

```ts
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export class TelegramCredentialVault {
  constructor(
    filePath: string,
    safeStorage: SafeStorageLike,
    pathSecurity: TelegramPathSecurityDeps,
  );
  load(): Promise<string | null>;
  save(token: string): Promise<void>;
  clear(): Promise<void>;
  exists(): Promise<boolean>;
}
```

磁盘格式固定为 `{ "version": 1, "ciphertext": "base64" }`。Vault 保存注入的同一个 `TelegramPathSecurityDeps`；`load/exists/save/clear` 每次在第一次文件 I/O 前都调用 `ensurePrivateTelegramFile`（文件不存在时验证安全父目录并允许继续），绝不能只依赖 Main 启动时检查。`save` 再检查 `isEncryptionAvailable()`，写同目录随机临时文件，flush 后 rename，再次调用 `ensurePrivateTelegramFile` 验证文件保护；macOS 必须是 `0600`，Windows 必须是已禁继承且仅当前用户 SID 与 SYSTEM 拥有 Full Control 的 DACL，DPAPI 密文不能替代 ACL。任何失败都删除临时文件。不得实现明文 fallback，也不得把 token 放进异常 message。

- [ ] **Step 6: 实现路径与应用凭据读取**

`resolveTelegramBotApiPaths` 返回：

```ts
export interface TelegramRuntimePaths {
  executable: string;
  processHostExecutable: string;
  rootDir: string;
  workDir: string;
  tempDir: string;
  credentialFile: string;
  appCredentialsFile: string;
  ownerStateFile: string;
  sidecarOwnerStateFile: string;
}

export type TelegramPrivateDataPaths = Pick<
  TelegramRuntimePaths,
  "rootDir" | "workDir" | "tempDir" | "credentialFile" |
  "ownerStateFile" | "sidecarOwnerStateFile"
>;

export type SidecarRecoveryPrivatePaths = Pick<
  TelegramRuntimePaths,
  "rootDir" | "sidecarOwnerStateFile"
>;

export function selectTelegramPrivateDataPaths(
  paths: TelegramRuntimePaths,
): TelegramPrivateDataPaths {
  return {
    rootDir: paths.rootDir,
    workDir: paths.workDir,
    tempDir: paths.tempDir,
    credentialFile: paths.credentialFile,
    ownerStateFile: paths.ownerStateFile,
    sidecarOwnerStateFile: paths.sidecarOwnerStateFile,
  };
}

export function selectSidecarRecoveryPrivatePaths(
  paths: TelegramRuntimePaths,
): SidecarRecoveryPrivatePaths {
  return {
    rootDir: paths.rootDir,
    sidecarOwnerStateFile: paths.sidecarOwnerStateFile,
  };
}

export interface TelegramAppCredentials {
  apiId: string;
  apiHash: string;
}

export function resolveTelegramBotApiPaths(input: {
  platform: "darwin" | "win32";
  isPackaged: boolean;
  resourcesPath: string;
  downanyDataDir: string;
  env: NodeJS.ProcessEnv;
}): TelegramRuntimePaths;

export interface TelegramPathSecurityDeps {
  platform: "darwin" | "win32";
  currentUserSid: string | null;
  inspectPath(path: string): Promise<{
    exists: boolean;
    kind: "directory" | "file" | "other";
    isLinkOrReparsePoint: boolean;
    posixMode: number | null;
  }>;
  createDirectory(path: string, mode: 0o700): Promise<void>;
  chmod(path: string, mode: 0o700 | 0o600): Promise<void>;
  applyWindowsAcl(path: string, kind: "directory" | "file", currentUserSid: string): Promise<void>;
  inspectWindowsAcl(path: string): Promise<{
    inheritanceDisabled: boolean;
    allowSids: string[];
    fullControlSids: string[];
  }>;
}

export function ensurePrivateTelegramPaths(
  paths: TelegramPrivateDataPaths,
  deps: TelegramPathSecurityDeps,
): Promise<void>;

export function ensurePrivateSidecarRecoveryPaths(
  paths: SidecarRecoveryPrivatePaths,
  deps: TelegramPathSecurityDeps,
): Promise<void>;

export function ensureProcessHostResourceInput(input: {
  processHostExecutable: string;
  isPackaged: boolean;
  resourcesPath: string;
}, deps: TelegramPathSecurityDeps): Promise<void>;

export function ensureTelegramResourceInputs(input: {
  executable: string;
  appCredentialsFile: string;
  isPackaged: boolean;
  resourcesPath: string;
  envOverrideExecutable: string | null;
}, deps: TelegramPathSecurityDeps): Promise<void>;

export function ensurePrivateTelegramFile(
  filePath: string,
  privateRootDir: string,
  deps: TelegramPathSecurityDeps,
): Promise<void>;

export function loadTelegramAppCredentials(input: {
  isPackaged: boolean;
  appCredentialsFile: string;
  env: NodeJS.ProcessEnv;
}): Promise<TelegramAppCredentials>;

export function buildTelegramBotApiChildEnv(
  baseEnv: NodeJS.ProcessEnv,
  appCredentials: TelegramAppCredentials,
): NodeJS.ProcessEnv;

export function buildSidecarChildEnv(
  baseEnv: NodeJS.ProcessEnv,
  runtime: { dataDir: string; binDir: string; noProxy: string },
): NodeJS.ProcessEnv;
```

Bot API 可执行文件优先显式开发覆盖 `DOWNANY_TELEGRAM_BOT_API_BIN`，否则使用 `process.resourcesPath/telegram-bot-api/telegram-bot-api[.exe]`；受控宿主固定为 `process.resourcesPath/process-host/DownanyProcessHost[.exe]`，开发态也只能用仓库构建输出的明确绝对路径，不能环境覆盖成任意程序。Main 必须用现有 `resolveDownanyDataDir(process.env, process.platform, app.getPath("home"))` 的结果传 `downanyDataDir`，不能传 Electron roaming `userData`。私有运行路径固定为 `<downanyDataDir>/telegram/{bot-api,temp,bot-token.v1,owner-state.json,sidecar-owner-state.json}`，其中前两项是目录，后三项是文件。`selectTelegramPrivateDataPaths` 必须返回且只返回 `rootDir/workDir/tempDir/credentialFile/ownerStateFile/sidecarOwnerStateFile`；`selectSidecarRecoveryPrivatePaths` 必须返回且只返回 `rootDir/sidecarOwnerStateFile`，两个 selector 都创建新对象且不接受额外键。只有对应 private DTO 的成员 canonicalize 后必须仍在 `<downanyDataDir>/telegram` 内。包内只读 `executable/processHostExecutable/appCredentialsFile` 绝不能被错误要求位于 data root：打包态要求 regular file、非 link/reparse 且分别 containment 于对应 resources 子目录；开发 Bot API override 只接受显式绝对 regular non-link 文件，process host 必须命中仓库构建输出，app credentials 则只读环境变量。`ensureProcessHostResourceInput` 只验证共享受控宿主；`ensureTelegramResourceInputs` 只验证 Bot API 与 app credentials。三类 private/shared/Telegram-only 检查使用不同函数和测试 fixture，resource 路径绝不进入 chmod/icacls。

`ensurePrivateTelegramPaths` 从 data dir 到六个 private leaf 对每个已存在 component 做 `lstat` 并 fail-closed 拒绝 symlink/junction/reparse point；`ensurePrivateSidecarRecoveryPaths` 使用同一规则但只创建/验证 Sidecar 恢复必需的 root 与 sidecar owner-state，不读取 token、Bot workDir 或 Telegram owner-state。macOS 创建目录后强制并复核 `0700`，`ensurePrivateTelegramFile` 在每次原子 rename 后强制并复核 `0600`。Windows production adapter 先用固定参数、`shell:false` 的 `icacls.exe` 关闭继承并只授予当前用户 SID 与 `S-1-5-18` (SYSTEM) Full Control，再用固定 PowerShell `Get-Acl` 脚本读取 SID 形式 ACE；必须确认 inheritance disabled、无其他 Allow SID、两者均为 Full Control。Sidecar 恢复 subset 或共享 ProcessHost 失败会阻止核心 Sidecar；Telegram-only private/resource 失败只阻止 Telegram Supervisor/worker/vault，并进入 Task 10 的可见 degraded 状态，绝不得阻止普通下载主链路。CredentialVault 的临时文件与最终文件、Supervisor 的 owner state 都必须在写后调用 `ensurePrivateTelegramFile`，不能仅假设父目录安全；包内资源只做上面的只读文件/containment 检查，绝不 chmod 或改 DACL。路径测试逐字段断言两个 selector 的 exact keys，且 Telegram selector 不含 executable/processHost/appCredentials，Sidecar selector 不含 token/workDir/Telegram owner-state。

两个 child 环境必须由上面唯一 builder 构造，禁止在结果后再 spread `process.env` 或原始 launch env。两者先按大小写不敏感键名只复制 `PATH/HOME/USERPROFILE/SystemRoot/WINDIR/ComSpec/PATHEXT/TEMP/TMP/TMPDIR/LANG/LC_ALL/LC_CTYPE`、大小写两套 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY` 以及 `SSL_CERT_FILE/SSL_CERT_DIR/REQUESTS_CA_BUNDLE`。Bot API builder 再且只追加 `TELEGRAM_API_ID/TELEGRAM_API_HASH`；Sidecar builder 再且只追加 `DOWNANY_DATA_DIR/DOWNANY_BIN_DIR/NO_PROXY/PYTHONUNBUFFERED=1`。Sidecar 结果禁止任何大小写变体包含 `TELEGRAM`、`BOT_TOKEN`、`API_ID`、`API_HASH` 或以 `_TOKEN` 结尾；Bot API 结果除精确两个 API credential 键外执行同一禁止规则。两个函数不得修改传入对象。测试直接断言 Supervisor 与 Sidecar fake spawn 的完整 `options.env`：用户 Bot Token、`DOWNANY_TELEGRAM_TEST_TOKEN`、GitHub token 与无关 secret 全不存在；Bot API 只有两项 app credentials，Sidecar 两项也没有；系统/代理/runtime 必需键仍存在。

开发 app credentials 仅接受同时存在的 `DOWNANY_TELEGRAM_API_ID` / `DOWNANY_TELEGRAM_API_HASH`；打包态读取 `app-credentials.json` schema `{schemaVersion:1,apiId:string,apiHash:string}`。错误只说缺哪一个字段，不打印值。

- [ ] **Step 7: 跑测试与秘密静态搜索**

```powershell
npm.cmd --prefix desktop test -- ipcSchemas.test.ts redaction.test.ts credentialVault.test.ts paths.test.ts appCredentials.test.ts childEnv.test.ts
rg -n "telegram_bot_token|DOWNANY_TELEGRAM_API_HASH|apiHash" src desktop/renderer
```

Expected: 测试 PASS；搜索结果不包含 Sidecar、Renderer state 或日志中的秘密值处理，只允许 Electron Main credential/build credential 的键名。

- [ ] **Step 8: Commit**

```powershell
git add desktop/electron/telegram/types.ts desktop/electron/telegram/ipcSchemas.ts desktop/electron/telegram/ipcSchemas.test.ts desktop/electron/telegram/redaction.ts desktop/electron/telegram/redaction.test.ts desktop/electron/telegram/credentialVault.ts desktop/electron/telegram/credentialVault.test.ts desktop/electron/telegram/paths.ts desktop/electron/telegram/paths.test.ts desktop/electron/telegram/appCredentials.ts desktop/electron/telegram/appCredentials.test.ts desktop/electron/telegram/childEnv.ts desktop/electron/telegram/childEnv.test.ts
git commit -m "feat(electron): secure telegram credentials and paths"
```

---

### Task 7: 监督随机回环端口上的本地 Bot API 服务

**Files:**
- Modify: `desktop/electron/processTree.ts`
- Modify: `desktop/electron/processTree.test.ts`
- Create: `desktop/electron/telegram/supervisor.ts`
- Create: `desktop/electron/telegram/supervisor.test.ts`
- Create: `native/process-host/CMakeLists.txt`
- Create: `native/process-host/main.cpp`
- Create: `native/process-host/README.md`
- Create: `scripts/test_process_host.py`

- [ ] **Step 1: 写进程生命周期失败测试**

通过依赖注入 fake `spawn`、port allocator、TCP probe、clock 和 process-tree killer，断言：

- production 只经 `DownanyProcessHost` 的 argument array、`shell:false` 启动目标；宿主自身在 Windows 为 `detached:false,windowsHide:true`，在 macOS 为 `detached:true,windowsHide:true`。目标先 suspended、完成 owner-state 登记后才 resume。Supervisor 调用路径安全检查时收到的 adapter 与 Vault/Main preflight 是同一个对象。
- fake port allocator 返回 `43127` 时，参数精确包含 `--local`、`--http-ip-address=127.0.0.1`、`--http-port=43127`、`--dir=D:\Downany Data\Telegram`、`--temp-dir=D:\Downany Data\Telegram\temp`。
- `TELEGRAM_API_ID/HASH` 只在 Task 6 `buildTelegramBotApiChildEnv` 的目标/宿主共享最小 env，不在 args、日志或返回 DTO；用户 Bot Token 与测试 Token 不在任一 child env。
- launching/verified/quarantined owner state 序列化只含可重建 argv/command、endpoint 与进程身份；把 fake child env、API ID/hash 和 Bot Token 放进测试依赖后，落盘 JSON 必须逐项不含这些值及其编码形式。
- TCP probe 只连接 `127.0.0.1`。
- 意外退出最多重启 3 次，延迟为 1 秒、3 秒、10 秒；同一个 `start()` generation 始终复用首次分配的 `43127`，不能悄悄换 endpoint；端口被其他进程占用时进入 failed，留给用户明确重试。
- `stop()` 取消已安排的重启、等待当前探活结束，把同一个可演进 `ProcessTreeHandle` 交给原子 `terminateAndWaitProcessTree({graceful=3s,force=2s},persist)`；每次操作先刷新并持久化新发现的成员，只有 `result.exited=true` 才删除 owner state，否则保留 `result.snapshot`、进入 failed并 reject。
- Node `spawn()` 异步只发 `error` 而不发 `exit`、`error → exit`、`exit → error` 三种次序都必须让当前 generation 恰好 settle 一次；无 PID 的 spawn error 不留 owner state。有 PID 的 error 必须先取得/登记 verified snapshot，或写 fail-closed quarantine state；只有整树确认退出才可删除，不能因“error”本身丢掉下次恢复身份。
- 分配端口并形成完整 argv 后、调用任何 OS spawn 前，先原子写 owner state v5 `registration="launching"`：保存 target/process-host executable、两条规范化 command、endpoint、workDir、instanceId、`spawnWindowStartedAt`，而 `spawnWindowEndedAt/candidate/tree` 为 null；写入或 DACL 复核失败时 spawn count 必须为零。随后 `DownanyProcessHost` 创建目标但保持 suspended，fd3 handshake携带 guardian/target PID、两者 OS creation time、containment/PGID和同一 instanceId；Electron 先用 OS inspect逐字段核实两条 executable/command/creation identity，再把完整 `ContainedProcessCandidate` 原子写入 quarantined，随后调用 `captureContainedProcessTree(candidate,generationId)`、写 verified 最新 tree，最后才在 fd3 发唯一 resume。任何登记/inspect/capture/persist失败都不 resume，并让宿主收敛未运行目标。测试在 intent前、宿主创建目标后但candidate落盘前、quarantine后、verified后且resume前分别强杀Main；全新 adapter/空内存握手的下一次启动都不能出现第二棵树。

- [ ] **Step 2: 确认失败**

```powershell
npm.cmd --prefix desktop test -- supervisor.test.ts
```

Expected: FAIL，supervisor 尚不存在。

- [ ] **Step 3: 实现明确状态机**

```ts
export type SupervisorState = TelegramLocalServiceState;

export interface TelegramSupervisorStateChange {
  state: SupervisorState;
  endpoint: TelegramBotApiEndpoint | null;
  reason:
    | "start" | "unexpected_exit" | "restart_ready"
    | "restart_exhausted" | "intentional_stop"
    | "stale_process_recovery_required" | "process_tree_capture_failed";
  failureCode:
    | null
    | "LOCAL_SERVICE_UNAVAILABLE"
    | "LOCAL_PROCESS_RECOVERY_REQUIRED";
}

export interface TelegramBotApiEndpoint {
  host: "127.0.0.1";
  port: number;
  baseUrl: string;
}

export interface TelegramSpawnedProcess {
  candidate: ContainedProcessCandidate;
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  resume(): Promise<void>;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
  once(event: "error", listener: (error: Error) => void): void;
}

export interface TelegramOwnedProcessInfo {
  pid: number;
  parentPid: number | null;
  executablePath: string;
  startedAt: string;
  commandLine: string;
}

export interface ContainedProcessCandidate {
  instanceId: string;
  guardian: TelegramOwnedProcessInfo;
  root: TelegramOwnedProcessInfo;
  containment: "windows_job_object" | "darwin_process_group";
  processGroupId: number | null;
}

export interface ProcessHostHandshakeV2 {
  schemaVersion: 2;
  instanceId: string;
  guardianPid: number;
  guardianStartedAt: string;
  targetPid: number;
  targetStartedAt: string;
  containment: "windows_job_object" | "darwin_process_group";
  processGroupId: number | null;
}

export interface ProcessTreeMemberIdentity {
  pid: number;
  startedAt: string;
}

export interface ProcessTreeSnapshot {
  schemaVersion: 2;
  root: TelegramOwnedProcessInfo;
  guardian: TelegramOwnedProcessInfo;
  platform: NodeJS.Platform;
  containment: "windows_job_object" | "darwin_process_group";
  processGroupId: number | null;
  members: readonly ProcessTreeMemberIdentity[];
  generationId: string;
}

export interface ProcessTreeHandle {
  readonly platform: NodeJS.Platform;
  readonly generationId: string;
  snapshot(): ProcessTreeSnapshot;
}

export interface ProcessTreeOperationResult {
  exited: boolean;
  snapshot: ProcessTreeSnapshot;
}

export type PersistProcessTreeSnapshot = (
  snapshot: ProcessTreeSnapshot,
) => Promise<void>;

export type ProcessOwnerKind = "telegram-bot-api" | "sidecar";

export interface ProcessOwnerIdentity<K extends ProcessOwnerKind = ProcessOwnerKind> {
  version: 5;
  kind: K;
  executablePath: string;
  processHostExecutablePath: string;
  workDir: string;
  expectedArgv: readonly string[];
  expectedCommandLine: string;
  expectedGuardianCommandLine: string;
  endpoint: TelegramBotApiEndpoint | null;
  instanceId: string;
  spawnWindowStartedAt: string;
}

export type ProcessOwnerState<K extends ProcessOwnerKind = ProcessOwnerKind> =
  ProcessOwnerIdentity<K> & (
    | {
      registration: "launching";
      spawnWindowEndedAt: null;
      candidate: null;
      tree: null;
    }
    | {
      registration: "verified";
      pid: number;
      startedAt: string;
      spawnWindowEndedAt: string;
      tree: ProcessTreeSnapshot;
    }
    | {
      registration: "quarantined";
      pid: number;
      startedAt: string;
      spawnWindowEndedAt: string;
      candidate: ContainedProcessCandidate;
      tree: null;
    }
  );

export interface ProcessLaunchCandidateQuery {
  instanceId: string;
  processHostExecutablePath: string;
  targetExecutablePath: string;
  expectedGuardianCommandLine: string;
  expectedTargetCommandLine: string;
  spawnWindowStartedAt: string;
  spawnWindowEndedAt: string;
}

export interface ProcessOwnerStateStore<K extends ProcessOwnerKind> {
  load(): Promise<ProcessOwnerState<K> | null>;
  write(state: ProcessOwnerState<K>): Promise<void>;
  clear(): Promise<void>;
}

export interface ProcessTreeTerminationOptions {
  gracefulTimeoutMs: number;
  forceTimeoutMs: number;
}

export interface TelegramSupervisorDeps {
  paths: TelegramRuntimePaths;
  appCredentials: TelegramAppCredentials;
  baseEnv: NodeJS.ProcessEnv;
  spawnContainedProcess(
    executable: string,
    args: readonly string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      shell: false;
      detached: boolean;
      windowsHide: true;
    },
  ): Promise<TelegramSpawnedProcess>;
  allocatePort(host: "127.0.0.1"): Promise<number>;
  probeTcp(host: "127.0.0.1", port: number, signal: AbortSignal): Promise<boolean>;
  inspectProcess(pid: number): Promise<TelegramOwnedProcessInfo | null>;
  findOwnedProcessCandidates(query: ProcessLaunchCandidateQuery): Promise<readonly ContainedProcessCandidate[]>;
  captureContainedProcessTree(candidate: ContainedProcessCandidate, generationId: string): Promise<ProcessTreeHandle | null>;
  restoreProcessTree(snapshot: ProcessTreeSnapshot): ProcessTreeHandle;
  refreshProcessTree(
    handle: ProcessTreeHandle,
    persist: PersistProcessTreeSnapshot,
  ): Promise<ProcessTreeSnapshot>;
  waitForProcessTreeExit(
    handle: ProcessTreeHandle,
    timeoutMs: number,
    persist: PersistProcessTreeSnapshot,
  ): Promise<ProcessTreeOperationResult>;
  terminateAndWaitProcessTree(
    handle: ProcessTreeHandle,
    options: ProcessTreeTerminationOptions,
    persist: PersistProcessTreeSnapshot,
  ): Promise<ProcessTreeOperationResult>;
  ownerStore: ProcessOwnerStateStore<"telegram-bot-api">;
  pathSecurity: TelegramPathSecurityDeps;
  nowIso(): string;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  randomId(): string;
  log(level: "info" | "warn" | "error", safeMessage: string): void;
}

export class TelegramBotApiSupervisor {
  constructor(deps: TelegramSupervisorDeps);
  start(): Promise<TelegramBotApiEndpoint>;
  health(): Promise<boolean>;
  stop(): Promise<void>;
  getState(): SupervisorState;
  onStateChange(listener: (event: TelegramSupervisorStateChange) => void): () => void;
}

export function waitForProcessTreeExit(
  handle: ProcessTreeHandle,
  timeoutMs: number,
  persist: PersistProcessTreeSnapshot,
): Promise<ProcessTreeOperationResult>;
export function captureContainedProcessTree(
  candidate: ContainedProcessCandidate,
  generationId: string,
): Promise<ProcessTreeHandle | null>;
export function restoreProcessTree(
  snapshot: ProcessTreeSnapshot,
): ProcessTreeHandle;
export function refreshProcessTree(
  handle: ProcessTreeHandle,
  persist: PersistProcessTreeSnapshot,
): Promise<ProcessTreeSnapshot>;
export function terminateAndWaitProcessTree(
  handle: ProcessTreeHandle,
  options: ProcessTreeTerminationOptions,
  persist: PersistProcessTreeSnapshot,
): Promise<ProcessTreeOperationResult>;
```

`start()` 使用注入的同一个 `pathSecurity` 检查 Task 6 的 private/resource 两类路径，从 OS 分配一次可用端口，调用 `buildTelegramBotApiChildEnv`，并严格执行 `launching → quarantined → verified → resume → probe`。`spawnContainedProcess` 只启动包内 `DownanyProcessHost`，`instanceId` 是宿主自身的非秘密参数，目标 argv 在 `--` 后逐项传入且 `shell:false`，目标参数不得含 instanceId；fd3 control 与目标 stdin/stdout/stderr 完全隔离。宿主 handshake 严格使用 `ProcessHostHandshakeV2`，多余字段、第二条 handshake、PID 非正数或 creation time 非 UTC 都拒绝。Electron 分别 inspect guardian/root，逐字段验证 PID、startedAt、executable、command、instanceId 与 containment，并强制 `root.parentPid === guardian.pid` 后才能构造 candidate；`parentPid=null`、父 PID 不等或 PID reuse 都是 identity mismatch。quarantined 的 `pid/startedAt` 必须等于 `candidate.root.pid/startedAt`，candidate instanceId 必须等于 owner identity。验证完成前不得写 quarantined 或 resume。Electron 在 helper spawn 前就注册 `error/exit` listener，并用单一 generation terminal latch 保证第一个 terminal event 胜出；helper 只在所属 Job/process group 的全部成员退出后才发 exit，所以 root 先退、grandchild 仍活不能被误判为 generation 结束。`resume()` 只能在 verified owner state 原子落盘并回读后调用一次。并发 `start()` 复用同一个 Promise。在限定启动超时内轮询 TCP；stdout/stderr 逐行脱敏。自动 crash restart 必须先让旧 handle/guardian 收敛并得到 `result.exited=true`、原子清除旧 owner state，才可写下一 generation 的 launching intent；旧树仍活、persist/clear 失败或退出未确认时切 failed、禁止 restart，绝不覆盖单一 owner-state 文件。

`start()` 在分配新端口前调用恢复入口。verified state 即使 target root 已不存在也必须从 `tree` 恢复 handle，先检查仍匹配 creation identity 的 guardian、Windows Job 或 macOS process group，再收敛全组；只有 `terminateAndWaitProcessTree(...,persist).exited=true` 且 `ownerStore.clear()` 成功才可继续。quarantined state 必须从落盘的完整 guardian+root candidate 精确提升，不得从 PID 反推宿主；guardian/root 任一 creation identity、executable、command、instanceId、`root.parentPid === guardian.pid` 或 containment 不匹配时零 signal。launching state 先把 null end 填为 `min(now,started+固定5秒窗口)` 并调用 `findOwnedProcessCandidates`：窗口结束后零个 exact candidate 才能清 state；唯一成对 candidate 才写 quarantined、capture、提升 verified并收敛；多个、枚举失败、窗口未结束、PID reuse或任一字段不匹配都保留 state并 fail closed。`expectedArgv` 保留随机端口等重建信息，`workDir` 只做受控 containment元数据校验，不冒充 OS cwd。内部原因统一映射为 `LOCAL_PROCESS_RECOVERY_REQUIRED`；普通探活耗尽、端口占用或已确认旧树退出后的启动失败才是 `LOCAL_SERVICE_UNAVAILABLE`。测试覆盖 launching 零/一/多 candidate、窗口边界、enumerator fault、fresh adapter/空内存 handshake 的 quarantined round-trip、owner clear fault与跨重启幂等，并单独覆盖 `parentPid=null/错 guardian` 时零 signal、零 clear、零 spawn且该字段永不进入公开 IPC。

`native/process-host` 不依赖第三方库，控制协议固定在 fd3：宿主创建目标为 suspended，Windows 先创建带 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的 Job、Assign 后再报告 handshake；macOS 用 `POSIX_SPAWN_START_SUSPENDED` 创建新 process group。收到唯一 `{"command":"resume"}` 前目标不能执行用户代码。宿主打开 Electron parent 的可等待身份；parent 退出、fd3 关闭或 control schema 错误时立即终止 Job/整个 PGID并等待清空。正常目标 root 退出后，宿主仍等待 Job/PGID 无成员才退出；fd0/1/2 透明转发，fd3 永不转发给目标。`scripts/test_process_host.py` 在真实 Windows/macOS 上覆盖：resume 前目标零副作用、父进程强杀后 root+grandchild 消失、root 先退 grandchild 仍活时 guardian 不退、stdout JSONL/stderr 不混入 handshake、control 关闭收敛、路径含空格/中文及 2GB 无关长流不缓存。任何无法创建 Job/PGID、无法监视 parent 或无法 suspended assignment 的平台直接拒绝启动，不得降级为裸 spawn。

- [ ] **Step 4: 处理停止与崩溃竞态**

维护 generation ID；旧 child 的 exit/error 事件不能重启新 generation。每个 generation 只保存一个可演进 `ProcessTreeHandle`；`stop()` 并发调用复用同一 Promise，在仅构造但从未 start、已经 stopped 且无 owner state/handle 时幂等返回成功，若 start 正在进行则先锁定该 generation、阻止 resume/restart并收敛已经产生的 launching/quarantined/verified tree，绝不能因 endpoint 尚未 resolve 就当作“未启动”。有 handle 时先标记 stopping、增加 generation、取消 timer，再把该 handle 交给 `terminateAndWaitProcessTree({gracefulTimeoutMs:3000,forceTimeoutMs:2000},persist)`。`persist` 必须先原子覆盖 verified owner state 的 `tree`，成功后操作才可发 signal、返回或声称退出；失败则 fail closed。只有 `result.exited=true` 才清 owner state 并切 `stopped`；失败时保留 `result.snapshot`、切 `failed` 并抛 `LOCAL_SERVICE_STOP_FAILED`。非主动退出且尚有 restart budget 时也必须走同一旧树收敛 gate；只有 `result.exited=true` 才进入 `restarting`，否则保持 failed 且 spawn count 不增加。测试精确覆盖 never-started stop、start每个持久化边界与stop竞争、root unexpected exit、grandchild 仍活时自动 restart不发生，grandchild收敛并清state后才允许下一generation。

Supervisor `stop()` 自己持有从调用时刻起的绝对 6 秒 deadline：3 秒 graceful 与 2 秒 force 仍是终止树的最大等待，余下至少 1 秒专供 generation latch、最新 snapshot persist、owner clear 与 Promise settle；所有这些异步依赖都必须按剩余绝对时间有界，超时则在第 6 秒前保留最新 owner state、切 failed 并 reject，不能产生永不 settle 的后台 Promise。Main 的外层等待严格更长，固定 7 秒且始终 await 同一个 stop Promise；测试覆盖 4.999/5.000 秒树退出、owner clear 延迟到 5.999 秒、6.000 秒内部 fail-closed，以及 7.000 秒外层边界，证明外层不会抢在任何合同内完成/失败之前超时。

`ProcessTreeHandle` 内部持有 guardian、root、containment 与按 `(pid,startedAt)` 去重的可变成员集合，`snapshot()` 只返回不可变复制。macOS 每轮 wait 与返回 `exited=true` 前检查 guardian 与整个 PGID；Windows 以仍存活的 guardian/Job active-process count 为权威，BFS 成员只用于诊断和持久 identity，绝不能因 root 先退而声称 Job 已空。每轮发现新成员先并入 handle、`await persist(newSnapshot)`，成功后才允许发 signal或返回；persist 失败时 Job/guardian 仍持有，零 signal、零 clear。`terminateAndWaitProcessTree` 无论成功失败都返回最新 snapshot；第一次 `exited=false` 后，同一个 handle 保留完整 Job/PGID身份供第二次 force。production `captureContainedProcessTree(candidate,generationId)` 必须接收刚从 fd3 handshake 验证并原子落盘的完整 `ContainedProcessCandidate`；跨重启恢复只能使用 quarantined state 中持久化的同一 candidate，严禁依赖内存握手、仅传 target PID 或重新猜 guardian。SupervisorDeps、SidecarLifecycleDeps 与 export 逐字一致。集成测试除 soft/force/error 竞态外，必须真实覆盖目标创建 grandchild 后立即强杀 Electron、root 随后先退、helper 最终清空整个 Job/PGID，下一次启动前零旧成员；另覆盖 candidate round-trip、guardian/target 任一 identity 漂移、persist reject、PID reuse、第二次 force与无 guardian 不得降级 BFS。

owner state 文件固定为 `<downanyDataDir>/telegram/owner-state.json`，并复用 Task 6 的 containment、原子 rename、macOS `0600` 与 Windows DACL 复核。v5 三个 registration 均拒绝未知字段并保留 expected identity；verified 永远包含最新 schema v2 `tree`。health、自然 exit wait、graceful/force termination发现新成员后先 persist。round-trip 保持成员排序与去重；root 已退但 guardian/Job/PGID任一仍活时不得删 state；整组确认消失后才允许 clear。

- [ ] **Step 5: 跑定向测试**

```powershell
npm.cmd --prefix desktop test -- supervisor.test.ts
```

Expected: PASS，fake stderr 中的 token 不出现在捕获日志。

- [ ] **Step 6: Commit**

```powershell
git add desktop/electron/processTree.ts desktop/electron/processTree.test.ts desktop/electron/telegram/supervisor.ts desktop/electron/telegram/supervisor.test.ts native/process-host/CMakeLists.txt native/process-host/main.cpp native/process-host/README.md scripts/test_process_host.py
git commit -m "feat(electron): supervise local telegram bot api"
```

---

### Task 8: 封装云端迁移和本地发送 Client

**Files:**
- Create: `desktop/electron/telegram/client.ts`
- Create: `desktop/electron/telegram/client.test.ts`

- [ ] **Step 1: 写 URL、错误和本地路径失败测试**

fake fetch 记录请求但测试输出必须先做脱敏。覆盖 `getMe`、`deleteWebhook(drop_pending_updates=false)`、`logOut`、`getUpdates`、`sendMessage`、`sendVideo`、`sendAudio`、`sendDocument`。Windows 路径 `C:\下载 文件\片段 01.mp4` 和 macOS 路径 `/Users/test/下载 文件/片段 01.mp4` 必须转成合法 `file:` URL，不能读文件 Buffer。`getUpdates` fixture 必须含相邻的 `9007199254740992` / `9007199254740993`、乱序 updates、重复 object key，以及负数、小数、指数形式的 `update_id`；前两个必须保持两个不同十进制字符串，后三类非法形式整批拒绝。

错误测试覆盖：401、403、400 media invalid、400 chat not found、429 + `retry_after`、500、连接 reset、非法 JSON、200 + `ok:false`。

- [ ] **Step 2: 确认失败**

```powershell
npm.cmd --prefix desktop test -- client.test.ts
```

Expected: FAIL，client 尚不存在。

- [ ] **Step 3: 实现最小 typed client**

```ts
export type TelegramApiLocation =
  | { kind: "cloud"; baseUrl: "https://api.telegram.org" }
  | { kind: "local"; baseUrl: string };

export type TelegramAllowedUpdate = "message" | "channel_post" | "my_chat_member";

export interface TelegramFetchResponse {
  status: number;
  text(): Promise<string>;
}

export interface LosslessJsonNumberToken {
  readonly kind: "number-token";
  readonly raw: string;
}

export type LosslessTelegramJsonValue =
  | null | boolean | string | LosslessJsonNumberToken
  | LosslessTelegramJsonValue[]
  | { readonly [key: string]: LosslessTelegramJsonValue };

export function parseTelegramResponseLossless(text: string): LosslessTelegramJsonValue;

export type TelegramFetch = (
  url: string,
  init: RequestInit,
) => Promise<TelegramFetchResponse>;

export interface TelegramDiscoveredChat {
  id: string;
  type: TelegramChatType;
  title: string;
}

export interface TelegramUpdateBatchItem {
  updateId: string;
  chats: TelegramDiscoveredChat[];
}

export interface TelegramSendResult {
  messageId: string;
}

export interface TelegramSendMessageInput {
  deliveryId: string | null;
  chatId: string;
  text: string;
  signal?: AbortSignal;
}

export interface TelegramSendFileInput {
  deliveryId: string;
  chatId: string;
  filePath: string;
  caption: string;
  signal?: AbortSignal;
}

export interface TelegramGetUpdatesInput {
  offset: string | null;
  allowedUpdates: readonly TelegramAllowedUpdate[];
  timeoutSeconds: number;
  signal?: AbortSignal;
}

export interface TelegramClientLogEntry {
  method:
    | "getMe" | "deleteWebhook" | "logOut" | "getUpdates"
    | "sendMessage" | "sendVideo" | "sendAudio" | "sendDocument";
  status: number;
  deliveryId: string | null;
}

export type TelegramClientLogger = (entry: TelegramClientLogEntry) => void;

export interface TelegramBotApiClientPort {
  getMe(signal?: AbortSignal): Promise<TelegramBotSummary>;
  deleteWebhook(dropPendingUpdates: false, signal?: AbortSignal): Promise<{ ok: true }>;
  logOut(signal?: AbortSignal): Promise<{ ok: true }>;
  getUpdates(input: TelegramGetUpdatesInput): Promise<TelegramUpdateBatchItem[]>;
  sendMessage(input: TelegramSendMessageInput): Promise<TelegramSendResult>;
  sendVideo(input: TelegramSendFileInput): Promise<TelegramSendResult>;
  sendAudio(input: TelegramSendFileInput): Promise<TelegramSendResult>;
  sendDocument(input: TelegramSendFileInput): Promise<TelegramSendResult>;
}

export class TelegramApiError extends Error {
  constructor(input: {
    status: number;
    errorCode: number | null;
    retryAfterSeconds: number | null;
    stableCode: TelegramApiError["stableCode"];
    category: TelegramApiError["category"];
    submission: TelegramApiError["submission"];
    safeDescription: string;
    cause?: unknown;
  });
  readonly status: number;
  readonly errorCode: number | null;
  readonly retryAfterSeconds: number | null;
  readonly stableCode:
    | "AUTH_INVALID" | "TARGET_PERMISSION_DENIED" | "TARGET_NOT_FOUND"
    | "MEDIA_INVALID" | "RATE_LIMITED" | "SERVER_ERROR"
    | "NETWORK_NOT_SUBMITTED" | "NETWORK_RESULT_UNKNOWN"
    | "INVALID_RESPONSE" | "LOCAL_SERVICE_EXITED";
  readonly category: "auth" | "invalid_target" | "media" | "rate_limit" | "server" | "network" | "invalid_response";
  readonly submission: "not_submitted" | "possibly_submitted" | "response_received";
  readonly safeDescription: string;
}

export interface TelegramRequestTimeouts {
  readonly metadataMs: number;
  readonly uploadMs: null;
}

export const PRODUCTION_TELEGRAM_REQUEST_TIMEOUTS: TelegramRequestTimeouts =
  Object.freeze({ metadataMs: 30_000, uploadMs: null });

export class TelegramBotApiClient implements TelegramBotApiClientPort {
  constructor(
    location: TelegramApiLocation,
    botToken: string,
    fetchImpl: TelegramFetch,
    requestTimeouts: TelegramRequestTimeouts,
    log: TelegramClientLogger,
  );
  getMe(signal?: AbortSignal): Promise<TelegramBotSummary>;
  deleteWebhook(dropPendingUpdates: false, signal?: AbortSignal): Promise<{ ok: true }>;
  logOut(signal?: AbortSignal): Promise<{ ok: true }>;
  getUpdates(input: TelegramGetUpdatesInput): Promise<TelegramUpdateBatchItem[]>;
  sendMessage(input: TelegramSendMessageInput): Promise<TelegramSendResult>;
  sendVideo(input: TelegramSendFileInput): Promise<TelegramSendResult>;
  sendAudio(input: TelegramSendFileInput): Promise<TelegramSendResult>;
  sendDocument(input: TelegramSendFileInput): Promise<TelegramSendResult>;
}

export function buildTelegramCaption(input: {
  title: string;
  fileSize: number;
  sourceUrl: string;
}): string;
```

`TelegramBotApiClient` 必须把 Token 保存在 ECMAScript `#private` 字段中，不能提供 getter 或序列化方法；worker/controller 只依赖可注入 fake 的 `TelegramBotApiClientPort`，不依赖带 `#private` 的 concrete class。Client 构造 endpoint URL 只能发生在私有函数中；公开结果与异常不得包含 URL。请求日志只能通过 `TelegramClientLogger` 记录 method、HTTP status、delivery ID，metadata 调用的 delivery ID 为 `null`。

timeout语义固定且不是实现者参数：`metadataMs=30_000`约束`getMe/deleteWebhook/logOut/getUpdates/sendMessage`，并与调用者AbortSignal组合；deadline到达和所有settle路径都清除timer/listener。`sendVideo/sendAudio/sendDocument`的`uploadMs`类型和值都只能为`null`，表示 client 本身没有wall-clock timeout；`null`绝不能退化为30秒、Node默认值或truthy fallback。文件发送仍接受调用者AbortSignal：Supervisor明确退出、Worker shutdown/generation中止，以及Task 9按持久`fileSize`计算的有限upload watchdog都通过该signal取消。watchdog属于Worker队列活性合同，不得藏进client或改变`TelegramRequestTimeouts`。Worker上传期间仍每30秒续租；任一abort若已`markSending`且无明确response，必须写`uncertain`，晚response因generation失效不得写状态。Client测试覆盖metadata 29.999/30.000秒、上传超过30秒仍继续/续租/完成、Worker watchdog与shutdown分别Abort→uncertain、Supervisor退出与timer/listener零残留。

所有 response 都只能先经过本文件实现的 `parseTelegramResponseLossless`，再过 API-specific 严格 decoder/Zod；不得先调用 `JSON.parse`、`Response.json()` 或任何会构造 JS number 的解析器。该函数是一个有界 RFC 8259 token parser：最大 UTF-8 输入 16 MiB、嵌套 64 层、对象/数组成员合计 100000；字符串按 JSON escape 规则解码，重复 object key 一律拒绝，数字只保存为 `LosslessJsonNumberToken.raw`，在 token 阶段绝不构造 `number`。API decoder 对 `update_id`、Bot ID 与 message ID 只接受规范非负整数 token `0|[1-9][0-9]*` 并保留十进制字符串；chat ID 单独接受规范有符号十进制 `0|[1-9][0-9]*|-[1-9][0-9]*`，再按 chat type 要求 private 为正、group/supergroup/channel 为负。`-0`、前导零、显式 `+`、小数和指数形式都拒绝；合法负 chat ID绝不能先转 JS `number`。真正需要小整数的 `error_code/retry_after` 先以 `BigInt` 验证范围，再显式转为安全整数；不认识的 number token 不得静默舍入。`getUpdates` 只能由此入口生成 `TelegramUpdateBatchItem[]`，只接受上述三个 `TelegramAllowedUpdate` 值，返回 DTO 不含 raw update。测试还必须证明普通 `JSON.parse` spy 调用数为零、重复键在任何字段都失败、输入/深度/成员上限 fail closed，私聊正 ID 与 group/supergroup/channel 三类负 ID均保真，`-0`/前导零失败，且相邻超大 update ID 在 offset 计算后仍分别得到精确值。

- [ ] **Step 4: 实现本地文件与 caption 规则**

```ts
export function localInputFile(
  filePath: string,
  platform: "win32" | "darwin",
): string {
  const pathStyle = platform === "win32" ? path.win32 : path.posix;
  if (!pathStyle.isAbsolute(filePath)) throw new Error("LOCAL_FILE_PATH_REQUIRED");
  return pathToFileURL(pathStyle.normalize(filePath), {
    windows: platform === "win32",
  }).href;
}
```

`client.ts` 顶层显式 import `node:path`、`node:url` 和共享 Telegram 类型，禁止内联 import。`pathToFileURL(..., { windows })` 让 macOS runner 也能确定性测试 Windows 路径，反之亦然。发送 body 使用 JSON，把 `video` / `audio` / `document` 设为该 `file:` URL；不得 `readFile`、`createReadStream`、FormData 或 multipart。caption 最大 1024 Unicode code points，按“标题、可读大小、来源 URL”构造，截断标题优先保留完整来源 URL，绝不包含本地路径。

- [ ] **Step 5: 固定媒体 fallback 可判定错误**

只把 Telegram 明确的 media decode/thumbnail/content-type 错误归 `media`；文件不存在、目标权限、auth、rate limit 和网络错误不得误触发 document fallback。401/invalid token 只归 `AUTH_INVALID`；403 以及 chat not found/forbidden 只归 `invalid_target`，不能同时归 auth。只有在连接到 `127.0.0.1` 前得到可证明未提交的 `ECONNREFUSED/ENETUNREACH` 才设 `submission="not_submitted"`；reset、timeout、Abort、child exit、响应体无法解析一律 `possibly_submitted`。收到明确 4xx/429/5xx JSON response 才是 `response_received`。测试断言每条分类具有稳定 code、submission 和用户文案 key。

- [ ] **Step 6: 跑测试**

```powershell
npm.cmd --prefix desktop test -- client.test.ts redaction.test.ts
```

Expected: PASS，测试进程最大内存不随 fake 2GB 文件大小增长。

- [ ] **Step 7: Commit**

```powershell
git add desktop/electron/telegram/client.ts desktop/electron/telegram/client.test.ts
git commit -m "feat(electron): add telegram bot api client"
```

---

## Phase 3 — 可靠发送与账户编排

### Task 9: 实现 Main-only Sidecar gateway 与串行发送工作器

**Files:**
- Modify: `desktop/electron/sidecar.ts`
- Create: `desktop/electron/sidecar.test.ts`
- Create: `desktop/electron/telegram/sidecarGateway.ts`
- Create: `desktop/electron/telegram/sidecarGateway.test.ts`
- Create: `desktop/electron/telegram/deliveryWorker.ts`
- Create: `desktop/electron/telegram/deliveryWorker.test.ts`

- [ ] **Step 1: 写 claim 到终态的失败测试**

测试以下完整轨迹并逐项验证 Sidecar 调用顺序：

```text
claimNext -> stable stat -> markSending(video,chargeAttempt=true) -> sendVideo -> markSent
claimNext -> stable stat -> markSending(audio,chargeAttempt=true) -> sendAudio -> markSent
claimNext -> stable stat -> markSending(document,chargeAttempt=true) -> sendDocument -> markSent
claimNext -> markSending(video,chargeAttempt=true) -> media error -> markSending(document,fallback=true,chargeAttempt=false) -> sendDocument -> markSent
claimNext(fallbackUsed=true,mediaKind=document) -> markSending(document,fallback=true,chargeAttempt=true) -> sendDocument -> markSent
claimNext -> oversize -> markSending(oversize_notice,chargeAttempt=true) -> sendMessage -> markSkippedOversize
claimNext -> local service unavailable before request -> markRetryNotSubmitted from preparing
claimNext -> markSending -> ECONNREFUSED/ENETUNREACH proven before submit -> markRetryNotSubmitted with charged attempt rollback
claimNext -> explicit 429/5xx response -> markRetry with charged attempt retained
claimNext -> file error -> markFailed
claimNext -> permission/chat-not-found -> markTargetFailed and bulk fail same target
claimNext -> request accepted but response lost/invalid/aborted -> markUncertain
```

再测试 2GB 慢上传期间每 30 秒 renewLease，worker 同一时刻只有一个 active send。三条服务退出轨迹分别断言：请求前 supervisor 进入 restarting 时 preparing 不计 attempt 地退到 retry_wait；连接建立前 ECONNREFUSED 回退刚增加的 attempt；fake service 在记录“已接收请求”后 reset connection 必须只 markUncertain，进程重启也不得自动重发。连续三次未提交失败跨 Worker 重建后，claim 的 retry sequence 驱动延迟精确为 10/30/120 秒。另覆盖 fallback document 收到 5xx 后重领、fallback document 遇 ECONNREFUSED 后重领；两条跨 lease 路径都只能再次调用 `sendDocument`，不得回到 video/audio。`sidecar.test.ts` 还构造真实协议错误 response，证明 Sidecar `code/safeMessage` 经 request transport 和 gateway 不丢失，且 raw Python traceback/secret 不进入错误对象。`sidecarGateway.test.ts`另对configure boundary做完整表驱动：本地schema失败得到`pre_commit_rejected`且transport=0；strict成功得到`committed`；resolved invalid raw或真实correlated `SidecarProtocolError`只得到一次`settled_result_unknown`和同generation proof；1.999秒terminal frame可settle，2.000秒同tickdeadline胜，永久pending/transport disconnect/无terminal frame只得到`in_flight_or_disconnected_unknown`。deadline后late resolve/reject不得改变原result或产生第二个proof；模块外代码无法构造有效proof，重复consume为false，JSON/structured-clone都不能得到可用副本；所有safeErrorCode均通过既有秘密过滤。
边界测试固定断言 `2_000_000_000` 字节允许文件发送，`2_000_000_001` 字节不调用 send file 且只发送 oversize notice。

- [ ] **Step 2: 确认失败**

```powershell
npm.cmd --prefix desktop test -- sidecar.test.ts sidecarGateway.test.ts deliveryWorker.test.ts
```

Expected: FAIL，gateway 与 worker 尚不存在。

- [ ] **Step 3: 实现只供 Main 使用的 gateway**

Gateway 对 `SidecarProcess.request` 提供以下具名方法和唯一构造依赖：

```ts
export interface SidecarRequestTransport {
  request(method: string, payload: Record<string, unknown>): Promise<unknown>;
}

const configureHandlerSettledProofBrand: unique symbol = Symbol("ConfigureHandlerSettledProof");

export interface ConfigureHandlerSettledProof {
  readonly [configureHandlerSettledProofBrand]: true;
  consume(): boolean;
}

export type TelegramConfigureBoundaryResult =
  | { state: "committed"; config: TelegramSidecarConfig }
  | { state: "pre_commit_rejected"; safeErrorCode: string }
  | { state: "settled_result_unknown"; proof: ConfigureHandlerSettledProof; safeErrorCode: string | null }
  | { state: "in_flight_or_disconnected_unknown" };

export type TelegramConfigureExpectedTruth =
  | { kind: "exact"; config: TelegramSidecarConfig }
  | {
      kind: "server_generated_enabled_at";
      expectedWithoutEnabledAt: Omit<TelegramSidecarConfig, "enabledAt">;
    };

export function buildTelegramConfigureExpectedTruth(
  before: TelegramSidecarConfig,
  patch: TelegramSidecarConfigPatch,
): TelegramConfigureExpectedTruth;

export interface TelegramSidecarGatewayPort {
  configure(input: TelegramSidecarConfigPatch, absoluteDeadlineMs: number): Promise<TelegramConfigureBoundaryResult>;
  getConfig(): Promise<TelegramSidecarConfig>;
  list(query: TelegramDeliveryQuery): Promise<TelegramDeliveryPage>;
  claimNext(accountId: string, now: string, leaseExpiresAt: string): Promise<TelegramClaim | null>;
  renewLease(deliveryId: string, leaseId: string, leaseExpiresAt: string): Promise<void>;
  releaseClaim(input: TelegramReleaseClaimInput): Promise<TelegramDeliverySummary>;
  markSending(input: TelegramMarkSendingInput): Promise<TelegramDeliverySummary>;
  markSent(input: TelegramMarkSentInput): Promise<TelegramDeliverySummary>;
  markRetry(input: TelegramMarkRetryInput): Promise<TelegramDeliverySummary>;
  markRetryNotSubmitted(input: TelegramMarkRetryNotSubmittedInput): Promise<TelegramDeliverySummary>;
  markFailed(input: TelegramMarkFailedInput): Promise<TelegramDeliverySummary>;
  markTargetFailed(input: TelegramMarkTargetFailedInput): Promise<TelegramDeliverySummary[]>;
  markUncertain(input: TelegramMarkUncertainInput): Promise<TelegramDeliverySummary>;
  markSkippedOversize(input: TelegramMarkSkippedOversizeInput): Promise<TelegramDeliverySummary>;
  getTargetBlock(accountId: string, targetChatId: string): Promise<TelegramTargetBlock | null>;
  clearTargetBlock(input: TelegramClearTargetBlockInput): Promise<boolean>;
  retry(input: TelegramRetryInput): Promise<TelegramDeliverySummary>;
  cancelPending(accountId: string | null): Promise<number>;
}

export class TelegramSidecarGateway implements TelegramSidecarGatewayPort {
  constructor(transport: SidecarRequestTransport);
  configure(input: TelegramSidecarConfigPatch, absoluteDeadlineMs: number): Promise<TelegramConfigureBoundaryResult>;
  getConfig(): Promise<TelegramSidecarConfig>;
  list(query: TelegramDeliveryQuery): Promise<TelegramDeliveryPage>;
  claimNext(accountId: string, now: string, leaseExpiresAt: string): Promise<TelegramClaim | null>;
  renewLease(deliveryId: string, leaseId: string, leaseExpiresAt: string): Promise<void>;
  releaseClaim(input: TelegramReleaseClaimInput): Promise<TelegramDeliverySummary>;
  markSending(input: TelegramMarkSendingInput): Promise<TelegramDeliverySummary>;
  markSent(input: TelegramMarkSentInput): Promise<TelegramDeliverySummary>;
  markRetry(input: TelegramMarkRetryInput): Promise<TelegramDeliverySummary>;
  markRetryNotSubmitted(input: TelegramMarkRetryNotSubmittedInput): Promise<TelegramDeliverySummary>;
  markFailed(input: TelegramMarkFailedInput): Promise<TelegramDeliverySummary>;
  markTargetFailed(input: TelegramMarkTargetFailedInput): Promise<TelegramDeliverySummary[]>;
  markUncertain(input: TelegramMarkUncertainInput): Promise<TelegramDeliverySummary>;
  markSkippedOversize(input: TelegramMarkSkippedOversizeInput): Promise<TelegramDeliverySummary>;
  getTargetBlock(accountId: string, targetChatId: string): Promise<TelegramTargetBlock | null>;
  clearTargetBlock(input: TelegramClearTargetBlockInput): Promise<boolean>;
  retry(input: TelegramRetryInput): Promise<TelegramDeliverySummary>;
  cancelPending(accountId: string | null): Promise<number>;
}
```

`SidecarProcess.request`的唯一终态信号也在这个Main-only边界固定：Promise resolve或抛出由同一request ID的完整correlated error frame构造的`SidecarProtocolError`，都证明该handler已经结束；普通reject、timeout、进程退出、line pump关闭或无法关联request ID的frame都不提供此证明。每次Controller configure都以进程内monotonic `performance.now()`计算`absoluteDeadlineMs=min(now+2000,当前mutation绝对deadline)`，生产不读`Date.now()`，测试用fake timers同时控制`performance.now/setTimeout`；runtime-degraded关闭auto-send也使用同一2秒边界。patch schema失败固定`pre_commit_rejected/INVALID_PARAMS`，非法或已过deadline固定`pre_commit_rejected/OPERATION_FAILED`，二者都在调用transport前结束；与terminal frame同tick固定deadline胜。上述方法和proof都不从 `preload.ts` 导出；`filePath` 类型只存在 `TelegramClaim`。

`desktop/electron/sidecar.ts` 增加 `SidecarProtocolError extends Error`，公开字段精确为 `code: string` 与 `safeMessage: string`；协议 `{error:{code,message}}` 只在通过长度/秘密过滤后构造该错误，绝不把整个 response、traceback 或 cause 挂到对象。`TelegramSidecarGateway` 不用 `new Error(error.message)` 包装它，原样保留 `code/safeMessage`；未知 transport 异常统一为内部 `OPERATION_FAILED` 候选且仍先脱敏。测试贯穿 SidecarProcess → Gateway，逐个证明 `INVALID_PARAMS/NOT_FOUND/STATE_CONFLICT/TARGET_STILL_BLOCKED` 稳定 code 可被 Main 映射。

- [ ] **Step 4: 实现文件准备与分类**

Worker 对 claim path 调用 `probeReadableFile` 两次，间隔 250ms。每次 production probe 固定执行 `fs.promises.open(path, "r") → handle.stat({bigint:true}) → finally handle.close()`，只接受 regular file；size先验证 `0..Number.MAX_SAFE_INTEGER` 再显式转 number，`mtimeNs` 从 bigint直接转规范十进制字符串。路径不存在、任一次检查前后消失或不是 regular file写 `FILE_MISSING`，`EACCES/EPERM`、读取句柄/fstat失败或 close failure写 `FILE_UNREADABLE`，两次 `{size,mtimeNs}` 不同或稳定值与 claim 中持久 `fileSize/fileMtimeNs` 不一致写 `FILE_CHANGED`。三类都严格走 Task 1 的 matching-lease `preparing → failed` CAS，不先调用 `markSending`、不增加 attempt/retry，并清空 lease；close fault也必须 fail closed，不能继续发送。测试用同大小替换文件与大于 `Number.MAX_SAFE_INTEGER` 的 mtimeNs证明仅比较size不足且纳秒值从未转number。扩展名分类只在 Task 2 创建新 delivery 时执行一次；Worker 把 claim 的持久 `mediaKind/fallbackUsed` 视为权威。只要 `fallbackUsed=true` 或 `mediaKind=document`，当前及后续所有 lease 都从 document 开始，绝不能因 `.mp4/.m4a` 扩展名回退到 video/audio；新 lease 的 document 请求是新发送周期，必须 `chargeAttempt=true`，同一 lease 内收到明确 media error 后立即 fallback 才使用 `chargeAttempt=false`。

- [ ] **Step 5: 实现上限、fallback、续租和退避**

- `size > 2_000_000_000`：不调用任何 send file；先 `markSending(mediaKind="oversize_notice",chargeAttempt=true)`，再发一条包含标题、实际大小和“文件已保留在电脑”的文字，成功后 `markSkippedOversize`。通知请求期间退出按普通 sending 恢复为 uncertain，避免静默重复通知。
- `sendVideo` / `sendAudio` 仅在 `TelegramApiError.category === "media"` 时用同一 delivery 降级一次。
- 租约 120 秒，每 30 秒续租；续租冲突立即中止并且不发新请求。
- 每次 file send 在 `markSending` commit 后由 Worker 计算唯一 watchdog：`clamp(15分钟 + ceil(fileSize / 16384 bytes/s) * 1000, 30分钟, 48小时)`；`fileSize` 必须是 `0..2_000_000_000` 的安全整数，计算结果也必须是安全整数。client的`uploadMs`仍为null，30秒metadata deadline绝不能复用。发送Promise与可取消watchdog在同一generation内竞速：明确response先settle则取消watchdog并按response转换；watchdog先settle（同一时刻按watchdog优先）则先使generation失效、abort request，再在2秒内以`NETWORK_RESULT_UNKNOWN`写`uncertain`并清active/lease timer，晚response零写入，随后worker立即领取下一条。markUncertain失败/超时则保持DB中的sending、不领取下一条、自置paused并最后`await onDeliveryRecoveryPending("ACTIVE_DELIVERY_RECOVERY_PENDING")`；Controller只广播“重启百纳后再试”，不得对同一active回调pause。应用重启后由启动lease recovery收敛。所有success/error/abort路径必须清watchdog、续租timer与AbortSignal listener。
- 明确 HTTP 5xx response 使用 `markRetry` 并保留已消耗 attempt；只有 client 分类为 `submission="not_submitted"` 的连接前失败才使用 `markRetryNotSubmitted` 并回退当前请求 attempt。两者都用 claim 中进入本次失败前的持久 `retrySequenceCount` 选择 `[10, 30, 120, 600, 3600]` 秒，索引超过 4 后固定 3600；store 转换再把 sequence 原子加 1，所以跨进程不会回到第一档。`markSending` 后的 reset、timeout、invalid response、child crash 或任何无法证明未提交的网络错误一律 `markUncertain`，绝不自动 retry。
- 429 使用 `retry_after` 加 0–3 秒可注入 jitter。
- 显式 401 归 `AUTH_INVALID`，固定收敛顺序为 `markRetry(errorCode=AUTH_INVALID,nextAttemptAt=now)`（保留 attempt 与 retry sequence）→ 清空 active/generation → 把 worker 自身置为 paused(`reauth_required`) → `await onAuthRequired` 通知 Controller；callback 只更新连接状态/广播，不得对同一 active 再调用 `pause()`，因此无重入等待、无 uncertain、无残留 sending。403、chat not found/forbidden 归 `TARGET_PERMISSION_DENIED/TARGET_NOT_FOUND`，固定收敛顺序为 `await markTargetFailed` 持久批量失败同一 account/target → 使当前 generation 失效并清空 active/lease timer → 把 worker 自身置为 paused(`invalid_target`) → 最后 `await onTargetInvalid`。callback 只更新 Controller 状态/广播，绝不能再次调用该 worker 的 `pause()`；它同步观察时必须已是 paused 且无 active/lease，避免 callback 自等待死锁或在回调间隙领取下一条同目标记录。成功重新选择且测试同一 target 后，Controller 调 `clearTargetBlock`；旧 failed 记录仍需用户手动 retry，clear 前 retry 返回 `TARGET_STILL_BLOCKED`，clear 后才可重排。
- 一旦 `markSending` 成功，如果进程关闭/AbortSignal 触发且没有明确 API 响应，调用 `markUncertain`，绝不自动 retry；唯一例外是 client 明确证明连接建立前失败的 `submission="not_submitted"`，此时调用专用 `markRetryNotSubmitted`，不能调用普通 `markRetry`。

每一次 `markSending` 自身也必须先通过同一个2秒有界的 `persistRequestBoundary`：首次 video/audio/document、oversize notice，以及明确media error后的document fallback更新都适用。boundary开始时捕获不可变的`boundaryGeneration`与`deliveryId`；gateway返回明确成功summary后、调用任何Telegram client前，Worker还必须在同一同步临界区原子复核：generation仍等于`boundaryGeneration`、active仍是同一delivery、worker既非stopping/paused也未设置任一recovery latch。只有这次复核成功才授予一次性send permit并调用summary对应的`sendVideo/sendAudio/sendDocument/sendMessage`；permit授予与stop/pause线性化同tick时固定stop/pause优先。若boundary reject、deadline、invalid response、Sidecar disconnect、“事务已提交但response丢失”，或明确成功response到达时上述运行门已关闭，当前generation立即失效，清准备/续租/watchdog资源，绝不调用对应Telegram请求、绝不重放`markSending`、绝不再按preparing调用`releaseClaim`，并用当前deliveryId设置同一`recoveryPending/recoveryPendingDeliveryId`单向latch、进入paused后通知Controller设置其latch。完整重启只读数据库真值：首次写未提交仍为preparing，按lease到期安全重领；已提交为sending则转`uncertain/APP_RESTART_RESULT_UNKNOWN`。fallback写无论是否提交都不再发document，重启时sending同样只转uncertain。这样“先持久化sending，再发网络请求”在response loss和停止竞态下仍是严格单向边界。

`markSending` 成功后的每个状态收敛写都走同一个 `persistPostSubmissionTransition` 门禁：`markSent`、`markSkippedOversize`、`markRetry`、`markRetryNotSubmitted`、`markTargetFailed`、`markFailed` 与普通网络不确定分支的 `markUncertain` 各自最多等待 2 秒。明确成功只应用其唯一返回 summary；reject、deadline、invalid response、Sidecar disconnect 或“SQLite 已提交但 response 丢失”都不得猜测未提交，也不得改调第二个终态方法。失败分支必须先使当前 generation 失效，abort 尚未结束的 request，清 watchdog、续租 timer 与 listener，再把只存在于当前Worker实例的`recoveryPending`从false原子置为true，同时把当前非空deliveryId固定进`recoveryPendingDeliveryId`；两个字段在当前实例都是单向且不可覆盖/清除。随后禁止下一次claim并把Worker自身置为paused，最后`await onDeliveryRecoveryPending("ACTIVE_DELIVERY_RECOVERY_PENDING")`。该latch一旦为true，`start/resume/wake`全部为零操作，`pause/stop`不再调用gateway而恒定返回exact `TelegramWorkerStopResult {state:"recovery_pending",deliveryId:recoveryPendingDeliveryId}`，稳定错误码仍由Controller按state映射，不给Worker DTO增加`code`字段。只有销毁整个应用进程中的旧Worker，并由新Sidecar完成startup lease recovery后构造的新Worker才以false/null开始。重启后的 `recover_delivery_leases()` 只按数据库真值收敛：首次写已提交则保留该 sent/skipped/retry/failed/uncertain 终态，未提交而仍为 sending 才转为 `uncertain/APP_RESTART_RESULT_UNKNOWN`。当前进程不允许为了“确认”重放终态写或重新发送文件。

- [ ] **Step 6: 实现 wake loop 与退出**

```ts
export interface TelegramWorkerFileStat {
  isFile: boolean;
  size: number;
  mtimeNs: string;
}

export const TELEGRAM_UPLOAD_WATCHDOG = Object.freeze({
  fixedOverheadMs: 15 * 60_000,
  minimumMs: 30 * 60_000,
  maximumMs: 48 * 60 * 60_000,
  minimumBytesPerSecond: 16 * 1024,
});

export function computeTelegramUploadWatchdogMs(fileSize: number): number;

export type TelegramWorkerPauseReason =
  | "disconnected"
  | "reauth_required"
  | "invalid_target"
  | "local_service_unavailable"
  | "credential_refresh"
  | "configure_result_unknown";

const telegramWorkerClaimGateTokenBrand: unique symbol = Symbol("TelegramWorkerClaimGateToken");

export interface TelegramWorkerClaimGateToken {
  readonly [telegramWorkerClaimGateTokenBrand]: true;
}

export interface TelegramWorkerCallbacks {
  onAuthRequired(code: "AUTH_INVALID"): Promise<void>;
  onDeliveryRecoveryPending(
    code: "ACTIVE_DELIVERY_RECOVERY_PENDING",
  ): Promise<void>;
  onTargetInvalid(input: {
    accountId: string;
    targetChatId: string;
    code: "TARGET_PERMISSION_DENIED" | "TARGET_NOT_FOUND";
  }): Promise<void>;
}

export interface TelegramDeliveryWorkerDeps extends TelegramWorkerCallbacks {
  gateway: TelegramSidecarGatewayPort;
  client: TelegramBotApiClientPort;
  accountId: string;
  nowIso(): string;
  probeReadableFile(filePath: string): Promise<TelegramWorkerFileStat>;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  random(): number;
}

export interface TelegramDeliveryWorkerPort {
  start(): void;
  wake(): void;
  blockNewClaims(): TelegramWorkerClaimGateToken;
  reopenClaims(token: TelegramWorkerClaimGateToken): void;
  sealClaimsBlocked(token: TelegramWorkerClaimGateToken): void;
  pause(reason: TelegramWorkerPauseReason): Promise<TelegramWorkerStopResult>;
  resume(): void;
  stop(): Promise<TelegramWorkerStopResult>;
}

export class TelegramDeliveryWorker implements TelegramDeliveryWorkerPort {
  constructor(deps: TelegramDeliveryWorkerDeps);
  start(): void;
  wake(): void;
  blockNewClaims(): TelegramWorkerClaimGateToken;
  reopenClaims(token: TelegramWorkerClaimGateToken): void;
  sealClaimsBlocked(token: TelegramWorkerClaimGateToken): void;
  pause(reason: TelegramWorkerPauseReason): Promise<TelegramWorkerStopResult>;
  resume(): void;
  stop(): Promise<TelegramWorkerStopResult>;
}
```

`wake()` 合并并发信号；队列为空时保留 30 秒恢复轮询。tokenized claim gate 初始为 open。`blockNewClaims()`是同步、纯内存线性化点：递增claim generation、关闭该gate、取消30秒轮询并返回冻结的当前generation token，不调用gateway/client；重复关闭、stale/重复token或模块外伪造token都拒绝。已经发出的`claimNext`捕获旧generation，任何迟到结果即使之后安全reopen也只能丢弃，绝不能stat/prepare/send；数据库中可能已经取得的preparing lease只允许按既有lease到期规则重领，旧continuation不得主动写第二次。当前token必须且只能选择一个终态：`reopenClaims(token)`消费token、原子打开gate并合并一次wake；`sealClaimsBlocked(token)`消费token并把本worker的gate永久封存为closed，之后任何token、state event或reconcile都不能重开。`pause/stop`的paused/stopping flag与这道tokenized gate彼此独立：普通pause立即通过paused flag禁止新claim，但不创建、消费或重开claim-gate token，因此凭据刷新等正常pause在原gate仍open时可以安全resume；destructive configure result unknown则必须先seal再pause。`pause(reason)`返回可 await 的收敛结果。所有pause原因下的preparing claim都必须走唯一`persistPreparingTransition`，自该boundary发出起使用绝对2秒deadline：`local_service_unavailable`唯一调用`markRetryNotSubmitted(code="LOCAL_SERVICE_EXITED")`，其他pause reason唯一调用`releaseClaim`回pending；1.999秒内明确成功才可settled，2.000秒与response同tick固定deadline优先。已sending的请求最多等明确响应5秒，否则uncertain，绝不能因pause自动重发。`pause()`与`stop()`共享同一个active settlement/generation且都从首次调用时刻沿用绝对8秒总deadline；并发调用只await同一个promise，绝不发第二个gateway状态写。`resume()`仅在tokenized claim gate处于初始open或已由当前有效token明确reopen、旧active已收敛且Controller已确认local service ready、凭据有效、target verified、未被持久封锁时恢复领取并立刻wake；sealed gate 永不满足该条件。

`persistPreparingTransition`在发出唯一gateway request前捕获不可变`settlementGeneration/deliveryId/leaseId`并安装仅一次的结果observer；reject、2秒deadline、invalid response、Sidecar disconnect或“SQLite已提交但response丢失”一律视为结果未知：同步使generation失效、清timer、把既有`recoveryPending/recoveryPendingDeliveryId`单向latch设为当前delivery、置paused，并在返回前触发同一个`onDeliveryRecoveryPending`，最终`pause/stop`都返回exact`{state:"recovery_pending",deliveryId}`。该分支绝不第二次调用release/mark、绝不resume/claim，也不猜测数据库是否提交；完整重启后只按DB真值处理——已提交pending保持pending，未提交preparing按lease到期由startup/claim安全重领，从未触发Telegram发送。底层transport request即使稍后返回，也只有generation检查后直接丢弃的observer，不能执行Controller/Worker/queue/config/vault continuation或发起另一写；Sidecar已经完成的唯一事务只作为下次启动读取的DB真值。并发`stop()`不得另建settlement，shutdown signal只把Controller mutation await的所有权转交给同一个`worker.stop()`，mutation chain在500ms内释放且stop继续在原8秒绝对deadline内收敛。

401 和 target-invalid 是上述通用 `pause()` 的两个内部特殊入口：发送循环先完成持久转换并清 active，再设置 paused 后才调用 callback；Controller 收到 `onAuthRequired/onTargetInvalid` 时不得回调该 worker 的 `pause`。测试让两个 callback 分别同步读取状态并等待广播，断言无 deadlock、无 active/lease timer、不会再 claim；401 记录为 due `retry_wait`，凭据刷新后 `resume/wake` 能重新领取，target failed 则必须先 clear block 再人工 retry。

任一 post-submission 状态写的持久化失败或结果未知都是第三个内部自暂停入口：Worker 已使 request generation 失效、abort并停止续租，但故意保留数据库当前真值，随后在调用`onDeliveryRecoveryPending`前已设置`recoveryPending=true`并进入paused。Controller callback的第一项同步动作是把自己的process-local `deliveryRecoveryPending=true`，随后只把`warningCode`设为`ACTIVE_DELIVERY_RECOVERY_PENDING`、`recoveryAction="restart_app"`并广播；不得resume、换worker、清latch或回调pause。用户完整重启百纳后，新的Sidecar在`app.ready`前保留已提交终态，或把仍为sending的记录转为`uncertain/APP_RESTART_RESULT_UNKNOWN`，全新Controller才从`deliveryRecoveryPending=false`开始。测试让callback同步读取状态，必须看到两个latch都为true、paused、零timer、零下一次claim且warning文案不含内部服务词。

`stop()` 使用固定算法，不保留实现选择：先置 stopping、清轮询/续租 timer并禁止新 claim，然后按当前 source state 分支。纯本地`preparing`立即取消stat/准备操作、使generation失效，并在2秒内调用`releaseClaim`原子回pending；但`markSending` boundary一旦已发出就是独立`mark_sending_in_flight`状态，绝不能落入该release分支。stop/pause对此状态先线性化关闭send permit并使generation失效，再只等待同一boundary到其原有2秒deadline：无论得到明确成功summary还是结果未知都绝不调用Telegram client、绝不`releaseClaim`或重放boundary，并固定进入上述recovery latch、返回`recovery_pending`；完整重启按DB真值区分preparing与sending。只有permit已在stop前授予、Telegram request确已开始才是`sending`：先保持当前request的AbortSignal未触发，最多等待5秒明确API response；在5秒内得到响应（包括4.9秒边界）时按唯一`sent/retry/failed`转换完成且绝不abort。只有等待超时、子进程明确退出或transport已无可能给出有效响应时，才先使generation失效、再abort request，并在2秒内调用`markUncertain(code="SHUTDOWN_RESULT_UNKNOWN")`。晚到的boundary/fetch completion因generation不匹配不得发网络请求或再写Sidecar。Worker进入`stop()`时若没有active settlement，才以本次stop调用时刻创建唯一绝对8秒deadline；若已有pause/settlement，则必须复用其generation、promise与既有绝对deadline，绝不得重置或延长。5秒response window、最多2秒持久转换与至少1秒timer/generation/Promise settle余量都按该既有deadline的剩余时间裁剪；所有gateway调用同样按剩余时间有界。唯一deadline前mark成功返回`settled`；Sidecar不可用、持久转换超时或row仍为sending时返回`recovery_pending`，共享Promise仍必须在该deadline前settle，绝不把后台写入放飞。下次 Sidecar 进程启动必须在 early/peer hello 成功后、request loop 与 `app.ready` 前调用完整 facade 中的 `recover_delivery_leases()`，把该持久 `sending` 原子转为 `uncertain/APP_RESTART_RESULT_UNKNOWN`；运行期 output-recovery timer 严禁承担此转换，也不存在其他全局恢复入口。Controller 的 `shutdown()` 只 await 并返回该 worker 结果；Supervisor 与 Sidecar 的 app-quit 停止权只属于 Main。Main 的总 shutdown deadline固定30秒（Controller外层最多9秒且Worker内部从首次active settlement起8秒必settle、Supervisor外层最多7秒且其内部6秒必settle、Sidecar外层最多10秒且其内部9秒必settle，剩余4秒用于force与调度/确认），测试用最坏fake时钟证明可满足，不能再声明10秒。

测试分别卡住 preparing、sending-before-response、4.9 秒明确 response、5 秒 timeout 后 abort、response 与 timeout 同时到达、markUncertain 超时六个竞态；断言 preparing 可重排，4.9 秒响应未被 abort且只产生一个明确终态，只有 5 秒超时后才发生 abort + uncertain，任何晚到 promise 不写状态。fake clock另覆盖6.999/7.000秒持久转换边界、7.999秒内部settle、8.000秒fail-closed/recovery_pending与9.000秒Main外层边界，证明Worker总在8秒内settle且Main不抢跑；再做真实 shutdown → 新 Sidecar 启动，证明 early/peer hello 成功后且 `app.ready` 前 `recover_delivery_leases()` 把 recovery_pending 精确转为 uncertain、code 为 `APP_RESTART_RESULT_UNKNOWN`，且 worker 绝不自动重发。

preparing pause另做独立fake-clock矩阵：`credential_refresh`的releaseClaim在1.999秒明确成功、2.000秒同tick success、永久pending且DB未提交、DB已提交但response丢失；`local_service_unavailable`的markRetryNotSubmitted执行同一四组边界。再把每组与`stop()`、Controller shutdown同tick排列，断言active settlement/gateway写调用恰好一次、mutation chain在500ms内交接、Worker/Controller在原8秒deadline内返回同一settled或recovery_pending结果，config/vault/client/下一claim及破坏性步骤调用数为零。deadline后的late success/reject只能命中失效generation并产生零continuation/二写；完整重启分别验证pending保持、未过期preparing不动但到期后唯一重领，且Telegram send调用始终为零。

claim gate另做同步barrier矩阵：空闲/30秒timer正到点时`blockNewClaims`必须在同tick使后续claimNext=0；claimNext已发出但未返回时关闭gate，随后返回null或真实claim都不得stat/send/写终态，已提交preparing只在lease到期后由新generation重领。每个有效token只可在`reopenClaims`与`sealClaimsBlocked`中二选一消费恰好一次；reopen恰好合并一次wake，seal后所有resume/state-event/reconcile的claim/wake均为0；重复关闭、stale/伪造/重复token全部抛稳定内部错误且gate保持原状态。普通`pause("credential_refresh")`不改变tokenized gate，settled后可按既有真值resume；destructive路径关闭gate后必须先seal，再调用`pause("configure_result_unknown")`复用现有active settlement并在原8秒deadline内收敛，不得打开gate或新增claim。

upload watchdog测试用参数化0B/1B/2_000_000_000B断言公式与30分钟/48小时clamp；本地服务health/TCP持续ready但首个send Promise永久不settle时，fake clock到动态deadline前1ms仍每30秒续租且第二条未claim，到deadline恰好abort并在2秒内写`uncertain/NETWORK_RESULT_UNKNOWN`、清全部timer/listener，随后第二条可发送成功。近2GB请求在动态deadline前1ms返回明确成功不得被提前abort，尤其30秒处仍运行；deadline与response同tick由watchdog唯一胜出且late response零写。再让markUncertain永久挂起，断言2秒后worker paused、warning为`ACTIVE_DELIVERY_RECOVERY_PENDING`、下一条不claim，完整重启后startup recovery才转`APP_RESTART_RESULT_UNKNOWN`。

再对上述七个 post-submission 状态方法做表驱动 response-loss 测试：每项分别注入“事务未提交即失败/永久挂起”和“事务已提交但 response 丢失”。两类都必须在2秒内paused、generation失效、两个recovery latch均为true、timer/listener清零、终态方法调用数恒为1、下一条claim/send为0；之后直接调用旧Worker的start/resume/wake均为零操作，pause/stop恒返exact keys `{state,deliveryId}`、state为recovery_pending且deliveryId逐字等于最初触发记录，gateway调用数不增。完整重启后，未提交的sending只转一次`uncertain/APP_RESTART_RESULT_UNKNOWN`，已提交的sent/skipped/retry_wait/failed/uncertain逐字段保持且绝不再发送。至少以真实oversize通知覆盖`markSkippedOversize`、以真实文件成功覆盖`markSent`，并让恢复回调同步读取Worker状态证明无自等待。

`markSending`边界另做表驱动测试：首次video/audio/document/oversize与fallback更新都分别注入no-commit reject/永久挂起及commit-before-response-loss。首次边界失败时四种client send调用总数均为0；fallback只允许已完成且明确返回media error的首个media调用，后续sendDocument为0。再在boundary未settle时并发stop/pause，分别覆盖no-commit、commit-before-response与success/stop同tick；同tick固定stop胜出，迟到success也必须零send、零releaseClaim、零第二次mark，单一latch保留原deliveryId并在8秒内返回recovery_pending。每项都在2秒内设置两个latch、direct IPC mutation为0且不二写markSending；重启后no-commit preparing只在lease到期安全重领，committed sending只转`APP_RESTART_RESULT_UNKNOWN`，两类都没有boundary之后的Telegram发送。

- [ ] **Step 7: 跑定向和 Electron 回归**

```powershell
npm.cmd --prefix desktop test -- sidecar.test.ts sidecarGateway.test.ts deliveryWorker.test.ts
npm.cmd --prefix desktop test
```

Expected: PASS。

- [ ] **Step 8: Commit**

```powershell
git add desktop/electron/sidecar.ts desktop/electron/sidecar.test.ts desktop/electron/telegram/sidecarGateway.ts desktop/electron/telegram/sidecarGateway.test.ts desktop/electron/telegram/deliveryWorker.ts desktop/electron/telegram/deliveryWorker.test.ts
git commit -m "feat(electron): add reliable telegram delivery worker"
```

---

### Task 10: 编排 Bot 绑定、发现、验证、断开与窄 IPC

**Files:**
- Modify: `desktop/electron/sidecar.ts`
- Modify: `desktop/electron/sidecar.test.ts`
- Create: `desktop/electron/telegram/controller.ts`
- Create: `desktop/electron/telegram/controller.test.ts`
- Create: `desktop/electron/telegram/ipc.ts`
- Create: `desktop/electron/telegram/ipc.test.ts`
- Modify: `desktop/electron/preload.ts`
- Modify: `desktop/electron/main.ts`
- Modify: `desktop/renderer/vite-env.d.ts`

- [ ] **Step 1: 写首次绑定、账户替换和同账户凭据刷新顺序失败测试**

没有现有账户的首次绑定，以及明确确认的不同账户替换，成功顺序必须精确为：

```text
validate bind schema
supervisor.start
cloud.getMe
cloud.deleteWebhook(drop_pending_updates=false)
sidecar.configure(migration_state=logout_started)
cloud.logOut
sidecar.configure(migration_state=cloud_logged_out)
local.getMe
vault.save
sidecar.configure(account metadata only, migration_state=idle)
worker.start
```

任一步失败都不能报告 connected；`vault.save` 之前失败不得留下凭据。`logout_started` 必须在 `cloud.logOut` 前持久化；明确成功后改为 `cloud_logged_out`，明确失败则清回 `idle`，超时/连接断开保持 `logout_started`。如果 local getMe 失败或应用在迁移中退出，UI 保留/重新要求用户输入 Token；下一次 bind 看到同 account 的非 idle marker 时先尝试 local getMe，成功即继续保存，失败则显示可恢复等待状态，不重复 cloud logOut。不同 account ID 且未确认时，必须在 deleteWebhook/logOut 之前返回 `requiresAccountReplacement=true`。确认更换时，取得Controller mutation mutex并重读current truth后的第一项同步动作是对现有worker调用`blockNewClaims()`；它不是持久/外部mutation。第一项持久mutation仍必须在 Task 2 writer fence 中原子执行 `configure({autoSendEnabled:false,deliveryRecoveryHold:{accountId:oldAccount,intent:"replace_account",createdAt:now}})`。该调用走下述configure真值协调：只有返回配置匹配expected truth后才以原token调用`sealClaimsBlocked`，然后才允许worker.stop/cancel/deleteWebhook/logOut/Supervisor stop/workDir/vault/新 Bot 操作；pre-commit或持terminal proof回读before时先完成既定rollback，再以原token唯一`reopenClaims`并按旧真值恢复；无proof、第三真值或不可用时以原token唯一`sealClaimsBlocked`，await同一worker唯一`pause("configure_result_unknown")`收敛active后latch退出，getConfig调用数按下述规则为0且其他副作用为零。该 hold commit 是“旧账号不再产生新 delivery”的跨进程线性化点，之后才允许 `worker.stop()`。返回 `recovery_pending` 时立即以稳定 `ACTIVE_DELIVERY_RECOVERY_PENDING` 结束换绑，hold 原样持久化且其余 mutation 为零；当前 worker 已进入终态，不能在同一 Controller 内把旧结果升级为 `settled`。用户必须完整退出并重新启动百纳应用，由全新的 Sidecar 启动期 `recover_delivery_leases()` 把旧 `sending` 收敛为 `uncertain`；新 Controller 读取 hold 后绝不构造/启动/resume/wake worker，只允许重试同一个换 Bot 操作。重试时 hold 的 account/intent 必须与当前持久 account 和本次操作精确匹配，匹配后因 worker 必为空而从 cancel 阶段继续；缺失、错 account 或错 intent 均 fail closed。只有 stop settled 或持久 hold 重试路径才能取消旧 account 未开始记录、从旧 local session 注销、停止并清理旧 workDir，再重启 supervisor 迁移新 Bot，同时清空旧 target/discovery/next update offset。成功保存新 Token 后，最终 config update 必须同时写新 account metadata、`migrationState=idle`、`deliveryRecoveryHold=null`；`settled_result_unknown`才按expected truth/before配置回读：expected则保留新密文并只创建一个新worker，before才回滚新密文并保留hold；无terminal proof、第三真值或回读不可用都保留candidate密文、不建worker并latch重启。任何结果都不得形成新account config+旧vault或清hold后再恢复旧密文。

Controller 只允许一把进程内 mutation mutex，不能保留独立 bind/disconnect/retry 锁。`bindToken`（含同Bot刷新与换Bot）、`disconnect`、`discoverTargets`、`selectTarget`、`sendTest`、`setAutoSend` 与 `retryDelivery` 都从入口到最后一次 config/vault/queue/worker mutation 全程持有同一把锁；`getStatus/listDeliveries` 保持只读。Controller构造时`deliveryRecoveryPending=false`；Worker recovery callback只能同步把它单向置true。每个mutation取得锁后的第一项检查就是该latch：为true时立即返回`ACTIVE_DELIVERY_RECOVERY_PENDING`，在任何`gateway.getConfig/configure`、vault、Supervisor、client、worker、queue或文件操作前结束；getStatus/listDeliveries仍只读可用。latch为false才重新`gateway.getConfig()`，核对当前account、strict hold、vault/worker generation，再决定是否继续，绝不能复用排队前缓存的状态；因此已经越过入口检查但尚未获锁的旧调用也会看到disconnect/replace后的真值。`shutdown()` 第一项同步动作是永久关闭mutation gate、拒绝所有等待者，并以同一个shutdown signal使当前持锁操作停止接受新的外部步骤；必须 await其串行chain收敛后才进入worker.stop，晚回调因generation失效零config/vault/queue/worker写入。已有账户时先严格解析 Bot Token 冒号前的十进制 bot ID；格式非法直接拒绝。若该 ID 等于持久化 account ID，必须走以下本地凭据刷新，cloud client spy 的 `getMe/deleteWebhook/logOut` 调用数都为 0：

```text
if worker exists: worker.pause("credential_refresh") and await active settlement
assert absent worker or pause result is settled; recovery_pending aborts refresh before service start/getMe
endpoint = await supervisor.start()  # idempotent for stopped/starting/ready/failed
candidateLocal = createClient(endpoint, candidate token)
candidateLocal.getMe
assert returned account ID equals persisted account ID
vault.save(candidate token)
sidecar.configure refreshed username while preserving target/discovery/offset/enabledAt
create replacement local client and worker with candidate token
replacement worker.start/resume/wake
```

Controller的所有`gateway.configure`都必须先以fresh before+strict patch调用`buildTelegramConfigureExpectedTruth`，再经过唯一`reconcileConfigureResult(beforeConfig, expectedTruth, vaultDisposition, preblockedClaimGateToken)`；不能由各流程自行catch后反向覆盖。最后一个参数只允许replace/disconnect在configure前已经取得的当前`TelegramWorkerClaimGateToken`，其余调用固定传null。builder只有两个分支：普通patch按Sidecar同一规范化规则生成完整`kind="exact"`；仅当before为`autoSendEnabled=false/enabledAt=null`且patch显式把autoSendEnabled改为true时，生成`kind="server_generated_enabled_at"`，其`expectedWithoutEnabledAt`包含除enabledAt外全部最终字段且autoSendEnabled必须true。上面的`TelegramConfigureBoundaryResult`是Main-only内部合同，不进入preload/Renderer：`committed`只表示收到strict成功config，并不绕过expected-truth匹配；`pre_commit_rejected`只允许gateway在本地patch schema失败或尚未调用`transport.request`的pre-send阶段返回，且transport调用数必须为0。收到同request ID的唯一terminal frame后，只要没有strict成功config——包括`SidecarProtocolError`、invalid payload或测试注入的gateway到Controller结果丢失——gateway就在同一JS turn创建冻结的`ConfigureHandlerSettledProof`并返回`settled_result_unknown`；proof的brand、绑定request generation与single-use状态只存在模块私有Symbol/闭包/WeakSet，`consume()`只在原generation仍current且首次调用时返回true，JSON/structured-clone后无法保留brand或恢复有效proof。其中`safeErrorCode`只可复制已过滤的protocol code，不能据此声称未提交。timeout、transport disconnect、永久pending或根本没有terminal frame一律返回`in_flight_or_disconnected_unknown`。gateway以`absoluteDeadlineMs`竞争唯一transport request，deadline同tick固定deadline胜；底层promise晚结果只经失效generation observer丢弃，绝不重新分类或触发Controller continuation。

`reconcileConfigureResult`先把`committed.config`作为terminal observed truth执行同一matcher，不能盲目成功；对`pre_commit_rejected`才执行该流程既定的pre-commit rollback/hold规则并返回其已过滤`safeErrorCode`。只有`settled_result_unknown`且当前mutation generation仍有效、`proof.consume()`恰好返回一次true时，才在本次mutation deadline内以最多2秒调用一次`gateway.getConfig()`；terminal frame证明原handler已经结束，因此该读取严格排在原configure之后。proof为false、重复消费或generation已失效一律按无proof处理。`exact`要求observed完整DTO的canonical bytes逐字等于config；`server_generated_enabled_at`要求observed去掉enabledAt后逐字等于expectedWithoutEnabledAt，且enabledAt是strict有效、非null、规范UTC ISO时间，before.enabledAt必须仍为null。匹配expected truth时忽略先前error并按成功继续；observed逐字等于`beforeConfig`时才rollback/保hold，并返回result的非null`safeErrorCode`，null则稳定降为`OPERATION_FAILED`；exact truth与before canonical bytes本来相同则固定视为desired truth成功并保留candidate vault。任何同时命中before/expected的歧义只允许该exact-idempotent分支；其余合法但不匹配的配置都是第三真值。`in_flight_or_disconnected_unknown`绝不能在旧进程调用getConfig；它与settled回读不可用、strict失败或第三真值统一进入`quiesceWorkerForConfigureUnknown(preblockedClaimGateToken)`：若当前worker不存在则直接完成；若参数非null，只接受仍属于当前worker/current generation且尚未消费的token；否则同步调用当前worker的`blockNewClaims()`取得唯一token。helper随后必须在同一JS turn以该token调用`sealClaimsBlocked`，再`await`该worker唯一`pause("configure_result_unknown")`；pause/stop复用既有active settlement与原8秒deadline，晚claim/发送/状态写按Worker generation门禁丢弃。只有worker已不存在或该pause settlement完成后，才保持当前刚完成的vault动作（refresh/replace已save的candidate Token不回滚，disconnect已clear的vault不恢复）、禁止任何新config/vault/worker写，单向设置Controller `deliveryRecoveryPending=true`并返回`ACTIVE_DELIVERY_RECOVERY_PENDING/restart_app`。helper的block/seal/pause任一步不得被catch后继续正常流程；若shutdown同tick到达，只把同一个pause settlement的await所有权按既有规则转给`worker.stop()`，不能重开gate或发第二次gateway mutation。新进程在旧Sidecar整树结束并完成startup recovery后只按磁盘config+vault/local getMe+hold真值恢复；旧进程不得猜测commit结果。

该helper同样覆盖replace/disconnect起始的hold+disable、migration marker、target/discovery/offset、auto-send与最终clear-hold/clear-account等每一处configure。除唯一false→true enabledAt分支外，`expectedTruth`必须是从锁内fresh `beforeConfig`应用strict patch得到的完整DTO；比较禁止只看account/hold或某个字段，也禁止把任意非null时间当成expected。settled-result回读observer与in-flight transport observer都绑定当前mutation generation；shutdown或deadline后的迟到值零config/vault/worker continuation。任何配置写调用点绕过该helper、无终态证明就getConfig、在unknown上恢复旧密文、清hold、反向写JSON，或在unknown/第三真值后未完成上述worker quiescence就返回，都使测试失败。preblocked token只可由同一helper在expected时seal、before/pre-commit时reopen、unknown时交给`quiesceWorkerForConfigureUnknown` seal；四路之外不得泄漏、缓存或重复消费。

本地 candidate 明确 auth failure、超时、Supervisor start/ready失败或服务错误都不得回退云端，尤其不能绕过 10 分钟 cloud logOut 窗口。`pause()` 返回 `recovery_pending` 时立即以稳定 `ACTIVE_DELIVERY_RECOVERY_PENDING` 结束绑定，不能继续启动服务、candidate `getMe`、写 vault 或替换 worker；旧 worker 保持 paused，待 Sidecar recovery 与用户重试后再进入同一 mutex。vault为空的迁移恢复、worker尚未构造，以及Supervisor处于stopped/failed都必须走同一幂等`start() → ready endpoint → local getMe`路径；不得读取“current endpoint”或假设已有worker。`vault.save` 前的其他失败只在旧worker存在时恢复它；保存后的configure只有明确`pre_commit_rejected`或`settled_result_unknown`消费终态proof后回读逐字等于before时才恢复旧密文（原先为空则重新clear）和可选旧client/worker。终态proof回读等于expected时保留candidate密文并继续构造唯一replacement worker；无proof、回读不可用或第三真值时按上句latch退出，绝不恢复旧密文、调用getConfig或构造任何worker。worker rebuild本身在config已明确等于expected后失败时也不得把config/vault反向拆开，只保留candidate真值并进入可重启恢复状态。队列、target、discovery、update offset 与 enabledAt 全部保留。测试覆盖vault-null marker、worker-null、Supervisor stopped/failed/starting/ready、start失败与10分钟窗口内cloud三方法调用恒为零。只有 token bot ID不同或当前没有持久account且没有同account migration marker时，才允许进入上述 cloud migration/replacement流程。

- [ ] **Step 2: 写发现、测试、断开和退出失败测试**

- UI 的每次“刷新接收位置”都用短轮询：`getUpdates` 固定传 `timeoutSeconds:0`，只请求 `message/channel_post/my_chat_member`，chat ID 始终字符串化并按 ID 去重；禁止把 Telegram 30 秒 long-poll 与 client 的 30 秒 metadata deadline 放在同一边界竞速。Task 8/10 测试必须断言参数恰为0，空 batch 在metadata deadline内正常返回而不是 timeout。
- 持久字段只叫 `telegram_next_update_offset` / `nextUpdateOffset`，含义是下一次请求要传的 offset，不保存“最后 ID”。`getUpdates` 的 raw text 必须先走 Task 8 `parseTelegramResponseLossless`；每批 updates 再把每个已保留为规范十进制字符串的 `update_id` 解析为 `BigInt`、完整解析并原子保存去重后的 chat cache，最后把 `max(update_id)+1n` 的十进制字符串与 cache 放在同一次 config 更新中提交；配置写失败时两者都不推进。空 batch 保持原 offset；重复 batch 不回退；畸形/负数 ID 整批拒绝。测试固定覆盖 `42 → 43`、相邻 `9007199254740992/9007199254740993`、重复 batch、乱序 batch、重复 key、负数/小数/指数 ID 与 config write fault，禁止在 lossless parser 或 Controller 中把 ID 转成 JS `number`。
- `selectTarget` 只接受当前 account 已发现 cache 中的完整匹配项；Renderer 伪造 chat ID、title 或 type 必须在发送测试前被拒绝。
- target 测试消息成功后先调用 `clearTargetBlock(accountId,targetId)`，再写 `telegram_target_verified_at`；换 target 立即清空 verified_at 并关闭自动发送。
- 自动发送只有 connected + target + verifiedAt 时可开启。
- 断开在取得mutation mutex并重读current truth后也先对现有worker同步`blockNewClaims()`，第一项持久mutation才是在 writer fence 中原子执行 `configure({autoSendEnabled:false,deliveryRecoveryHold:{accountId:currentAccount,intent:"disconnect",createdAt:now}})`。只有observed匹配expected truth才以原token调用`sealClaimsBlocked`，然后允许worker.stop及后续副作用；pre-commit/回读before先按旧真值用token唯一reopen且副作用为零；无proof/第三真值/不可用以原token唯一seal，await唯一`pause("configure_result_unknown")`后latch重启且不得getConfig。成功顺序固定为 worker.stop 收敛 active claim → cancel pending/preparing/retry_wait → local deleteWebhook → local logOut → supervisor.stop → containment check 后清理 bot 工作目录 → vault.clear → Sidecar 原子清空 account/target/discovery 并写 `deliveryRecoveryHold=null`。只有 `worker.stop()` 返回 `settled` 才能进入 cancel 及其后的破坏性步骤；返回 `recovery_pending` 时立即以 `ACTIVE_DELIVERY_RECOVERY_PENDING` 结束断开，hold 与旧 account/target/discovery/vault/workDir/records 原样保留，其余副作用为零，也不得复用这个已终止 worker。用户必须完整退出并重新启动百纳应用；全新的 Sidecar 先完成 lease recovery，新 Controller 看到匹配的 disconnect hold 后不构造 worker，只允许用户重试断开并从 cancel 阶段继续。最终config clear只有`settled_result_unknown`可回读完整配置：expected clear真值按成功完成且vault保持已clear；before真值保留disconnect hold、vault仍保持已clear且不建worker，供下一次从已完成步骤幂等继续；无terminal proof、第三真值或回读不可用同样不反向恢复config/vault，只latch重启。任何分支都不得盲目清hold或重建worker。
- local logOut 失败仍完成本地断开，并返回“其他服务可能需要等待”的非秘密 warning。
- 应用重启时 `initialize()` 先读完整非秘密 config，再从 vault 读取密文 Token，启动本地服务并用 local `getMe` 复核 account ID。`deliveryRecoveryHold=null` 时，身份成功才恢复 worker，失败进入 `reauth_required` 且保留队列，不自动执行新的云端迁移。hold 非空时必须先校验 strict DTO 与 account 匹配，发布 `ACTIVE_DELIVERY_RECOVERY_PENDING`，可以为后续幂等清理准备 Supervisor/local client，但 `createWorker/start/resume/wake/claimNext/send*` 调用数恒为0；除 getStatus/listDeliveries 和 hold.intent 对应的换 Bot 或断开操作外，其余变更操作都返回同一稳定 code。hold 只能由对应操作的最终 writer-fenced config commit 清除，启动过程绝不自动清理。
- local `getMe` 成功后，`initialize()` 必须调用 `getTargetBlock(currentAccount,currentTarget)`；命中时恢复 `TARGET_INVALID` warning 并保持 worker paused。新 output-ready 已由 store 直接落 failed；清除 block 不自动重试旧 failed 记录。
- 应用在 `logout_started` 或 `cloud_logged_out` marker 下重启且 vault 尚无 Token 时显示 `MIGRATION_RECOVERY_REQUIRED`；用户重新输入同 Bot Token 后先尝试 local getMe。测试用可控时钟覆盖 Telegram 规定的 10 分钟窗口，期间不得回退调用 cloud getMe/logOut。超过 `migrationRetryAt` 且 local 仍失败时返回 `canRestartMigration=true`；只有用户再次确认并传 `restartMigrationConfirmed=true` 才清 marker、重新走 cloud 流程。
- app quit 顺序：Main 唯一编排 `controller.shutdown` 停止领取并收敛当前发送 → `supervisor.stop` 停本地服务 → `sidecar.stop` 停 Sidecar → 允许退出；即使前一步 reject 也继续后续 cleanup，最终没有残留 child process。Controller app-shutdown 不得自行 stop Supervisor 或 Sidecar。
- worker 报 `AUTH_INVALID` 或 target block 时，Controller 必须立刻广播 `telegram:status`；preload schema 拒绝含 token、filePath、lease 或 raw error 的 status event。
- worker 报 `ACTIVE_DELIVERY_RECOVERY_PENDING` 时同样先同步设置Controller的`deliveryRecoveryPending=true`，再立刻广播status并保持paused，把`recoveryAction`设为`restart_app`。没有 destructive hold 的 watchdog/普通 shutdown recovery 只能由新的应用进程在startup lease recovery完成并安全重建 worker后同时清除warning、把action改回null；旧Controller/Worker的两个latch都没有clear API。换 Bot/断开 hold 路径在新进程中仍保持该warning、不构造worker，并分别把action设为`retry_replace_account/retry_disconnect`，直到对应操作最终清除hold。当前Controller不得自行改回connected或resume。
- 401 callback 只在 Worker 已 `markRetry`、清 active 并自置 paused 后把 connection 改为 `reauth_required` 和广播；Controller 绝不能在该 callback 对同一 worker 调 `pause()`，避免自等待死锁。
- 把 Sidecar 的四个结构化 queue error、Controller 的四个稳定 error（含 `LOCAL_PROCESS_RECOVERY_REQUIRED`）、Zod invalid input 和一个未知异常逐一走完 Gateway → Controller → Main handler → preload；断言 code/messageKey 保持精确、Supervisor 两个内部 stale-process 原因都收敛为同一个用户级 code、未知值降为 `OPERATION_FAILED`，所有 Renderer 结果都没有 PID、argv、路径、raw message/stack/cause/details/secret。
- 换 Bot 与断开各注入一次 hold writer fence 失败及 `worker.stop() → recovery_pending`：前者必须零 stop/副作用，后者必须返回 `ACTIVE_DELIVERY_RECOVERY_PENDING`并只留下 strict 非秘密 hold + disabled config，旧 account/target/discovery/vault/workDir 与 pending/retry records 原样保留，local deleteWebhook/logOut、Supervisor stop、新 Bot start 的调用数全为0；同一 Controller 的第二次调用仍 fail closed，绝不能把终态 worker 的旧结果改报 settled。随后完整退出并重新启动百纳应用，测试销毁旧 Controller/Worker、启动全新的 Main/Sidecar/Controller，断言 `app.ready` 前把旧 sending 转为 `uncertain/APP_RESTART_RESULT_UNKNOWN`，并在用户可交互前推进 fake clock/queue event，证明新进程 createWorker/claim/send 始终为0、hold warning仍在。只有用户重试匹配操作后才按唯一顺序 cancel/cleanup/原子清hold；错 intent/account、清hold commit failure与操作中途强杀都不得启动worker或丢hold。
- 换 Bot 的 settled 路径在 hold+disable fence commit 后、`cancel_pending(oldAccount)` 返回前阻塞，再让独立 CLI 完成下载；断言 CLI 看到 disabled+hold且不创建旧 account delivery，cancel 返回后旧 pending/retry为零。另注入 config JSON replace/DB fence commit 失败，断言 stop/cancel/deleteWebhook/logOut/Supervisor stop/workDir cleanup/vault save与新 Bot start均为0；最终清hold失败则新worker为0、重启后仍进入匹配重试。持久 hold、status/event/日志必须逐字段证明不含 Token、API ID/hash、路径、PID、raw error。
- 对同Bot refresh、换Bot最终写新account+clear hold、disconnect最终clear account+hold三条路径分别注入：`pre_commit_rejected`；已收到terminal frame但Controller前丢结果的`settled_result_unknown`，随后getConfig分别为expected truth、before、不可用与第三真值；以及原configure永久挂起、commit后response完全丢失、transport disconnect三种`in_flight_or_disconnected_unknown`。settled回读expected只能保留candidate vault（disconnect保持clear）并按成功收敛，before才执行该流程既定rollback/保hold；无proof路径必须断言getConfig调用数为0，保持candidate vault动作并latch+restart。再对`setAutoSend(true)`从false/null开始覆盖committed与settled-result两路：除enabledAt外逐字段匹配且enabledAt为新规范UTC才是expected，before与错字段/null/非UTC时间都是各自固定分支；禁止Main预先猜时间。逐点断言绝不出现`new account config + old token`、`old account无hold + new token worker`或`cleared config + restored old vault`，同Bot exact before/expected canonical bytes相同时固定保留已验证candidate token。用barrier让无proof分支返回后原configure再迟到commit，并让两类observer分别与shutdown同tick；旧Controller的迟到configure/getConfig结果必须零continuation，新进程在旧Sidecar树归零后按磁盘config+vault/local identity/hold恢复唯一安全状态。通用quiescence矩阵还要对普通`setAutoSend(false/true)`、换target、发现cache/offset、migration marker分别让idle timer正到点、claimNext在途、active preparing、active sending与shutdown同tick命中unknown/第三真值：worker存在时必须恰好一次block→seal→同一pause settlement，unknown线性化后claim/send恒为0、迟到claim为0、delivery状态写恰好一次；worker不存在时零gate调用。完整重启只按实际config/DB真值恢复，不得沿用旧token或旧Controller latch。
- 对换Bot/断开起始hold另做worker barrier：idle timer与即将发出的claim同tick时，`blockNewClaims`必须先胜且hold请求前后claim/send=0；claimNext已在途时让hold分别得到expected、before与无proof，迟到claim在三路均零send，before只经原token reopen并在旧lease到期后唯一重领，expected与no-proof都先以原token seal，前者进入同一stop、后者唯一pause收敛active。再让hold configure迟到commit与pause/stop/shutdown同tick，断言旧worker新claim/send恒为0、release/mark写不重复、Controller在既有deadline内返回restart action；token在reopen/seal中只能二选一消费，stale/重复/伪造gate token与state-event reconcile都不能重开sealed gate。
- 用直接 Main IPC 与两个可控 barrier 验证 mutation mutex：其一让 disconnect 在 `cancelPending` 后暂停，同时提交旧delivery的 `retryDelivery`，后者必须等disconnect最终清config/vault/hold后才获锁并稳定失败，不能重建旧pending；其二让 disconnect 与同Bot credential refresh/换Bot并发，败者重读真值后不得save vault、启动Supervisor/worker或覆盖新配置。再对`markSent`与`markUncertain`各注入一次post-submission持久失败；callback返回后直接并发调用同Bot刷新、换Bot、disconnect、selectTarget、setAutoSend与retryDelivery，全部必须在读取config前返回`ACTIVE_DELIVERY_RECOVERY_PENDING`，Supervisor/vault/worker/queue/config副作用与ready/queued事件触发的resume/wake/claim均为0，旧worker.stop仍为recovery_pending。另覆盖queued operation遇shutdown全部拒绝、active operation generation失效后的late getMe/config completion零写入；最终始终是完整旧状态或完整新状态，绝无“空vault+旧account”“无account+活worker”混合。只有销毁旧Controller/Worker并由新Sidecar完成startup lease recovery后，新Controller的latch才为false并按数据库真值恢复。

- [ ] **Step 3: 确认失败**

```powershell
npm.cmd --prefix desktop test -- sidecar.test.ts controller.test.ts ipc.test.ts
```

Expected: FAIL，controller 与 IPC 尚不存在。

- [ ] **Step 4: 实现 Controller 的公开接口**

```ts
export interface TelegramController {
  initialize(): Promise<TelegramStatus>;
  getStatus(): Promise<TelegramStatus>;
  bindToken(input: TelegramBindInput): Promise<TelegramBindResult>;
  disconnect(): Promise<TelegramStatus>;
  discoverTargets(): Promise<TelegramTarget[]>;
  selectTarget(target: TelegramTarget): Promise<TelegramStatus>;
  sendTest(targetId: string): Promise<{ ok: true }>;
  setAutoSend(enabled: boolean): Promise<TelegramStatus>;
  listDeliveries(query: TelegramDeliveryQuery): Promise<TelegramDeliveryPage>;
  retryDelivery(id: string, confirmPossibleDuplicate: boolean, confirmInterruptedOutput: boolean): Promise<TelegramDeliverySummary>;
  handleSidecarEvent(event: ProtocolEvent): void;
  handleSidecarStateChange(event: SidecarStateChange): Promise<void>;
  shutdown(): Promise<TelegramWorkerStopResult>;
}

export interface TelegramCredentialVaultPort {
  load(): Promise<string | null>;
  save(token: string): Promise<void>;
  clear(): Promise<void>;
  exists(): Promise<boolean>;
}

export interface TelegramSupervisorPort {
  start(): Promise<TelegramBotApiEndpoint>;
  health(): Promise<boolean>;
  stop(): Promise<void>;
  getState(): SupervisorState;
  onStateChange(listener: (event: TelegramSupervisorStateChange) => void): () => void;
}

export interface SidecarStopResult {
  state: "stopped" | "unconfirmed";
  pid: number | null;
}

export type SidecarRecoveryPreflightResult =
  | { ok: true }
  | {
      ok: false;
      code: "LOCAL_PROCESS_RECOVERY_REQUIRED";
    };

export type SidecarStartResult =
  | { ok: true }
  | {
      ok: false;
      code: "LOCAL_PROCESS_RECOVERY_REQUIRED";
    };

export interface SidecarStateChange {
  sequence: number;
  state: "starting" | "ready" | "restarting" | "failed" | "stopped";
  reason: "start" | "unexpected_exit" | "restart_ready" | "intentional_stop" | "process_recovery_required";
  failureCode: null | "LOCAL_SERVICE_UNAVAILABLE" | "LOCAL_PROCESS_RECOVERY_REQUIRED";
}

export interface SidecarStateSubscription {
  current: SidecarStateChange;
  unsubscribe(): void;
}

export interface SidecarLifecyclePort extends SidecarRequestTransport {
  preflightRecovery(): Promise<SidecarRecoveryPreflightResult>;
  start(): Promise<SidecarStartResult>;
  stop(): Promise<SidecarStopResult>;
  forceStop(): Promise<SidecarStopResult>;
  subscribeWithSnapshot(listener: (event: SidecarStateChange) => void): SidecarStateSubscription;
}

export class SidecarProcess extends EventEmitter implements SidecarLifecyclePort {
  preflightRecovery(): Promise<SidecarRecoveryPreflightResult>;
  start(): Promise<SidecarStartResult>;
  stop(): Promise<SidecarStopResult>;
  forceStop(): Promise<SidecarStopResult>;
  subscribeWithSnapshot(listener: (event: SidecarStateChange) => void): SidecarStateSubscription;
  request(method: string, payload: Record<string, unknown>): Promise<unknown>;
}

export interface SidecarLifecycleDeps {
  spawnContainedProcess(
    executable: string,
    args: readonly string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; shell: false; detached: boolean; windowsHide: true },
  ): Promise<TelegramSpawnedProcess>;
  captureContainedProcessTree(candidate: ContainedProcessCandidate, generationId: string): Promise<ProcessTreeHandle | null>;
  restoreProcessTree(snapshot: ProcessTreeSnapshot): ProcessTreeHandle;
  refreshProcessTree(
    handle: ProcessTreeHandle,
    persist: PersistProcessTreeSnapshot,
  ): Promise<ProcessTreeSnapshot>;
  waitForProcessTreeExit(
    handle: ProcessTreeHandle,
    timeoutMs: number,
    persist: PersistProcessTreeSnapshot,
  ): Promise<ProcessTreeOperationResult>;
  terminateAndWaitProcessTree(
    handle: ProcessTreeHandle,
    options: ProcessTreeTerminationOptions,
    persist: PersistProcessTreeSnapshot,
  ): Promise<ProcessTreeOperationResult>;
  inspectProcess(pid: number): Promise<TelegramOwnedProcessInfo | null>;
  findOwnedProcessCandidates(query: ProcessLaunchCandidateQuery): Promise<readonly ContainedProcessCandidate[]>;
  ownerStore: ProcessOwnerStateStore<"sidecar">;
  nowIso(): string;
  randomId(): string;
  log(level: "warn" | "error", safeMessage: string): void;
}

export type TelegramClientFactory = (
  location: TelegramApiLocation,
  botToken: string,
) => TelegramBotApiClientPort;

export type TelegramWorkerFactory = (input: {
  gateway: TelegramSidecarGatewayPort;
  client: TelegramBotApiClientPort;
  accountId: string;
  callbacks: TelegramWorkerCallbacks;
}) => TelegramDeliveryWorkerPort;

interface TelegramControllerSharedDeps {
  publishDelivery(event: TelegramDeliveryEvent): void;
  publishStatus(event: TelegramStatusEvent): void;
}

export type TelegramControllerDeps =
  | (TelegramControllerSharedDeps & {
      mode: "normal";
      initialFailureCode: null;
      supervisor: TelegramSupervisorPort;
      vault: TelegramCredentialVaultPort;
      gateway: TelegramSidecarGatewayPort;
      createClient: TelegramClientFactory;
      createWorker: TelegramWorkerFactory;
      nowIso(): string;
      cleanupBotWorkDir(): Promise<void>;
    })
  | (TelegramControllerSharedDeps & {
      mode: "core_degraded";
      initialFailureCode:
        | "LOCAL_PROCESS_RECOVERY_REQUIRED"
        | "LOCAL_SERVICE_UNAVAILABLE";
      supervisor: null;
      vault: null;
      gateway: null;
      createClient: null;
      createWorker: null;
      nowIso: null;
      cleanupBotWorkDir: null;
    })
  | (TelegramControllerSharedDeps & {
      mode: "telegram_runtime_degraded";
      initialFailureCode: "LOCAL_SERVICE_UNAVAILABLE";
      supervisor: null;
      vault: null;
      gateway: TelegramSidecarGatewayPort;
      createClient: null;
      createWorker: null;
      nowIso: null;
      cleanupBotWorkDir: null;
    });

export class DefaultTelegramController implements TelegramController {
  constructor(deps: TelegramControllerDeps);
  initialize(): Promise<TelegramStatus>;
  getStatus(): Promise<TelegramStatus>;
  bindToken(input: TelegramBindInput): Promise<TelegramBindResult>;
  disconnect(): Promise<TelegramStatus>;
  discoverTargets(): Promise<TelegramTarget[]>;
  selectTarget(target: TelegramTarget): Promise<TelegramStatus>;
  sendTest(targetId: string): Promise<{ ok: true }>;
  setAutoSend(enabled: boolean): Promise<TelegramStatus>;
  listDeliveries(query: TelegramDeliveryQuery): Promise<TelegramDeliveryPage>;
  retryDelivery(id: string, confirmPossibleDuplicate: boolean, confirmInterruptedOutput: boolean): Promise<TelegramDeliverySummary>;
  handleSidecarEvent(event: ProtocolEvent): void;
  handleSidecarStateChange(event: SidecarStateChange): Promise<void>;
  shutdown(): Promise<TelegramWorkerStopResult>;
}
```

Main production `createClient` 必须逐字装配 `new TelegramBotApiClient(location, botToken, electronNetFetch, PRODUCTION_TELEGRAM_REQUEST_TIMEOUTS, telegramClientLogger)`，cloud/local client使用同一冻结常量；测试/开发覆盖只能通过显式依赖注入，不能从环境变量、普通设置或平台默认值改变这两个语义。Controller持有的Supervisor `start()`在stopped/starting/ready/failed均幂等：并发调用共享同一generation Promise，ready直接返回当前endpoint，failed只有旧树已确认收敛后才允许新generation；因此vault-null迁移恢复可在没有worker/client时安全取得endpoint。

`SidecarLifecyclePort` 与 `SidecarStopResult` 是 Electron Main 私有的进程收敛合同；其中 `pid` 只允许 Main 用来关联同一个受 containment 保护的 handle、记录不含路径/argv的本机诊断并决定是否调用 `forceStop()`，不得传入 Controller status、BrowserWindow event、preload schema 或 Renderer IPC envelope。Renderer-facing 类型没有 `pid` 字段。

`SidecarProcess.start()` 只有在当前 generation 的 `hello` 与唯一合法 `app.ready` 都通过 schema/顺序校验后才 resolve `{ok:true}`；preflight/start 间 identity drift、capture/guardian/owner-state 收敛失败只 resolve `{ok:false,code:"LOCAL_PROCESS_RECOVERY_REQUIRED"}`，不把内部原因带出。普通 spawn、stdio、协议、超时或重复/乱序 `app.ready` 作为启动异常 reject，不能伪装成 recovery-required。每次实际状态转换先递增process-local safe-integer `sequence` 再同步发布；旧generation迟到事件不得递增。`subscribeWithSnapshot` 必须在同一JavaScript turn内先同步安装listener，再读取并返回`current`，形成原子snapshot+subscribe；`unsubscribe`同步幂等。Main 对`SidecarStartResult`和所有`SidecarStateChange` discriminant做exhaustive `never` switch。`sidecar.test.ts`用接口级fake覆盖ok、typed recovery failure、普通reject、重复ready、sequence单调、旧generation、每个state reason与unsubscribe。

`controller.ts` 顶层显式 import 仓库现有 `ProtocolEvent`；不得另造同名宽松类型。状态由 vault 是否存在、本次 local getMe 验证、持久 target block 和非秘密 config 综合计算，不能只信配置布尔值。`handleSidecarEvent` 对 queued/updated/sent/failed/uncertain 唤醒 worker并广播安全 summary。Controller 在`initialize()`注册supervisor `onStateChange`；Main使用唯一`SidecarStateRouter`把Sidecar snapshot/live event 串行交给`handleSidecarStateChange`。Router按sequence拒绝旧值，Controller未安装时只保留最高sequence；`attach(handler)`先把latest排入同一state Promise chain，再原子切live，attach await期间到达的更高sequence排在其后，绝不丢失或并行。两类本地服务事件都进入同一chain。`shutdown()`固定为：Router拒绝新push→await已排队chain→await`worker.stop()`（无worker时settled）→supervisor unsubscribe；Main quit另行await router chain并调用Sidecar unsubscribe恰好一次。Controller绝不stop Supervisor/Sidecar。Supervisor或Sidecar的starting/restarting/failed先await worker.pause再publish；`LOCAL_PROCESS_RECOVERY_REQUIRED`保持同名。只有两项服务ready、vault/local identity/target有效且block=null才resume/wake。测试在`SidecarProcess.start()` resolve后、Controller构造前，以及Controller `initialize()` await中分别注入failed/restarting/ready，断言必pause、最终状态正确、零重复resume且recovery-required不被覆盖。

上一段构造/resume worker 的必要条件还必须包含 `config.deliveryRecoveryHold === null`。hold 非空时 Controller 保存这份非秘密 strict DTO 作为操作门禁，status 固定 `warningCode="ACTIVE_DELIVERY_RECOVERY_PENDING"`、`canEnableAutoSend=false`，并把hold intent一对一映射为`recoveryAction="retry_replace_account"/"retry_disconnect"`；任意 Sidecar delivery event、Supervisor ready或30秒轮询都不得创建/wake worker。只允许 hold.intent 对应的 `bind(confirmReplacement=true)` 或 `disconnect()` 消费它；另一操作、相同Bot凭据刷新、选目标、测试、启用、retry均返回 `ACTIVE_DELIVERY_RECOVERY_PENDING`。最终清hold commit成功后必须把action改回null，才允许按新持久配置决定是否构造worker，且该generation之前缓存的wake全部丢弃。

Supervisor/Sidecar state chain 与业务 delivery event 不得绕过 mutation mutex 恢复旧 worker，也不能为解决它而在 `supervisor.start()` 的回调里反向等待同一把锁。Controller 在取得 mutation mutex 时同步设置递增的 `mutationGeneration` 与 `mutationInProgress=true`：期间 ready/restart-ready、queued/updated等只更新最高安全 sequence 与 `deferredWake=true`，绝不调用旧 worker 的 `resume/wake/claim`；starting/restarting/failed 仍可按捕获的worker generation做幂等pause，但晚结果不得改写新generation。每个mutation的唯一 finally 在**仍持锁**时调用 `reconcileWorkerFromCurrentTruth()`：重新读取current config/hold、vault身份、target block、Sidecar+Supervisor最新state、当前worker generation与claim-gate状态，只在Controller gate未关闭、claim gate处于初始open或已由当前有效token明确reopen、`deliveryRecoveryPending=false`、worker自身`recoveryPending=false`、hold=null、两服务ready且全部身份仍匹配时对当前唯一worker resume并合并一次wake，否则保持claim-blocked/paused/absent；随后清deferred flag和mutationInProgress才释放锁。任何state/delivery event进入reconcile前也先检查两个latch与claim gate，为closed或latch=true时只更新status sequence且resume/wake/claim恒为0。shutdown关闭gate后reconcile永不resume。

测试把同Bot refresh停在candidate getMe前与vault.save后分别注入Supervisor ready、Sidecar restarting和delivery queued：旧worker的resume/wake/claim必须全为0，refresh完成后只有replacement worker按最新sequence恢复一次；refresh失败则只按回滚后的持久真值恢复旧worker一次。再把disconnect/replace与ready同tick、旧generation pause晚返回、shutdown关闭gate后ready逐点排列，断言无双worker、无旧Token发送、无丢失的最终failed状态且无锁反转/deadlock。

Controller `shutdown()` 自己固定8500ms绝对deadline，Main外层固定9000ms。禁止新callback与使已排队state generation失效是同步操作；已排队chain的每个await都接受shutdown signal并在总共500ms内收敛。若chain正在await Worker active settlement，500ms内只撤销该Controller continuation并把同一个settlement promise的唯一await所有权交给`worker.stop()`，绝不cancel后另发第二个gateway mutation；stop沿用首次pause/settlement的generation与绝对deadline，可用预算固定为`min(既有active deadline剩余时间, Controller剩余最多8000ms)`，绝不得重新获得完整8秒，unsubscribe同步幂等。chain超时时不允许其继续写状态，仍必须进入同一worker stop并把安全`recovery_pending`结果在8500ms内settle；后台可以只剩已发出的唯一transport request及其generation-discard observer，其迟到结果不能调用任何可写delivery/config/vault/worker continuation，除此之外不得保留可写Promise。fake clock覆盖499/500ms chain所有权交接、pause后0ms/7900ms才调用stop或shutdown、首次active deadline的7999/8000ms同tick（deadline胜）、8499/8500ms controller与9000ms Main外层边界，所有排列gateway状态写都恰好一次。

degraded bootstrap 必须按 Sidecar 是否可用拆成两个不可混用的模式。`core_degraded` 只用于 Sidecar 未 ready/recovery-required；它没有读取持久 Telegram 真值的安全通道，因此只允许构造下面这个完整状态。字段名不得写成 `connectionState`，也不得省略 `TelegramStatus` 的任何必填字段：

```ts
function createDegradedStatus(
  code: "LOCAL_PROCESS_RECOVERY_REQUIRED" | "LOCAL_SERVICE_UNAVAILABLE",
): TelegramStatus {
  const status: TelegramStatus = {
    connection: "disconnected",
    serviceState: "failed",
    bot: null,
    target: null,
    targetVerifiedAt: null,
    autoSendEnabled: false,
    autoSendStateKnown: false,
    enabledAt: null,
    canEnableAutoSend: false,
    migrationRetryAt: null,
    recoveryAction: null,
    warningCode: code,
  };
  return telegramStatusSchema.parse(status);
}
```

`core_degraded` 要求 `gateway === null`，不得调用 vault、gateway、Supervisor、client 或 worker。`initialize()` 用实际 `initialFailureCode` 构造并保存上述状态，先经 strict `telegramStatusSchema` 校验，再恰好调用一次 `publishStatus({status})` 并返回同一字段值；`getStatus()` 返回安全副本，`shutdown()` 返回 `{state:"settled",deliveryId:null}`，其余公开操作都返回同一个 initial failure code。

`telegram_runtime_degraded` 只用于核心 Sidecar 已 ready、但 Bot executable/app credentials/Telegram private path 等 Telegram-only preflight 失败；它必须持有非秘密 `gateway`，但 `vault/supervisor/createClient/createWorker` 全为 null且调用数恒为0。`initialize()` 先调用 `gateway.getConfig()`，以持久 DTO 构造严格状态：`connection="disconnected"`、`serviceState="failed"`、`bot` 仅在 accountId+accountUsername 都存在时恢复、`target/targetVerifiedAt/autoSendEnabled/enabledAt`逐字段照真值、`canEnableAutoSend=false`、`migrationRetryAt=null`、`recoveryAction`按hold intent映射为`retry_replace_account/retry_disconnect`或null、`warningCode="LOCAL_SERVICE_UNAVAILABLE"`。它不得把已开启的 auto send伪装成false，因为 Sidecar/CLI仍会按持久配置入队。该模式只允许 `initialize/getStatus/listDeliveries`、安全 delivery event 转发，以及 `setAutoSend(false)`；后者也必须把fresh完整before/expected与本次绝对deadline交给同一个`reconcileConfigureResult`，只有`committed`或持终态proof回读expected才把 status 的 `autoSendEnabled=false/enabledAt=null`并广播，无proof/第三真值则进入同一restart latch，绝不把未知状态谎报为已关闭。`true`与 bind/disconnect/discover/select/sendTest/retry全部返回 `LOCAL_SERVICE_UNAVAILABLE`。`shutdown()`固定settled。`getConfig`失败属于核心协议不可用，Main仍保持普通下载窗口可用但 Telegram IPC 返回 `LOCAL_SERVICE_UNAVAILABLE`，不得编造auto-send值或覆盖磁盘配置。

`autoSendStateKnown` 的唯一语义固定为：normal 与成功读取getConfig的runtime-degraded为true；core-degraded为false。若runtime-degraded首次`getConfig`也失败，`initialize()`仍必须安全完成并解析status：设置`autoSendStateKnown=false`、保守的`autoSendEnabled=true`、`enabledAt/bot/target/targetVerifiedAt=null`、`recoveryAction=null`与`LOCAL_SERVICE_UNAVAILABLE`，绝不覆盖磁盘；UI显示“无法确认自动发送状态”，只提供`setAutoSend(false)`重试，成功后改为known=true/false并广播。该规则替代上一段“getConfig失败只返回错误”的末句，确保普通窗口不被Telegram故障阻断，同时绝不把未知状态谎报成已关闭。正常状态与每次成功configure/getConfig都必须`autoSendStateKnown=true`。

正常分支要求 `mode="normal" && initialFailureCode===null && gateway!==null`；三个 mode 的其余非法组合由 constructor 立即拒绝。测试对 core 两种 code 与 runtime degraded 逐字段断言 initialize/getStatus/status event 的全部必填字段，证明 schema 接受 `connection/autoSendStateKnown/recoveryAction`、拒绝额外 `connectionState`；core degraded零gateway/秘密/进程调用，runtime degraded只调用getConfig/list/configure(false)。Supervisor 的 stale/capture failure event 不得被重写成通用 unavailable，Telegram-only 资源失败也不得伪装成 process recovery。

- [ ] **Step 5: 注册固定 IPC 与 preload API**

`ipc.ts` 只导出以下固定 channel 与注册/广播入口：

```ts
export const TelegramIpcChannels = {
  getStatus: "telegram:getStatus",
  bindToken: "telegram:bindToken",
  disconnect: "telegram:disconnect",
  discoverTargets: "telegram:discoverTargets",
  selectTarget: "telegram:selectTarget",
  sendTest: "telegram:sendTest",
  setAutoSend: "telegram:setAutoSend",
  listDeliveries: "telegram:listDeliveries",
  retryDelivery: "telegram:retryDelivery",
  delivery: "telegram:delivery",
  status: "telegram:status",
} as const;

export function registerTelegramIpcHandlers(
  ipcMain: Pick<Electron.IpcMain, "handle" | "removeHandler">,
  controller: TelegramController,
): () => void;

export interface TelegramIpcEventSink {
  send(channel: string, payload: unknown): void;
}

export function broadcastTelegramDelivery(
  sinks: Iterable<TelegramIpcEventSink>,
  event: TelegramDeliveryEvent,
): void;
export function broadcastTelegramStatus(
  sinks: Iterable<TelegramIpcEventSink>,
  event: TelegramStatusEvent,
): void;

export interface TelegramDesktopApi {
  getStatus(): Promise<TelegramIpcResult<TelegramStatus>>;
  bindToken(input: TelegramBindInput): Promise<TelegramIpcResult<TelegramBindResult>>;
  disconnect(): Promise<TelegramIpcResult<TelegramStatus>>;
  discoverTargets(): Promise<TelegramIpcResult<TelegramTarget[]>>;
  selectTarget(target: TelegramTarget): Promise<TelegramIpcResult<TelegramStatus>>;
  sendTest(targetId: string): Promise<TelegramIpcResult<{ ok: true }>>;
  setAutoSend(enabled: boolean): Promise<TelegramIpcResult<TelegramStatus>>;
  listDeliveries(query: TelegramDeliveryQuery): Promise<TelegramIpcResult<TelegramDeliveryPage>>;
  retryDelivery(input: TelegramRetryInput): Promise<TelegramIpcResult<TelegramDeliverySummary>>;
  onDelivery(listener: (event: TelegramDeliveryEvent) => void): () => void;
  onStatus(listener: (event: TelegramStatusEvent) => void): () => void;
}
```

每个 invoke 入参与返回值经过上一步的具名 `ipcSchemas.ts` export；Main handler 永不依赖 Electron 对 rejected Promise 的字符串化，而总是返回 `TelegramIpcResult<T>`。映射精确为：Zod/handler `INVALID_PARAMS → INVALID_PARAMS`，Sidecar `NOT_FOUND → NOT_FOUND`、`STATE_CONFLICT → STATE_CONFLICT`、`TARGET_STILL_BLOCKED → TARGET_STILL_BLOCKED`，Controller `ACTIVE_DELIVERY_RECOVERY_PENDING/AUTH_INVALID/LOCAL_SERVICE_UNAVAILABLE/LOCAL_PROCESS_RECOVERY_REQUIRED` 保持同名；Supervisor 内部 `STALE_PROCESS_QUARANTINED` 与 `STALE_PROCESS_IDENTITY_MISMATCH` 都先在 Controller 映射为 `LOCAL_PROCESS_RECOVERY_REQUIRED`，其他已脱敏异常统一 `OPERATION_FAILED`。每个用户级 code 一对一映射 Task 6 的 messageKey。未知 code、PID、argv、路径、raw `Error.message`、Zod issues、Telegram description、stack/cause 均不得进入 envelope。preload 用同一个 result schema 再解析并只把 `TelegramDesktopApi` 挂到 `window.api.telegram`，不暴露 raw channel 或通用 invoke。Renderer 对 `ok` 做 exhaustive 分支，失败只按 `error.code/messageKey` 选择产品文案，绝不读取异常字符串。`onDelivery` / `onStatus` 在 listener 前再次解析 event schema，并返回精确 unsubscribe。Controller 在 bind/disconnect、auth invalid、target invalid、target reverify、stale-process recovery required 和 supervisor health change 时广播完整安全 `TelegramStatusEvent`，让 UI 无需轮询即可更新。

- [ ] **Step 6: 接入 Main 生命周期**

Main 的启动顺序固定分层，Telegram-only 失败不能阻断普通下载。唯一 renderer bootstrap barrier 的 exact order 为：解析 paths并注册 core IPC（尚不创建 BrowserWindow）→ 只调用 `selectSidecarRecoveryPrivatePaths(paths) → ensurePrivateSidecarRecoveryPaths(...)` 与 `ensureProcessHostResourceInput(...)` → 构造核心 `SidecarProcess` → **在任何preflight/start前**立即调用`subscribeWithSnapshot`并把`current`交给`SidecarStateRouter` → await `preflightRecovery()`/`start()`，直到收到 `app.ready` 或得到 typed recovery failure → 安装 normal/core-degraded/telegram-runtime-degraded Telegram Controller并以`attach`重放latest/切live → 注册全部 Telegram IPC → resolve bootstrap barrier → 才创建主/设置 BrowserWindow；Sidecar ready时随后启动extension bridge，只有core degraded不启动依赖Sidecar的bridge。任何Renderer root都不可能在barrier前mount。该阶段绝不读取Bot token、Bot API executable、app credentials、Telegram workDir或Telegram owner-state。Sidecar只有收到hello与app.ready才算`start.ok=true`；`outputRecoveryPending=true`仍是ready，不阻止普通下载/历史/扩展桥。preflight/start间drift或contained spawn登记失败必须typed fail closed；Main仍注册唯一窄Telegram IPC，并用`mode="core_degraded"/gateway=null/initialFailureCode="LOCAL_PROCESS_RECOVERY_REQUIRED"`创建Controller。quit先close Router接收、await chain并unsubscribe一次，再进入既有Controller/Supervisor/Sidecar停止顺序。

核心 Sidecar ready 后立即构造唯一非秘密 `TelegramSidecarGateway`，再执行 Telegram-only preflight：`selectTelegramPrivateDataPaths(paths) → ensurePrivateTelegramPaths(...)`，再用 `ensureTelegramResourceInputs(...)` 验证 Bot API 与 packaged credentials；resource 路径绝不进入 chmod/icacls。任一 Telegram-only 检查失败都不创建/读取 vault、不构造 Telegram Supervisor/worker/client，也不停止已 ready 的 Sidecar；Main 把这个 gateway 交给 `mode="telegram_runtime_degraded"/initialFailureCode="LOCAL_SERVICE_UNAVAILABLE"` Controller，注册同一组 IPC并广播持久真值 status。全部 Telegram-only 检查成功后才构造 vault、Supervisor、worker 与 normal Controller，并复用同一个gateway。Main 的 `installTelegramController(deps)` helper 保证三个 mode 总共只注册一次 IPC；任一 Controller 完成 `initialize()` 与 IPC 安装才允许 bootstrap barrier resolve。barrier 前到达的 macOS `activate` 或 `second-instance` 只能设置幂等 `pendingWindowRequest=true`，不得提早创建窗口；barrier resolve 后消费一次并创建至多一组窗口。测试分别覆盖：Sidecar preflight 直接失败、preflight 成功后 start drift、capture 后无法收敛，均发布 `LOCAL_PROCESS_RECOVERY_REQUIRED`；Bot executable 缺失、app credentials 损坏、Telegram private DACL 失败时预置`autoSendEnabled=true/enabledAt/account/target`，均发布 `LOCAL_SERVICE_UNAVAILABLE`且status仍如实为true、recent list可读，Telegram vault/Supervisor/worker调用为零，同时普通 health、创建下载、history 与扩展桥请求仍成功。用户调用`setAutoSend(false)`后status变false/enabledAt=null，随后新output-ready不再入队；尝试true或其他受限操作稳定失败。Main + Renderer 集成测试断言两个 root mount时 app.ready/Controller barrier 已完成，`startTelegramRendererRuntime` 的首次 snapshot/status各调用恰好一次且均成功；不得靠首次调用失败后静默缺失 persisted delivery通过。所有 BrowserWindow event 只含安全 summary/status。

`SidecarProcess` 构造参数追加可注入 `lifecycle: SidecarLifecycleDeps`，production 逐字绑定 Task 7 的 `spawnContainedProcess`、`captureContainedProcessTree(candidate,generationId)`、launch candidate enumerator 与 handle/persist adapter；child env 只能来自 Task 6 `buildSidecarChildEnv`。`preflightRecovery()` 幂等并缓存本 generation permit；`start()` 只消费一次刚得到的 ok。预检在任何 spawn 前读取 sidecar owner-state：verified 从 schema v2 tree/guardian 恢复整组；quarantined 从已持久化的完整 guardian+target candidate 精确提升；launching 按 Task 7 的零/一/多 candidate 规则收敛。只有 `result.exited=true` 且 clear 成功才返回 ok；未知身份、PID reuse、capture/guardian failure或未确认退出都保留 v5 state、返回 `LOCAL_PROCESS_RECOVERY_REQUIRED` 并禁止第二份 Sidecar。Renderer-facing Controller status、BrowserWindow event、preload result 与 IPC envelope不含 PID、argv、路径或内部原因；Main-private `SidecarStopResult` 可按上文保留 pid但不得越过 Main。私有 owner-state 必须保留 v5 identity/endpoint/candidate/tree，但严禁 child env、API ID/hash、Token 或 raw reason。测试覆盖 preflight/start drift、launching 四个 crash window、fresh adapter 的 quarantined round-trip、typed degraded bootstrap、`unconfirmed` stop result 从 Main 映射到 Renderer 稳定错误仍无 pid，以及公共 envelope 与私有 round-trip。

每次 Sidecar 启动严格执行 `launching intent → process-host suspended handshake → quarantined → captured verified → resume → hello/app.ready`。任何 owner write/DACL/capture 失败都不 resume；宿主在 parent/control fd 消失时收敛整组。只有 verified tree 回读成功后才接受 hello，只有 Task 4 的 `app.ready` 后才发送协议请求或允许 manager/worker工作。frozen Sidecar 在 app.ready 前不得启动 yt-dlp/ffmpeg 后代。root-missing quarantine 只有宿主证明从未 resume且 Job/PGID为空才可清，否则保留并要求恢复。

root 的 exit/error 不得清除 handle。`stop()` 并发调用复用同一 Promise，并自调用时刻持有9000ms绝对deadline：同步停 heartbeat/restart → 给 `app.shutdown` 最多7000ms → 用剩余最多2000ms刷新/持久完整 guardian/Job/PGID 并对同一 handle 做有界 graceful/force attempt。到第9000ms仍未确认则必须resolve `{state:"unconfirmed",pid}`，保留最新handle/owner state且不放飞后台写入；Main外层严格更长，固定10000ms。`forceStop()` 复用同一 handle，内部2500ms绝对deadline中执行force并settle stopped/unconfirmed，Main最外层给3000ms。每次 operation 先保留最新 snapshot，只有 `exited=true` 且 owner clear 成功才清 proc/handle并切 stopped。测试覆盖6999/7000ms protocol、8999/9000ms stop settle、9999/10000ms Main外层、2499/2500ms force settle与3000ms force外层，保证每个外层都不抢在合同内settle之前。

运行期 unexpected exit/heartbeat failure 使用同一个 typed `SidecarStateChange` 和不可绕过的 restart gate：立即暂停新 request/heartbeat并发 `restarting`，保留旧 handle，先 `waitForProcessTreeExit`，需要时 `terminateAndWaitProcessTree`；只有 `result.exited=true` 且旧 owner state 清除成功才可写下一 generation launching intent。root 已退但 guardian/Job/PGID 后代仍活、persist/capture/clear失败时，发 `failed/LOCAL_PROCESS_RECOVERY_REQUIRED`，restart count 与 spawn count均不增加，Main 串行交给 Controller pause worker并广播。测试覆盖 live grandchild、persist fault、guardian先后 exit、late protocol event 和旧树收敛后才允许下一 generation；显式 stop/force 与自动 restart 竞争由 generation latch 保证只 settle 一次。

Main 对 Telegram Supervisor 的唯一所有权字段固定为 `let telegramSupervisor: TelegramSupervisorPort | null = null`。Telegram-only preflight全部成功后，Main 先构造唯一 Supervisor并立即把同一对象赋给该字段，随后才构造worker/normal Controller或调用任何可能间接触发 `supervisor.start()` 的 `initialize/bindToken`；这次赋值是进程所有权提交点，不代表start已经成功。只有在Supervisor构造前就进入的Sidecar recovery-required、Telegram resource失败等degraded分支始终为null；已构造、正在start、已经ready或failed的Supervisor都必须保持非空直到确认stop成功。Supervisor `stop()` 按上一任务合同在never-started/starting/ready/failed/stopped全部幂等且能收敛已产生的owner state/tree。`stopOwnedTelegramSupervisor()` 先快照当前引用，null立即成功且占0ms；非空则 await其 `stop()`，成功且字段仍等于快照时才置null。normal Controller构造或 `initialize()` 在所有权提交后失败时，Main 先best-effort `controller.shutdown()`（若已构造），再无条件调用 `stopOwnedTelegramSupervisor()`；确认停止后才用映射后的稳定code安装degraded Controller，未确认停止则保留字段并固定发布 `LOCAL_PROCESS_RECOVERY_REQUIRED`，使后续quit再次收敛，绝不能把引用丢掉或构造第二个Supervisor。把现有 fire-and-forget `before-quit` 改为一次性 async gate，Main 是唯一 app-shutdown owner：第一次 preventDefault，记录 `T0` 与 `T0+30s` hard deadline；依次 await `controller.shutdown()`（外层最多 9 秒，严格长于Controller内部8500ms绝对deadline）、optional `stopOwnedTelegramSupervisor()`（非空外层最多 7 秒，严格长于Supervisor内部6秒绝对deadline）、`sidecar.stop()`（外层最多 10 秒，严格长于Sidecar内部9秒绝对deadline），每步 reject/timeout 都记录稳定非秘密 code 后继续下一步，不能短路 cleanup。`sidecar.stop()`一旦返回unconfirmed或外层timeout，就立即以`min(3000ms,T0+30s-now)`调用同一handle的`sidecar.forceStop()`，且必须在`T0+27s`前开始；不得空等到27秒。到 `T0+30s` 后保留任何未确认 Telegram owner state/Sidecar PID 诊断并允许退出。确认全部完成后设置 `shutdownComplete=true` 并调用 `app.quit()`，第二次不再 preventDefault。fake 时钟覆盖 ownership赋值前零spawn、赋值后/Controller构造后/start launching/quarantined/verified/ready后逐点失败与quit，证明stop恰好一次且没有第二个Supervisor；另覆盖9+7+10秒最坏串行路径、Controller/Worker的500/8000/8500/9000ms边界、Supervisor的4.999/5.000/5.999/6.000/7.000秒边界、Sidecar的7/9/10秒与force 2.5/3秒边界，以及resource degraded/Sidecar recovery-required两条完整quit：均不构造Supervisor、顺序执行Controller→零时跳过Supervisor→Sidecar并完成quit。每一步reject仍执行后续，root已退但后代仍活、force立即起动与30秒hard deadline均覆盖，不能出现null dereference/unhandled rejection或把正常路径写成10秒合同。

- [ ] **Step 7: 跑 Electron 全量测试和 build**

```powershell
npm.cmd --prefix desktop test -- sidecar.test.ts controller.test.ts ipc.test.ts
npm.cmd --prefix desktop test
npm.cmd --prefix desktop run build
```

Expected: PASS；测试结束没有 child process、timer 或 unhandled rejection。

- [ ] **Step 8: Commit**

```powershell
git add desktop/electron/sidecar.ts desktop/electron/sidecar.test.ts desktop/electron/telegram/controller.ts desktop/electron/telegram/controller.test.ts desktop/electron/telegram/ipc.ts desktop/electron/telegram/ipc.test.ts desktop/electron/preload.ts desktop/electron/main.ts desktop/renderer/vite-env.d.ts
git commit -m "feat(electron): connect telegram account and ipc lifecycle"
```

---

## Phase 4 — 用户可见设置与发送状态

### Task 11: 水合安全的 delivery 摘要并处理乱序事件

**Files:**
- Modify: `src/sidecar/telegram_delivery_service.py`
- Modify: `src/sidecar/handlers.py`
- Modify: `tests/sidecar/test_handlers.py`
- Modify: `desktop/renderer/lib/types.ts`
- Modify: `desktop/renderer/store/appStore.ts`
- Modify: `desktop/renderer/store/appStore.test.ts`
- Create: `desktop/renderer/lib/telegramRuntime.ts`
- Create: `desktop/renderer/lib/telegramRuntime.test.ts`

- [ ] **Step 1: 写 snapshot 与乱序失败测试**

Sidecar snapshot 测试断言：

```python
assert snapshot["telegramDeliverySummary"][task_id]["status"] == "sent"
assert "filePath" not in json.dumps(snapshot["telegramDeliverySummary"])
assert "leaseId" not in json.dumps(snapshot["telegramDeliverySummary"])
```

store 测试依次送入 updatedAt 为 `12:00:03Z` 的 sent、`12:00:02Z` 的 sending 和重复 sent，断言不回退、不重复 render；再送入更晚的人工 retry pending，断言它可成为新状态。

- [ ] **Step 2: 确认失败**

```powershell
pytest tests/sidecar/test_handlers.py -q
npm.cmd --prefix desktop test -- appStore.test.ts
```

Expected: FAIL，snapshot 和 store 尚无 Telegram 摘要。

- [ ] **Step 3: 让 app.getSnapshot 返回 task 级安全摘要**

`TelegramDeliveryService.summaries_by_task()` 对每个 task 只取 `updated_at` 最新记录，返回：

```json
{
  "task-id": {
    "id": "delivery-id",
    "taskId": "task-id",
    "status": "sent",
    "title": "Example",
    "targetTitle": "Saved Messages",
    "attemptCount": 1,
    "updatedAt": "2026-08-10T12:00:03Z",
    "messageKey": "telegram.delivery.sent",
    "errorCode": "",
    "retryConfirmation": "none"
  }
}
```

外层 key 为 task ID。Sidecar 根据稳定 error code 映射安全 `messageKey` 与 `retryConfirmation`，Renderer 再用当前语言词典渲染；摘要不包含 raw Telegram description、本地路径、lease 或 account ID。

- [ ] **Step 4: 扩展 Renderer 类型与 store**

`AppSnapshot` 增加 `telegramDeliverySummary: Record<string, TelegramDeliverySummary>`；`appStore.ts` 定义下面这个完整 slice，并让现有 `AppState` 显式 `extends TelegramDeliveryStoreSlice`：

```ts
interface TelegramDeliveryStoreSlice {
  telegramDeliveriesByTaskId: Record<string, TelegramDeliverySummary>;
  telegramStatus: TelegramStatus | null;
  hydrateTelegramDeliveries: (items: Record<string, TelegramDeliverySummary>) => void;
  applyTelegramDelivery: (item: TelegramDeliverySummary) => void;
  hydrateTelegramStatus: (status: TelegramStatus) => void;
  applyTelegramStatus: (status: TelegramStatus) => void;
}
```

合并规则：先比较可解析的 `updatedAt`，较旧事件拒绝；相同时比较 `attemptCount`，再以终态优先。人工 retry 必须由 controller 返回更新后的时间戳，因此合法 `failed/uncertain → pending` 不会被误拒绝。

新增唯一 realtime coordinator，任何组件不得各自直接订阅 preload：

```ts
export interface TelegramRendererRuntime {
  readonly ready: Promise<void>;
  dispose(): void;
}

export function startTelegramRendererRuntime(input: {
  getSnapshot(): Promise<AppSnapshot>;
  getStatus(): Promise<TelegramIpcResult<TelegramStatus>>;
  onDelivery(listener: (event: TelegramDeliveryEvent) => void): () => void;
  onStatus(listener: (event: TelegramStatusEvent) => void): () => void;
  hydrateDeliveries(items: Record<string, TelegramDeliverySummary>): void;
  applyDelivery(item: TelegramDeliverySummary): void;
  hydrateStatus(status: TelegramStatus): void;
  applyStatus(status: TelegramStatus): void;
}): TelegramRendererRuntime;
```

启动固定为：同步注册 `onDelivery/onStatus` 并取得两个 unsubscribe → 才并发请求 snapshot/status。定义 `MAX_DELIVERY_REPLAY_TASKS = 256`；首次 hydration 未完成时，delivery transient map 以 `taskId` 为 key，只保存按 store 单调规则更新后的每 task 最新 summary，status 只保存最新 event 与本地递增 sequence。只要 distinct task 不超过256，先 hydrate base snapshot/status，再按确定性 taskId bytes顺序 merge delivery map并应用最新 status；`ready` 在 hydration/replay完成后 resolve，后续事件立即 apply。

第257个不同 task 到达时必须进入唯一 `resyncRequired` 分支而不是继续扩容：递增 hydration generation；把现有最多256项通过正常 monotonic merge写入权威 store后清空 transient map；包括触发overflow的第257项在内，从此 live delivery直接 merge store、status继续只保留最新 event/sequence；旧 generation 的任何 response都失效；立即发起新 generation 的 `getSnapshot/getStatus`。新 snapshot 必须逐项 monotonic merge而非 replace，因此请求期间已到达的较新状态不会回退；status request记录 `statusSequenceAtRequest`，返回时只有 sequence 未变化才应用 response，否则保留最新 live status。新 generation 两个请求 settle且所有同步 merge完成后才 resolve同一个 `ready`；invoke失败按安全 code写 UI 状态，但不得丢已有 live state。真实 Zustand task map可随产品中的 task 数增长，256上限只约束临时 replay结构。`dispose()` 幂等同步调用两个 unsubscribe、清 transient map、使全部 generation失效；迟到 Promise/event均忽略。测试精确覆盖订阅先于两个请求、请求中事件、较新 sent 不被旧 snapshot覆盖、failed→ready 清 warning、阻塞首轮后注入257+ distinct tasks时 transient map从不超过256且只创建一个新 generation、新请求期间继续注入并最终零丢失、status sequence选择、dispose前后迟到结果、React StrictMode mount/unmount/remount与每 channel 每 root最多一条 listener。

- [ ] **Step 5: 跑定向测试**

```powershell
pytest tests/sidecar/test_handlers.py -q
npm.cmd --prefix desktop test -- appStore.test.ts
npm.cmd --prefix desktop run build
```

Expected: PASS。

- [ ] **Step 6: Commit**

```powershell
git add src/sidecar/telegram_delivery_service.py src/sidecar/handlers.py tests/sidecar/test_handlers.py desktop/renderer/lib/types.ts desktop/renderer/store/appStore.ts desktop/renderer/store/appStore.test.ts desktop/renderer/lib/telegramRuntime.ts desktop/renderer/lib/telegramRuntime.test.ts
git commit -m "feat(ui): expose telegram delivery summaries"
```

---

### Task 12: 交付“发送”设置页、最近发送与任务徽标

**Files:**
- Create: `desktop/renderer/components/TelegramSettingsTab.tsx`
- Create: `desktop/renderer/components/TelegramSettingsTab.test.tsx`
- Create: `desktop/renderer/components/TelegramDeliveryList.tsx`
- Create: `desktop/renderer/components/TelegramDeliveryList.test.tsx`
- Create: `desktop/renderer/components/TelegramDeliveryBadge.tsx`
- Create: `desktop/renderer/components/TelegramDeliveryBadge.test.tsx`
- Modify: `desktop/renderer/SettingsApp.tsx`
- Modify: `desktop/renderer/main.tsx`
- Modify: `desktop/renderer/settings-main.tsx`
- Modify: `desktop/renderer/components/DownloadCard.tsx`
- Modify: `desktop/renderer/i18n.ts`
- Modify: `desktop/renderer/styles.css`

- [ ] **Step 1: 写用户流程失败测试**

Testing Library 覆盖：

- 未连接：Token、专用 Bot 确认和“连接 Telegram”；确认未勾选时按钮不可用。
- 连接中：输入与按钮锁定，显示“正在连接”。
- 成功：Token input 立即变空，DOM 和测试快照找不到 token，显示真实 Bot username。
- 已连接：显示“断开连接”；确认文案明确“尚未开始的发送会取消，已发送记录和本地文件会保留”，确认后只调用一次`disconnect()`，busy期间全部Telegram mutation按钮禁用。
- 需要重连：显示“重新连接”动作，保留队列说明。
- 本地发送服务 starting/restarting/failed：显示“发送服务暂时不可用，任务会保留并在恢复后继续”，不出现进程、端口或 Sidecar；恢复 ready 后提示自动消失。
- 连接转移中断：10 分钟窗口内显示等待到具体时间；窗口后显示“重新开始连接”，二次确认后才传 `restartMigrationConfirmed=true`。
- 发现位置：私聊、群组、超级群组、频道显示用户标题与中文类型，不显示 raw chat type。
- 测试消息未成功前 auto-send disabled；成功后才可开。
- recent list 显示 9 种状态；普通 failed 可重试；`FILE_MISSING/FILE_UNREADABLE/FILE_CHANGED` 的重试由 Sidecar 重新确认当前文件并刷新内部快照，文件仍不可用时保持原失败状态；`POSTPROCESS_INTERRUPTED` 先弹“文件可能不完整”确认；uncertain 先弹“可能重复”确认。
- 目标仍被持久封锁时点击失败记录重试，保持 failed 并显示“接收位置仍不可用，请重新验证后再重试”；目标测试成功 clear 后同一记录才能进入 pending。
- Telegram 运行资源不可用但核心 Sidecar ready时，设置页在`autoSendStateKnown=true`按持久真值显示当前 Bot/目标与“下载完成后自动发送”真实开关，recent list仍可查看；开关为true时只允许用户把它关闭，关闭成功立即更新为known=true/false。`autoSendStateKnown=false`时固定显示“无法确认自动发送状态”，把开关按保守开启态呈现且只允许尝试关闭。绑定/发现/测试/开启/重试保持禁用并显示安全恢复提示；不得把未知/开启状态渲染成“自动发送已关闭”或隐藏已排队记录。
- 对九个 `TelegramIpcErrorCode` 分别返回失败 envelope，组件只显示 messageKey 对应的中英文产品文案；`ACTIVE_DELIVERY_RECOVERY_PENDING` 固定显示“发送清理尚未完成。若刚出现此提示，请重启百纳；重启后请重试解绑或更换 Bot。”/“Delivery cleanup is not finished. If this just appeared, restart Downany; after restarting, retry disconnecting or replacing the bot.”，同一文案同时覆盖当前进程需重启与重启后持久hold待重试两阶段。`LOCAL_PROCESS_RECOVERY_REQUIRED` 固定显示“发送服务未能安全恢复，请重启电脑后再试”/“The sending service could not recover safely. Restart your computer and try again.”，不展示进程、端口或内部错误。即使测试异常对象含另一段可识别文本，DOM、toast 和 snapshot 都不得出现 PID、路径、argv、raw `Error.message`、stack 或 Telegram description。
- `status.recoveryAction` 做 exhaustive render：null显示普通操作；`restart_app`只显示重启提示并锁住mutation；`retry_disconnect`只显示“继续断开”且调用`disconnect()`；`retry_replace_account`显示Token输入与“继续更换 Bot”，再次调用bind并固定`replaceAccountConfirmed=true`。不得把disconnect hold导向换Bot，也不得在replace hold调用disconnect。
- DownloadCard 按 taskId 展示 badge；没有 delivery 时不占位。

- [ ] **Step 2: 确认失败**

```powershell
npm.cmd --prefix desktop test -- TelegramSettingsTab.test.tsx TelegramDeliveryList.test.tsx TelegramDeliveryBadge.test.tsx
```

Expected: FAIL，组件尚不存在。

- [ ] **Step 3: 实现局部 Token 表单**

`TelegramSettingsTab` 中 token 只能由 `useState("")` 持有；不得加入 `AppSettings` draft、Zustand、localStorage、query string 或 300ms autosave。绑定成功执行 `setToken("")`；绑定失败保留 input 方便纠正，但错误只显示安全产品文案。

组件用单一 `telegramMutationBusy` 串行所有按钮。普通“断开连接”先展示上述安全确认，确认后调用`window.api.telegram.disconnect()`；`result.ok=true`时立即用返回的完整status更新store，清空本地Token input，并在`warningCode=LOCAL_LOGOUT_FAILED`时只显示“其他服务可能需要等待”的产品提示，仍视为本地断开成功。`ACTIVE_DELIVERY_RECOVERY_PENDING/restart_app`只提示重启，不乐观清Bot；重启水合出`retry_disconnect`后，同一按钮改名“继续断开”并再次调用同一API。最终成功必须显示bot/target为空、auto-send关闭，同时recent历史仍在。

`main.tsx` 与 `settings-main.tsx` 各自在 React root 生命周期中恰好调用一次 `startTelegramRendererRuntime`，把返回值保存在 effect 内并在 cleanup 调 `dispose()`；不得在 `DownloadCard`、列表、设置 tab 或 Zustand action 中重复订阅。主窗口用 coordinator 水合 snapshot/徽标，设置窗口用同一 coordinator水合 status/recent list，因此两个独立 BrowserWindow各有一套 listener且窗口销毁即清理。`SettingsApp` 与 `TelegramSettingsTab` 只读取 store 的 `telegramStatus`，ready event到达后 warning自动消失。

换 Bot 时先显示确认：“将取消旧机器人的待发送任务，已发送记录和本地文件会保留”；确认后再次调用 bind，传 `replaceAccountConfirmed: true`。

若水合status为`recoveryAction="retry_replace_account"`，保持Token只在组件local state，要求用户重新输入要绑定的Bot Token并再次确认，按钮文案改为“继续更换 Bot”；成功status与普通换Bot相同。`retry_disconnect/retry_replace_account`两条恢复路径都必须复用单一busy gate与strict result schema，成功后`recoveryAction=null`，失败时不得自行清status/hold。

- [ ] **Step 4: 实现目标选择与用户引导**

空状态按目标类型展示：

```text
私聊：在 Telegram 打开机器人并发送 /start
群组：把机器人加入群组后发送一条消息
频道：把机器人设为可发消息的管理员
```

“刷新接收位置”调用 discover；选择后调用 select；“发送测试消息”成功后刷新 status。自动发送开关只有 `status.canEnableAutoSend` 为 true 时启用。

- [ ] **Step 5: 实现 recent list 和二次确认**

首次取 25 条，使用 offset/limit 加载更多。所有 `window.api.telegram` 调用先 exhaustive 判断 `result.ok`；成功只读 `data`，失败只把 `error.messageKey/code` 交给固定字典。普通 failed 调用 retry；返回仍为 failed 时保持原卡片与对应“文件不存在/无法读取/已变化”产品提示，只有 Sidecar 已刷新稳定文件快照并返回 pending 才更新为等待发送。若 IPC 返回稳定 `TARGET_STILL_BLOCKED`，不乐观改状态并提示先重新验证接收位置。`POSTPROCESS_INTERRUPTED` 使用 ConfirmDialog，确认文本明确“后处理被中断，请先确认本地文件可以正常打开”；uncertain 使用 ConfirmDialog，确认文本明确“Telegram 可能已经收到，再试一次可能产生重复消息”。按钮 busy 时禁止重复触发；Renderer 不读取或传递 filePath、size、mtime、mediaKind。

断开测试必须覆盖：正常connected→确认→成功；取消确认零调用；双击/busy恰好一次；local logout失败但返回已断开status+安全warning；首次stop为recovery_pending时Bot/vault可见状态不被UI乐观清空、显示restart_app；模拟完整重启水合`retry_disconnect`后点击“继续断开”成功，断言bot/target/token状态清空、未开始记录cancelled、sent历史/下载文件仍保留。换Bot对应覆盖`retry_replace_account`，并证明两个action互不误调用。

- [ ] **Step 6: 实现状态徽标与双语文案**

状态映射固定为：

```text
pending/preparing = 等待发送
sending = 正在发送
retry_wait = 稍后重试
sent = 已发送
skipped_oversize = 文件过大，已通知
failed = 发送失败
uncertain = 请确认是否已收到
cancelled = 已取消
```

为上述文案、连接态、错误动作、发现引导和确认弹窗增加中英文词典键；`FILE_UNREADABLE → telegram.delivery.fileUnreadable` 固定渲染“文件无法读取，请检查权限后重试”/“The file cannot be read. Check its permissions and try again.”，不得显示路径或原始系统错误。CSS 使用 `.telegram-settings`、`.telegram-target`、`.telegram-delivery-list`，以及 `.telegram-delivery-badge--pending/sending/retry/sent/oversize/failed/uncertain/cancelled` 八个明确变体；窄窗口下改为单列且按钮最小点击高度 40px。

- [ ] **Step 7: 跑 UI 测试、build 和视觉检查**

```powershell
npm.cmd --prefix desktop test -- TelegramSettingsTab.test.tsx TelegramDeliveryList.test.tsx TelegramDeliveryBadge.test.tsx appStore.test.ts telegramRuntime.test.ts
npm.cmd --prefix desktop test
npm.cmd --prefix desktop run build
```

随后以开发态打开设置窗口，分别截取未连接、已连接、目标发现、recent list 和 uncertain 确认五张截图。检查 1280×800 与 390×844 视口没有截断、横向滚动或内部术语，并把可渲染的绝对路径截图发给用户确认。

- [ ] **Step 8: Commit**

```powershell
git add desktop/renderer/components/TelegramSettingsTab.tsx desktop/renderer/components/TelegramSettingsTab.test.tsx desktop/renderer/components/TelegramDeliveryList.tsx desktop/renderer/components/TelegramDeliveryList.test.tsx desktop/renderer/components/TelegramDeliveryBadge.tsx desktop/renderer/components/TelegramDeliveryBadge.test.tsx desktop/renderer/SettingsApp.tsx desktop/renderer/main.tsx desktop/renderer/settings-main.tsx desktop/renderer/components/DownloadCard.tsx desktop/renderer/i18n.ts desktop/renderer/styles.css
git commit -m "feat(ui): add telegram auto delivery controls"
```

---

## Phase 5 — 官方服务的固定输入、可审计构建与分发

### Task 13: 锁定上游、构建凭据与资源 manifest

**Files:**
- Create: `packaging/telegram-bot-api/source.lock.json`
- Create: `packaging/telegram-bot-api/vcpkg.json`
- Create: `packaging/telegram-bot-api/vcpkg-configuration.json`
- Create: `packaging/telegram-bot-api/windows-system-dll-policy.json`
- Create: `packaging/telegram-bot-api/licenses/BSL-1.0.txt`
- Create: `packaging/telegram-bot-api/licenses/OpenSSL.txt`
- Create: `packaging/telegram-bot-api/licenses/zlib.txt`
- Create: `packaging/ffmpeg-macos/source.lock.json`
- Create: `packaging/ffmpeg-macos/COPYING.LGPLv2.1`
- Create: `packaging/ffmpeg-macos/lame-3.100-macos.patch`
- Create: `packaging/ffmpeg-macos/LAME-COPYING`
- Create: `packaging/ffmpeg-windows/source.lock.json`
- Create: `packaging/ffmpeg-windows/COPYING.LGPLv3`
- Create: `packaging/ffmpeg-windows/THIRD_PARTY_LICENSES.txt`
- Modify: `packaging/requirements-sidecar.txt`
- Create: `packaging/requirements-sidecar-macos-arm64.lock.txt`
- Create: `packaging/requirements-sidecar-windows-x64.lock.txt`
- Create: `packaging/sidecar-sources.lock.json`
- Create: `packaging/sidecar-install-artifacts.lock.json`
- Create: `packaging/curl-cffi-native.lock.json`
- Create: `packaging/sidecar-windows-runtime-policy.json`
- Create: `packaging/cpython-windows-runtime.lock.json`
- Create: `packaging/cpython-macos-runtime.lock.json`
- Create: `packaging/cpython-windows-runtime-licenses/CPython-PSF-2.0.txt`
- Create: `packaging/cpython-windows-runtime-licenses/OpenSSL-Apache-2.0.txt`
- Create: `packaging/cpython-windows-runtime-licenses/SQLite-Public-Domain.txt`
- Create: `packaging/cpython-windows-runtime-licenses/bzip2-License.txt`
- Create: `packaging/cpython-windows-runtime-licenses/XZ-COPYING.txt`
- Create: `packaging/cpython-windows-runtime-licenses/libffi-MIT.txt`
- Create: `packaging/cpython-windows-runtime-licenses/zlib-Zlib.txt`
- Create: `packaging/cpython-windows-runtime-licenses/Microsoft-Visual-Cpp-Runtime.txt`
- Create: `packaging/curl-cffi-native-licenses/curl-cffi-MIT.txt`
- Create: `packaging/curl-cffi-native-licenses/curl-impersonate-MIT.txt`
- Create: `packaging/curl-cffi-native-licenses/curl-curl.txt`
- Create: `packaging/curl-cffi-native-licenses/BoringSSL.txt`
- Create: `packaging/curl-cffi-native-licenses/zlib-Zlib.txt`
- Create: `packaging/curl-cffi-native-licenses/zstd-BSD-3-Clause.txt`
- Create: `packaging/curl-cffi-native-licenses/brotli-MIT.txt`
- Create: `packaging/curl-cffi-native-licenses/nghttp2-MIT.txt`
- Create: `packaging/curl-cffi-native-licenses/nghttp3-MIT.txt`
- Create: `packaging/curl-cffi-native-licenses/ngtcp2-MIT.txt`
- Create: `packaging/curl-cffi-native-licenses/sfparse-MIT.txt`
- Create: `packaging/sidecar-THIRD_PARTY_LICENSES.txt`
- Create: `packaging/SOURCE-OFFER.txt.in`
- Create: `packaging/release-binaries.lock.json`
- Create: `THIRD_PARTY_NOTICES.md`
- Create: `desktop/resources/telegram-bot-api/.gitkeep`
- Create: `desktop/resources/process-host/.gitkeep`
- Create: `desktop/resources/third-party-licenses/.gitkeep`
- Modify: `.gitignore`
- Create: `scripts/lib/telegramPackaging.mjs`
- Create: `scripts/tests/telegramPackaging.test.mjs`
- Create: `scripts/generate_telegram_build_credentials.mjs`
- Create: `scripts/generate_telegram_resource_manifest.mjs`
- Create: `scripts/audit_telegram_secrets.ps1`
- Create: `scripts/install_sidecar_locked.py`
- Create: `scripts/verify_curl_cffi_native.py`
- Create: `scripts/verify_cpython_windows_runtime.py`
- Create: `scripts/build_release_source_bundle.sh`
- Create: `scripts/verify_release_source_bundle.mjs`

- [ ] **Step 1: 写 lock、凭据和 manifest 失败测试**

测试断言 Telegram 与两端 FFmpeg 的 git lock commit 都是 40 位 hex、repository 都是官方仓库；Telegram/OpenSSL/LAME/vcpkg/release binary 全部固定 URL/SHA/平台。两份 requirements lock 与 source/artifact lock 精确相等，安装报告证明实际 wheel。curl-cffi native lock 闭合两个 wheel、原生资产、sfparse递归 gitlink与十一份许可证。Windows runtime policy 必须把 wrapper exact imports 与全树逐成员 imports 分开；Windows runtime lock 映射最终全部 PE 到 source/license或唯一 MSVC exception。macOS runtime lock 必须固定 action artifact的 commit/tag/URL/size/SHA，映射最终全部 Mach-O及逐成员 install-name到 source/license，拒绝 vendor exception、Homebrew路径和未登记 Tcl/Tk。两个 native report 的成员、imports、size/SHA与各自 committed lock精确相等。缺 api ID/hash任一项退出非零且不回显；resource manifest 只含分发文件 SHA，不含 credential值。秘密扫描器 fixture 必须覆盖 HEAD、index、当前工作树、文件名、普通文件、诊断 zip 原始字节与安全展开成员中的真实 raw/URL-encoded/二次 percent-encoded Token，以及真实 API ID/hash；通用 Token 形态在所有目录始终启用，只允许逐字移除代码中列出的固定 synthetic 值，不能按 `tests/fixtures` 路径整类豁免，失败输出不得含匹配值、路径、行号或 blob 内容。

- [ ] **Step 2: 确认失败**

```powershell
node --test scripts/tests/telegramPackaging.test.mjs
```

Expected: FAIL，文件尚不存在。

- [ ] **Step 3: 提交精确 source lock 与依赖 manifest**

`source.lock.json` 固定：

```json
{
  "schemaVersion": 1,
  "repository": "https://github.com/tdlib/telegram-bot-api.git",
  "commit": "adfd7f6a8e990272851777eeb3ae0def4216f161",
  "license": "BSL-1.0",
  "vcpkgRepository": "https://github.com/microsoft/vcpkg.git",
  "vcpkgBaseline": "ea1a7396b05637a53bf23c078647ecc0edee4b80",
  "macosDeploymentTarget": "11.0",
  "windowsVcpkgTriplet": "x64-windows-static",
  "targets": ["darwin-arm64", "win32-x64"],
  "macosOpenSSL": {
    "version": "3.6.3",
    "repository": "https://github.com/openssl/openssl.git",
    "commit": "aae016bfd52fcad2bc9657c2c782cfdf73b1ed5f",
    "url": "https://github.com/openssl/openssl/releases/download/openssl-3.6.3/openssl-3.6.3.tar.gz",
    "sha256": "243a86649cf6f23eeb6a2ff2456e09e5d77dd9018a54d3d96b0c6bdd6ba6c7f1",
    "license": "Apache-2.0"
  },
  "zlib": {
    "version": "1.3.2",
    "repository": "https://github.com/madler/zlib.git",
    "url": "https://zlib.net/fossils/zlib-1.3.2.tar.gz",
    "sha256": "bb329a0a2cd0274d05519d61c667c062e06990d72e125ee2dfa8de64f0119d16",
    "license": "Zlib"
  }
}
```

`packaging/ffmpeg-macos/source.lock.json` 固定为官方 7.1.1 release commit，只发布 arm64：

```json
{
  "schemaVersion": 1,
  "repository": "https://git.ffmpeg.org/ffmpeg.git",
  "commit": "68af2cc3feb8c78aec2722c728fd87f03515fa7c",
  "version": "7.1.1",
  "license": "LGPL-2.1-or-later",
  "target": "darwin-arm64",
  "deploymentTarget": "11.0",
  "lame": {
    "version": "3.100",
    "url": "https://downloads.sourceforge.net/project/lame/lame/3.100/lame-3.100.tar.gz",
    "sha256": "ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e",
    "license": "LGPL-2.0-or-later",
    "patch": "lame-3.100-macos.patch"
  }
}
```

`packaging/ffmpeg-windows/source.lock.json` 把月末 binary 精确绑定到 BtbN build scripts 与 FFmpeg commit：

```json
{
  "schemaVersion": 1,
  "buildRepository": "https://github.com/BtbN/FFmpeg-Builds.git",
  "buildCommit": "a99e8230eae00d1cee38f23076a7a1f55cd984e2",
  "target": "win64",
  "variant": "lgpl",
  "addins": ["7.1"],
  "ffmpegRepository": "https://github.com/FFmpeg/FFmpeg.git",
  "ffmpegCommit": "1fdbca85aaea513c9cc6c14d347f76543346d3da"
}
```

`packaging/release-binaries.lock.json` 只固定 Windows 发布用 FFmpeg；额外的 yt-dlp PyInstaller executable 不再随包分发，因为 Sidecar 已包含同一运行时模块，避免重复且不可实际更新下载核心的二进制：

```json
{
  "schemaVersion": 2,
  "windowsFfmpeg": {
    "provider": "BtbN/FFmpeg-Builds",
    "releaseTag": "autobuild-2026-07-31-14-10",
    "asset": "ffmpeg-n7.1.5-12-g1fdbca85aa-win64-lgpl-7.1.zip",
    "url": "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-07-31-14-10/ffmpeg-n7.1.5-12-g1fdbca85aa-win64-lgpl-7.1.zip",
    "sha256": "b7c1c846dacca68ee4ebf5c390742c973b3d5d14a6d44b061f500d8e4ac74fc0",
    "size": 139452771,
    "license": "LGPL-3.0-or-later"
  }
}
```

`packaging/telegram-bot-api/windows-system-dll-policy.json` 不用一个容易随系统版本漂移的模糊名称列表，而是固定以下判定合同：

```json
{
  "schemaVersion": 1,
  "allowedRootEnvironmentVariable": "SystemRoot",
  "allowedRelativeRoot": "System32",
  "requireAuthenticodeStatus": "Valid",
  "requireSignerOrganization": "Microsoft Corporation",
  "denyPathSeparators": true,
  "deniedNamePrefixes": [
    "libssl",
    "libcrypto",
    "zlib",
    "msvcp",
    "vcruntime",
    "ucrtbase",
    "api-ms-win-crt-"
  ]
}
```

verifier 对 `dumpbin /DEPENDENTS` 的每个 basename 先拒绝 `/`、`\\`、`..` 和上述前缀，再把它解析为 `%SystemRoot%\\System32\\<basename>`，验证解析后仍是该目录直接子文件、文件真实存在、`Get-AuthenticodeSignature` 为 `Valid`，且 signer certificate Subject 的 organization 精确等于 `Microsoft Corporation`；任何一步失败即拒绝。纯函数 fixture 覆盖允许的 Microsoft System32 记录、伪 System32 路径、第三方有效签名、无效签名和每个显式拒绝前缀；Windows runner 另对真实 imports 做集成验证。验证过程只读元数据，绝不加载 DLL。

两个 vcpkg manifest 必须完整固定为：

```json
{
  "$schema": "https://raw.githubusercontent.com/microsoft/vcpkg-tool/main/docs/vcpkg.schema.json",
  "name": "downany-telegram-bot-api-build",
  "version-string": "1",
  "dependencies": [
    { "name": "gperf", "host": true },
    "openssl",
    "zlib"
  ]
}
```

```json
{
  "default-registry": {
    "kind": "git",
    "repository": "https://github.com/microsoft/vcpkg.git",
    "baseline": "ea1a7396b05637a53bf23c078647ecc0edee4b80"
  }
}
```

Windows 固定 target triplet `x64-windows-static` 与 host triplet `x64-windows`，不接受 dynamic target。BSL 从 pinned Telegram upstream 的 `LICENSE_1_0.txt` 逐字提交；`OpenSSL.txt` 固定取自 OpenSSL 官方 `openssl-3.6.3` release 的 `LICENSE.txt`，`zlib.txt` 固定取自 madler/zlib 官方 `v1.3.2` 的 `LICENSE`，macOS FFmpeg/LAME 与 Windows BtbN LGPLv3 文本从各自锁定源码逐字提交。测试记录来源 URL并校验文件非空及关键版权/许可段。根目录 `THIRD_PARTY_NOTICES.md` 声明 Telegram Bot API、OpenSSL 3.6.3、zlib 1.3.2、Sidecar 内嵌 yt-dlp、curl-cffi/libcurl-impersonate 及其静态原生组件、CPython 3.11.9 与 Windows runtime 的 OpenSSL/SQLite/bzip2/XZ/libffi/zlib/MSVC redistributable、macOS FFmpeg/LAME 与 Windows LGPLv3 FFmpeg，并指向同 tag 的 `Downany-third-party-sources-<version>.tar.zst`。构建时 Telegram 四份 notice 统一复制到 Telegram resources；所有客户可见许可证和 source offer 统一 stage 到 `desktop/resources/third-party-licenses`。不能依赖 Homebrew 当前安装树，也不能只留在仓库根而漏出安装包。Windows 另外对 pinned vcpkg 安装树的 copyright 文件存在性做一致性门禁，并断言该 baseline 实际解析为 OpenSSL 3.6.3 与 zlib 1.3.2。

- [ ] **Step 4: 建立安装包许可证和 Corresponding Source 生成器**

Sidecar 构建 Python 固定为 `3.11.9`，`packaging/requirements-sidecar.txt` 的直接依赖固定为 `yt-dlp[curl-cffi]==2026.7.4` 与 `pyinstaller==6.17.0`。在 macOS arm64 与 Windows x64 的干净 Python 3.11.9 venv 中分别用同一个 `pip-tools==7.6.0` 生成并提交完整平台 lock；命令固定为：

```powershell
python -m pip install "pip-tools==7.6.0"
python -m piptools compile --resolver=backtracking --generate-hashes --allow-unsafe --strip-extras --no-emit-index-url --output-file packaging/requirements-sidecar-<platform>.lock.txt packaging/requirements-sidecar.txt
python -m pip install --dry-run --require-hashes -r packaging/requirements-sidecar-<platform>.lock.txt
```

`<platform>` 在 Apple Silicon runner 只能替换为 `macos-arm64`，在 Windows x64 runner 只能替换为 `windows-x64`；脚本测试解析生成文件头中的 Python/pip-tools 版本并拒绝交叉复制。全部传递依赖必须精确版本且每个可安装分发带 `--hash=sha256:`，不得在 release 构建时重新 compile。`packaging/sidecar-sources.lock.json` 完整枚举两个 requirements lock 的规范化包名/版本并集，每项固定 sdist URL、sdist SHA256、SPDX license ID 和 license file path；集合必须精确相等。另固定 CPython 3.11.9 commit `7cd4a91608030a5a404220c0beb1f307de84af26`，source `https://www.python.org/ftp/python/3.11.9/Python-3.11.9.tar.xz`，SHA256 `9b1e896523fc510691126c864406d9360a3d1e986acbda59cda57b5abda45b87`。Windows release Sidecar 不直接信任 runner 当前 toolcache；它必须用锁中的官方 x64 installer `https://www.python.org/ftp/python/3.11.9/python-3.11.9-amd64.exe`（size `26216840`、SHA256 `5ee42c4eee1e6b4464bb23722f90b45303f79442df63083f05322f1785f5fdde`）静默安装到随机临时 containment，再由该解释器创建 release venv；失败/成功都清理临时 installer 和安装目录。macOS 锁定 artifact 的官方 installer 会写入全局 `/Library/Frameworks/Python.framework`，因此计划不得伪称它可安装到临时 root：release 只允许在一次性 GitHub-hosted `macos-15` VM 上、显式 `DOWNANY_ALLOW_PINNED_GLOBAL_CPYTHON_INSTALL=1` 时运行，先核对 artifact size/SHA，再执行固定 commit 内的安装脚本；构建解释器必须解析为锁中精确的 global framework 路径，release venv/wheelhouse/report 仍位于随机临时 containment。失败或成功只清理下载物、venv 和 toolcache link，不删除/回滚全局 framework；安全隔离边界是随后销毁的 hosted VM。非一次性本地机器默认拒绝全局安装，只允许显式传入已按同一 runtime lock 全量验证的 `DOWNANY_RELEASE_PYTHON`。

`packaging/cpython-windows-runtime.lock.json` 的精确 schema 为 `{schemaVersion:1,platform:"windows-x64",cpython:{version,repository,commit,source:{url,sha256},installer:{url,size,sha256},pcbuild:{propsPath,getExternalsPath}},runtimePolicyPath,components:[...],expectedMemberPaths:[...]}`。`expectedMemberPaths` 是从干净 PyInstaller onedir 审核后提交的、按 UTF-8 字节序排序的精确对象数组；每项固定 `{path,componentIds,sourceDisposition,imports}`，其中 import 精确为 `{basename,kind,resolution,resolvedPath?}`，`kind` 只能是 `import|delay_import`，`resolution` 只能是 `bundled|api_set|system32`，仅 bundled 带同一 onedir 内的 case-sensitive POSIX `resolvedPath`。`path` 必须以 `.exe/.dll/.pyd` 结尾，不允许 glob、目录前缀或兜底；集合覆盖 `DownanySidecar.exe`、CPython DLL/stdlib extension、curl-cffi wrapper 和全部随包第三方 DLL。`componentIds` 不得为空；`sourceDisposition` 只能是 `corresponding_source`，唯一例外是 Microsoft runtime 的 `vendor_redistributable`。

`packaging/cpython-macos-runtime.lock.json` 的精确 schema 为 `{schemaVersion:1,platform:"macos-arm64",buildInterpreterArtifact:{repository,commit,releaseTag,filename,url,size,sha256,installScriptPath,globalFrameworkRoot,interpreterPath},cpython:{version,repository,commit,source:{url,sha256},buildRecipePath},systemLibraryRoots,components:[...],expectedMachOMembers:[...]}`。`buildInterpreterArtifact` 固定 repository `https://github.com/actions/python-versions.git`、commit `3970f04eb4bba03837ff4e67052f87c963a18f4d`、releaseTag `3.11.9-9947079978`、filename `python-3.11.9-darwin-arm64.tar.gz`、URL `https://github.com/actions/python-versions/releases/download/3.11.9-9947079978/python-3.11.9-darwin-arm64.tar.gz`、size `44566846`、SHA256 `8039644e495c8afb213d3ecb04e9cc3739bb4ddac258432a205cf463997bbeff`、`installScriptPath="setup.sh"`、`globalFrameworkRoot="/Library/Frameworks/Python.framework/Versions/3.11"`、`interpreterPath="/Library/Frameworks/Python.framework/Versions/3.11/bin/python3.11"`。安装前验证 runner 声明为 `github-hosted`、root/解释器值与 lock 精确相等、脚本来自锁定 commit且包含预期 `installer -target /` 配方；安装后 realpath、`sys.version`、arm64 slice、minOS 和 runtime member report 必须匹配 lock，任何其他 framework version/path 都失败。`cpython` 固定同一 CPython commit/source，并把 `Mac/BuildScript/build-installer.py` 作为 binary/source 映射配方；Task 13 测试从该配方确定实际 component 的版本、官方 source URL/SHA、licenseSourcePath 与 stagedLicensePath并写入 lock，集合只允许 CPython、PyInstaller、平台 wheel/source lock、macOS curl-cffi closure，以及实际进入 onedir 的 OpenSSL/SQLite/bzip2/XZ/libffi/zlib，macOS 禁止 `vendor_redistributable`。复用已提交的相同上游许可证全文，但每个 macOS component 必须有独立精确 source 映射，不能借用 Windows binary 版本声明。

`expectedMachOMembers` 是按 UTF-8 path 排序的精确对象数组，每项固定 `{path,componentIds,sourceDisposition,rpaths,imports}`；`rpaths` 是解析全部 `LC_RPATH` 后按原始 path 字节序排序的精确字符串数组。imports 按 `{kind,installName}` 排序，每项固定 `kind:"load"|"weak_load"|"reexport"|"upward"|"lazy_load"`，并且只能是 `{kind,installName,resolution:"bundled",resolvedPath}` 或 `{kind,installName,resolution:"system_library"}`。verifier 必须解析 `LC_LOAD_DYLIB`、`LC_LOAD_WEAK_DYLIB`、`LC_REEXPORT_DYLIB`、`LC_LOAD_UPWARD_DYLIB`、`LC_LAZY_LOAD_DYLIB` 和 `LC_RPATH`，不能把 re-export/upward/lazy 省略。`@loader_path`、`@executable_path` 与 `@rpath` 只能按该 member 的 locked rpaths 和平台 loader 规则得到唯一结果；bundled target 必须唯一解析到 Sidecar containment 内另一个 expected member，零解、多解、containment escape 或未登记 rpath 均失败；system library 只能位于 `/System/Library/` 或 `/usr/lib/`。禁止 Homebrew、runner temp、build tree、绝对第三方路径、缺失 target 与 containment escape。`sidecar.spec` 显式排除 `tkinter/_tkinter/Tcl/Tk`，避免带入未登记的 GUI runtime。

component 集合必须至少精确包含以下固定来源，且锁中写入这里列出的 40 位 commit，不允许只保留 tag：

| component id | version / source commit | binary origin | license file |
|---|---|---|---|
| `cpython-3.11.9` | `python/cpython@7cd4a91608030a5a404220c0beb1f307de84af26` | 上述官方 installer | `CPython-PSF-2.0.txt` |
| `pyinstaller-6.17.0` | `sidecar-sources.lock.json` 中固定 sdist/SHA | 固定 wheel 的 bootloader | Python source lock 中的 PyInstaller license |
| `openssl-3.0.13` | `python/cpython-source-deps@a5c15eb94f2878e44ffc74086b0cd2ea8db55488` | `python/cpython-bin-deps@ef79995d51245acd8a5653df7cc9116bb3cfd01b` | `OpenSSL-Apache-2.0.txt` |
| `sqlite-3.45.1.0` | `python/cpython-source-deps@0385e654db3abda17a83d81a74f463fc067da80a` | CPython installer | `SQLite-Public-Domain.txt` |
| `bzip2-1.0.8` | `python/cpython-source-deps@05301997b2f9590f49c672cf3dfd3d3dfa7ad521` | CPython installer | `bzip2-License.txt` |
| `xz-5.2.5` | `python/cpython-source-deps@c6bc0c612605622aaef101a33a751f9de2ecc193` | CPython installer | `XZ-COPYING.txt` |
| `libffi-3.4.4` | `python/cpython-source-deps@73b247f34ef3ae1859b8c2c34d321d34ebc5db15` | `python/cpython-bin-deps@94cb9a1c7feb608adf2b9f8fe2dbd6925ffbf90d` | `libffi-MIT.txt` |
| `zlib-1.3.1` | `python/cpython-source-deps@4dc98e1909830e2bdc2a9cc2236e3c5d5037335b` | CPython installer | `zlib-Zlib.txt` |
| `msvc-runtime-v143` | official VS 2022 redistributable；无 corresponding source 声明 | installer 内实际文件 SHA + Microsoft 有效签名 | `Microsoft-Visual-Cpp-Runtime.txt` |
| `curl-cffi-native` | 引用 `curl-cffi-native.lock.json` 的平台组件集合 | 固定 curl-cffi wheel | 十一份 native license |

测试必须解析 pinned CPython checkout 的 `PCbuild/python.props` 与 `PCbuild/get_externals.bat`，断言它们精确引用 OpenSSL `3.0.13`、SQLite `3.45.1.0`、bzip2 `1.0.8`、XZ `5.2.5`、libffi `3.4.4`、zlib `1.3.1` 以及相应 `openssl-bin/libffi`，并逐项等于 runtime lock；上游配方漂移即失败。八份 runtime license 必须与锁中 `licenseSourcePath` 的固定 checkout/官方 redistributable 文本逐字相等。`msvc-runtime-v143` 是唯一 `vendor_redistributable`，必须同时固定 installer member SHA、PE version、Microsoft signer 和 redistributable notice；不能虚构对应源码，也不能把其他闭源或未映射 DLL塞进该例外。

requirements lock 中的多个合法 hash 只是候选集合，不能证明 release 最终安装了哪个 wheel。两端 release 构建统一调用：

```text
python scripts/install_sidecar_locked.py --platform <macos-arm64|windows-x64> --requirements packaging/requirements-sidecar-<platform>.lock.txt --artifact-lock packaging/sidecar-install-artifacts.lock.json --wheelhouse <temporary-wheelhouse> --venv-python <venv-python> --raw-report <temporary-pip-report.json> --normalized-report <sidecar-install-report-<platform>.json>
```

脚本先证明 artifact lock 的规范化 package/version 集合与 platform requirements lock 完全相等，再由 artifact lock 生成仅含“固定 HTTPS wheel URL + 单一 SHA256”的临时 download requirements；不得把多 hash requirements 直接交给 pip 临场选择平台 wheel。`sidecar-install-artifacts.lock.json` 固定为 `{schemaVersion:1,platforms:{macos-arm64:{artifacts:[...]},windows-x64:{artifacts:[...]}}}`，每个 artifact 精确含 `{name,version,filename,originUrl,sha256,kind:"wheel"}`。以该 venv Python 执行 `pip download --no-index --require-hashes --only-binary=:all: --no-deps` 写入空 wheelhouse，逐个核对文件名和 SHA；随后生成只允许已下载文件名/单一 hash 的 install requirements，再执行 `pip install --no-index --find-links <wheelhouse> --require-hashes --only-binary=:all: --no-deps --report <raw-report>`。规范化报告 DTO 精确为 `{schemaVersion:1,platform,pythonVersion,requirementsSha256,artifacts:[{name,version,filename,originUrl,sha256,kind}],nativeMembers:[{distribution,path,sha256,size,format,architectures,imports,minOs}]}`；两个数组分别按规范化 package name 与 POSIX path 字节序排序，禁止临时绝对路径、时间戳和环境字符串，pip report 的临时 `file://` 只能按唯一 filename+SHA 映射回 artifact lock 中的原始 HTTPS URL，无法唯一映射即失败。`artifacts` 必须与 `sidecar-install-artifacts.lock.json` 对应平台数组精确相等，wheelhouse 中多一个/少一个文件都失败；Task 15 的 PyInstaller 完成后再对 onedir 运行同一 native verifier，证明锁定原生成员确实进入 Sidecar。

artifact lock 必须至少包含 curl-cffi 0.15.0 的这两个真实 CPython 3.11 兼容 abi3 wheel，并对其余安装分发采取同样的精确记录：

| 平台 | filename | URL | SHA256 |
|---|---|---|---|
| `macos-arm64` | `curl_cffi-0.15.0-cp310-abi3-macosx_11_0_arm64.whl` | `https://files.pythonhosted.org/packages/83/2d/3915e238579b3c5a92cead5c79130c3b8d20caaba7616cc4d894650e1d6b/curl_cffi-0.15.0-cp310-abi3-macosx_11_0_arm64.whl` | `a25620d9bf989c9c029a7d1642999c4c265abb0bad811deb2f77b0b5b2b12e5b` |
| `windows-x64` | `curl_cffi-0.15.0-cp310-abi3-win_amd64.whl` | `https://files.pythonhosted.org/packages/d8/8c/2abf99a38d6340d66cf0557e0c750ef3f8883dfc5d450087e01c85861343/curl_cffi-0.15.0-cp310-abi3-win_amd64.whl` | `5a0c1896a0d5a5ac1eb89cd24b008d2b718dd1df6fd2f75451b59ca66e49e572` |

curl-cffi 自身的 sdist 固定为 `https://files.pythonhosted.org/packages/48/5b/89fcfebd3e5e85134147ac99e9f2b2271165fd4d71984fc65da5f17819b7/curl_cffi-0.15.0.tar.gz`，SHA256 `ea0c67652bf6893d34ee0f82c944f37e488f6147e9421bef1771cc6545b02ded`。但该约 196 KB sdist 不含 wheel 内静态链接的完整原生源码，所以不能把它当作 native source closure。

`curl-cffi-native.lock.json` 的精确 DTO 为 `{schemaVersion:1,curlCffi:{version,repository,commit,sdist:{url,sha256}},platforms:{<platform>:{wheel:{filename,url,sha256},upstreamBinary:{name,url,sha256},requiredNativeKinds,componentIds}},components:[{id,repository,commit,licenseExpression,licenseSourcePath,stagedLicensePath,platforms}]}`。`platforms.macos-arm64.componentIds` 与 `platforms.windows-x64.componentIds` 都必须显式包含 `sfparse`；各自再精确列出共同组件与该平台独有的 zlib/brotli component id，不能只把 sfparse 放进全局 `components[]`。`curlCffi.repository` 固定 `https://github.com/lexiforest/curl_cffi.git`，commit 固定 `0e219c43701f955436ef4a20486a7237a417dbc6`；该 commit 的 `scripts/build.py` 固定下载 curl-impersonate 1.5.2。macOS upstream asset 为 `libcurl-impersonate-v1.5.2.arm64-macos.tar.gz`、SHA256 `101b39b1e2e9e529b3eedbdca1da71c80ff84c781f3504c05cf45774d52068de`；Windows asset 为 `libcurl-impersonate-v1.5.2.x86_64-win32.tar.gz`、SHA256 `695b772cec0aec35efa443bb2da265b84bba23fd139b3fc6fd25c2a514e0fd77`，URL 都固定在 `https://github.com/lexiforest/curl-impersonate/releases/download/v1.5.2/` 下。

`platforms.windows-x64` 引用独立的 `packaging/sidecar-windows-runtime-policy.json`，绝不能复用 Telegram static executable 的 DLL deny policy。真实 wheel 合同固定 `requiredWheelDlls=[]`，`requiredNativeMembers` 精确为：

```json
[
  {
    "path": "curl_cffi/_wrapper.pyd",
    "format": "PE",
    "machine": "8664",
    "size": 3232768,
    "sha256": "f640dce86563f9814a11c5452cb84eef85c58243eab37d6ccb9672a966148112"
  }
]
```

wheel `RECORD` 对应行必须精确为 `curl_cffi/_wrapper.pyd,sha256=9kDc6GVj-YFKEcVFLLhO74XFgkPqs31sy5ZyqWYUgRI,3232768`，同时核对 base64url digest 与 hex lock。runtime policy 固定为：

```json
{
  "schemaVersion": 2,
  "normalization": "ascii-lowercase-basename",
  "curlWrapperDirectImports": {
    "exactFrozenRuntimeFiles": [
      "python3.dll",
      "vcruntime140.dll"
    ],
    "exactWindowsApiSetContracts": [
      "api-ms-win-crt-convert-l1-1-0.dll",
      "api-ms-win-crt-environment-l1-1-0.dll",
      "api-ms-win-crt-filesystem-l1-1-0.dll",
      "api-ms-win-crt-heap-l1-1-0.dll",
      "api-ms-win-crt-math-l1-1-0.dll",
      "api-ms-win-crt-runtime-l1-1-0.dll",
      "api-ms-win-crt-stdio-l1-1-0.dll",
      "api-ms-win-crt-string-l1-1-0.dll",
      "api-ms-win-crt-time-l1-1-0.dll",
      "api-ms-win-crt-utility-l1-1-0.dll"
    ],
    "exactSystem32Files": [
      "crypt32.dll",
      "iphlpapi.dll",
      "kernel32.dll",
      "normaliz.dll",
      "wldap32.dll",
      "ws2_32.dll"
    ]
  },
  "fullTreeResolution": {
    "apiSetPrefixes": ["api-ms-win-", "ext-ms-win-"],
    "system32": {
      "allowedRootEnvironmentVariable": "SystemRoot",
      "allowedRelativeRoot": "System32",
      "denyPathSeparators": true,
      "requireAuthenticodeStatus": "Valid",
      "requireSignerOrganization": "Microsoft Corporation"
    }
  }
}
```

wheel 阶段要求 `_wrapper.pyd` 的 direct-import basename 集合与 `curlWrapperDirectImports` 三组并集精确相等，但不错误要求 Python/MSVC runtime 位于 wheel 内。`verify_curl_cffi_native.py` 只能读取这个窄集合。PyInstaller onedir 的全树合同完全独立：`verify_cpython_windows_runtime.py` 为每个 PE 重新枚举普通与 delay imports，与该 member 在 committed runtime lock 中的 `imports` 精确比较；bundled import 必须唯一解析到同一 containment 内的 expected member，API-set 必须匹配 policy prefix，system32 必须是 `%SystemRoot%\System32` 的直接 regular child并通过 Microsoft 签名合同。`python3.dll/python311.dll` 还要求 Python Software Foundation 有效签名，`vcruntime140.dll` 要求 Microsoft 有效签名。不得把 wrapper 的 2+10+6 集合当作整个 onedir 的 allowlist；任何额外逐成员 import、重复 basename、PATH/current-directory 解析、路径逃逸或未解析 runtime 都失败。

component 集合必须精确为：curl-impersonate `9607b22ccf6c440e560c5f8ad5292b8044bb6dd7`、curl `cfbfb65047e85e6b08af65fe9cdbcf68e9ad496a`、BoringSSL `673e61fc215b178a90c0e67858bbf162c8158993`、zstd `794ea1b0afca0f020f4e57b6732332231fb23c70`、nghttp2 `8f44147c385fb1ed93a6f39911eeb30279bfd2dd`、nghttp3 `d326f4c1eb3f6a780d77793b30e16756c498f913`、ngtcp2 `ca898d32348c93af9fbbc81538505a1c1c062685`、nghttp3 的 sfparse gitlink `ff7f230e7df2844afef7dc49631cda03a30455f3`；macOS 再含 zlib `51b7f2abdade71cd9bb0e7a373ef2610ec6f9daf` 与 brotli `028fb5a23661f123017c060daa546b55cf4bde29`；Windows 再含 zlib `09155eaa2f9270dc4ed1fa13e2b4b2613e6e4851` 与 brotli `ed738e842d2fbdf2d6459e39267a633c4a9b2f5d`。repository 依次固定为 `https://github.com/lexiforest/curl-impersonate.git`、`https://github.com/curl/curl.git`、`https://boringssl.googlesource.com/boringssl`、`https://github.com/facebook/zstd.git`、`https://github.com/nghttp2/nghttp2.git`、`https://github.com/ngtcp2/nghttp3.git`、`https://github.com/ngtcp2/ngtcp2.git`、`https://github.com/ngtcp2/sfparse.git`、`https://github.com/madler/zlib.git` 与 `https://github.com/google/brotli.git`；zlib/brotli 两个平台 component id 分开，但 repository/license 可相同。每项必须有该官方 repository、40 位 commit、平台集合和 license source path；对应文件依次为 `curl_cffi/LICENSE`、`curl-impersonate/LICENSE`、`curl/COPYING`、`boringssl/LICENSE`、`zlib/LICENSE`、`zstd/LICENSE`、`brotli/LICENSE`、`nghttp2/COPYING`、`nghttp3/COPYING`、`ngtcp2/COPYING`、`sfparse/COPYING`。BoringSSL 使用 `LicenseRef-BoringSSL` 并原样携带完整复合 LICENSE，不能错误压缩成单一 SPDX。十一份已提交许可证必须与这些固定 checkout 的原文逐字相等；verifier 还必须读取 nghttp3 的 `.gitmodules` 和 gitlink mode/commit，证明 `lib/sfparse` 恰好指向该 sfparse component。

`verify_curl_cffi_native.py` 同时验证 wheel 顶层 SHA/filename/platform tag、wheel `RECORD` 中每个 native member 的 hash/size，以及实际安装/冻结树中 curl-cffi distribution 子树的对应文件。macOS native member 精确包含 `_wrapper.abi3.so`，每个 Mach-O 必须只有 arm64 且 deployment target `<=11.0`。Windows wheel native member精确只有 `curl_cffi/_wrapper.pyd`，不得要求或允许 wheel DLL；PE 必须为 AMD64，direct imports 与 `curlWrapperDirectImports` 精确相等。curl-cffi 子树内任一 `.exe`、`.sys`、未报告 native member或把全树 policy 套到 wrapper 都失败；Sidecar 根与其他 CPython members 由平台全树 verifier 负责。脚本还读取固定 curl-cffi checkout 的 `scripts/build.py`/`libs.json` 与固定 curl-impersonate checkout 的 `Makefile.in`/`build-win.yaml`，要求版本、asset 名、nghttp3→sfparse gitlink 和 component 集合与 native lock 精确相等。fixture 覆盖错 wheel、错平台、意外 wheel DLL、wrapper import 漂移、全树标准系统 import 不应被 wrapper allowlist 拒绝、sfparse/source/license 漂移和安装报告不等。

`scripts/verify_cpython_windows_runtime.py --onedir PATH --lock packaging/cpython-windows-runtime.lock.json --curl-lock packaging/curl-cffi-native.lock.json --policy packaging/sidecar-windows-runtime-policy.json --report OUTPUT` 递归枚举 onedir 内每个 `.exe/.dll/.pyd` regular non-link 文件，并输出规范化 `{schemaVersion:1,platform,pythonVersion,installerSha256,lockSha256,members:[{path,size,sha256,format,machine,imports:[...],signature:{status,organization,subjectSha256}|null,componentIds,sourceDisposition}]}`；数组、imports 和 component IDs 都按 UTF-8 字节序排序，不含绝对路径、时间戳、runner 名或用户名。`members[].path/componentIds/sourceDisposition/imports` 必须与 lock 的 `expectedMemberPaths` 逐字段精确相等；每个文件都记录实际 size/SHA256，PE machine 必须 `8664`，bundled/API-set/System32 按独立 full-tree policy 解析。脚本随后证明每个 `corresponding_source` component 都有固定 source commit/archive、license 与 source-bundle path；`vendor_redistributable` 恰好只能是锁定 MSVC runtime且签名/版本/notice 全匹配。任何额外 PE、漏 member、import 漂移、重复 basename、额外 vendor exception、路径逃逸或缺 source/license 都失败。

同一脚本第二次传 `--expected-report REPORT` 时不得重写报告，而是重新枚举安装包/解包 onedir 并逐字段比较；Task 15 用它证明最终 NSIS 内的原生树和打包前报告完全一致。跨平台的 `--validate-report REPORT` 模式不读取 PE，只验证规范化 schema、lock/report path 与 component exact-set、每项 64 位 SHA、sourceDisposition 和 source/license closure，供 Ubuntu sources job 在消费 Windows artifact 后再次门禁。fixture 必须覆盖新增 DLL/PYD、删除 extension、同名不同目录、改一个字节、错 component、把 OpenSSL 错映射为 Microsoft exception、缺 source/license、伪 Microsoft 签名、绝对路径泄漏和安装包树与报告不等。`verify_curl_cffi_native.py` 只负责 curl-cffi wheel/配方闭包，`verify_cpython_windows_runtime.py` 负责最终 Windows onedir 的全体 PE；两者都必须通过，不能用前者代替全树审计。

`scripts/verify_macos_package_arch.sh APP_PATH arm64 11.0 --runtime-lock packaging/cpython-macos-runtime.lock.json --report REPORT` 除现有全 app Mach-O 门禁外，递归枚举 `Contents/Resources/sidecar/DownanySidecar` 的全部 Mach-O，要求架构精确 arm64、minOS `<=11.0`，解析上述五类 dependency-bearing load command 与全部 `LC_RPATH`，并输出规范化 `{schemaVersion:1,platform,pythonVersion,buildInterpreterArtifactSha256,lockSha256,members:[{path,size,sha256,architectures,minOs,rpaths,imports,componentIds,sourceDisposition}]}`；成员集合、逐成员 rpaths、带 kind 的 imports 和唯一解析结果必须与 committed macOS lock 精确相等。传 `--expected-report REPORT` 时重新枚举包内 Sidecar 并逐字段比较，不得重写；传 `--validate-report REPORT --runtime-lock LOCK --curl-lock CURL_LOCK` 时只做 JSON/lock/source/license closure 验证，供 Ubuntu sources job 使用。任何新增、缺失、未映射 Mach-O、load-command kind/rpath 漂移、歧义/越界解析、非 arm64、过高 minOS、非系统绝对 dylib 或 source/license 缺口都失败；fixture 至少各覆盖 reexport/upward/lazy、缺/多 rpath、`@rpath` 歧义和逃逸。

`sidecar-THIRD_PARTY_LICENSES.txt` 由 Python source lock、curl-cffi native lock 与两个 CPython runtime lock 确定性生成并提交，覆盖 yt-dlp、curl-cffi、PyInstaller、CPython、全部传递依赖、上述十一份 native license及两个平台实际 runtime component 的许可证/notice；同一上游许可证可复用已提交全文，但两个 lock 的 version/source 映射必须各自精确。缺 sdist/license、runtime/native component 或任一集合不等立即失败。

`scripts/build_release_source_bundle.sh VERSION OUTPUT_DIR --macos-native-report MAC_REPORT --windows-native-report WIN_REPORT` 只接受这两个位置参数及按该顺序出现的两个 option/value pair，不接受 URL/version/SHA 环境覆盖；两份报告必须先分别通过 committed runtime lock 的 validate 模式，成功时只输出 `OUTPUT_DIR/Downany-third-party-sources-VERSION.tar.zst`。包内顶层精确为 `BUILD.md`、`SOURCE-MANIFEST.json`、`MANIFEST.sha256`、`LICENSES/`、`telegram/`、`sidecar/`、`ffmpeg/macos/`、`ffmpeg/windows/`、`openssl/`、`zlib/`。`telegram/` 包含 pinned superproject 与全部 submodule 的独立 tracked-files archive。Sidecar 目录同时包含 CPython archive、source lock 的全部 sdists、两份 platform requirements lock、artifact/native/runtime policy、两个 CPython runtime lock与两份规范化 native report；`SOURCE-MANIFEST.json` 必须把每个平台每个 `corresponding_source` member 精确映射到唯一 source archive 与 license，缺任一平台、额外 member、报告/lock 不等或 source/license 不闭合都失败。CPython external source-deps 的固定 commit 各自独立归档；Windows OpenSSL/libffi 还记录 bin-deps 与实际 DLL SHA 映射，MSVC 只含 vendor notice，绝不能伪造源码。nghttp3 的 sfparse gitlink独立归档；curl-cffi wheel/预编译 archive只以名称/SHA映射到源码。macOS/Windows FFmpeg、Telegram、OpenSSL/zlib 源码闭包继续按前述 lock 精确收集。

Windows source 收集在 pinned BtbN checkout 中运行 `./generate.sh win64 lgpl 7.1`，只收入生成 Dockerfile 实际引用的 selected stages。`BUILD.md` 固定记录 Telegram recursive checkout、OpenSSL/zlib 校验、curl-cffi closure、两平台 CPython build artifact/runtime lock、两份 native report 复核，以及固定 FFmpeg 重建命令。`SOURCE-MANIFEST.json` 把 Windows binary SHA、macOS commit、Telegram commits、两份 requirements lock、两个 curl-cffi wheel/原生资产、native component commits、两个 CPython runtime lock SHA，以及报告中每个 PE/Mach-O 的 path/size/SHA/imports/component IDs（macOS 另含 load-command kind 与 rpaths）映射到唯一 source/patch/build script/license或唯一 Windows MSVC redistributable notice；macOS 不允许 vendor exception。`MANIFEST.sha256` 覆盖自身之外全部文件。

`verify_release_source_bundle.mjs` 拒绝绝对路径、`..`、symlink、重复路径、DMG/NSIS/PE/Mach-O、wheel、libcurl-impersonate 预编译 archive、credential/token 和 lock 外文件，并验证 Telegram superproject 与递归 submodule集合、每个锁定 source、每个 curl-cffi native component/license、nghttp3→sfparse gitlink及其独立 source/COPYING、CPython runtime report 中每个 `corresponding_source` component 的独立 source/license、唯一 MSVC vendor exception notice、OpenSSL/zlib archive 都恰好出现一次，且全部内部 SHA 与顶层结构正确。native report 的 member path/SHA/component 集合必须与 `SOURCE-MANIFEST.json` 精确相等；多一个未映射 PE 记录或少一个 component source 都失败。tiny fixture 覆盖缺 Telegram submodule、缺 source、缺 native/runtime component/license、额外 PE、错 component、伪造 MSVC source/exception、sfparse gitlink 错 commit、只有空 gitlink 无 source、缺 sfparse COPYING、错误 SHA、curl-cffi recipe 漂移、混入 native binary/wheel、Dockerfile 未覆盖 stage、混入 GPL/nonfree、路径逃逸和重复 entry；release workflow 再运行真实网络集成。`SOURCE-OFFER.txt.in` 固定生成 `https://github.com/JackEngineer/downany/releases/download/v${version}/Downany-third-party-sources-${version}.tar.zst`。文档只称“固定 Telegram 源码、可审计构建”，不宣称所有 toolchain 输入可位级复现。

- [ ] **Step 5: 实现秘密安全的资源生成器**

`generate_telegram_build_credentials.mjs` 从 `DOWNANY_TELEGRAM_API_ID/HASH` 生成：

```json
{"schemaVersion":1,"apiId":"123456","apiHash":"0123456789abcdef0123456789abcdef"}
```

文件写到 `desktop/resources/telegram-bot-api/app-credentials.json`，仅 stdout 输出目标路径和“created”，不输出值。credential bytes 固定为 UTF-8、无 BOM、compact单行 JSON加唯一 LF，精确等于 `Buffer.from(JSON.stringify({schemaVersion:1,apiId,apiHash}) + "\n", "utf8")`；`apiId` 匹配 `^[1-9][0-9]*$`，`apiHash` 匹配 `^[0-9A-Fa-f]{32}$`且保留输入大小写。生成器、resource verifier 与 package-aware scanner 都用同一 canonical bytes，拒绝字段重排/重复/额外字段、CRLF、BOM或尾随内容。`generate_telegram_resource_manifest.mjs` 枚举当前平台 executable、license 和静态依赖 notices，输出 filename/size/sha256/upstreamCommit，明确跳过 credentials。manifest 必须包含 `licenses/BSL-1.0.txt`、`licenses/OpenSSL.txt`、`licenses/zlib.txt` 与 `licenses/THIRD_PARTY_NOTICES.md`；Windows static 构建不应出现第三方 DLL。

`scripts/audit_telegram_secrets.ps1` 是 Task 17 所有秘密门禁唯一允许调用的扫描实现，exact CLI 为 `[-Repository] [-StagedOnly] [-Path <path>]... [-ExpandZip <zip>] [-PackageArtifact <file> -PackageRoot <directory> -PackagePlatform <macos-arm64|windows-x64>]`；三个 package参数必须全有或全无且每次最多一组，`PackageArtifact`必须是existing regular non-link file，`PackageRoot`必须是existing non-link directory，且不得与Path/ExpandZip scope重叠。语法/API同时兼容Windows PowerShell 5.1与PowerShell 7，不能要求Windows工作机额外存在`pwsh`。`-Repository` 必须扫描 `git ls-tree -r HEAD` 的每个 path/blob、index 中每个 ACMR path/blob，以及 `git ls-files --cached --others --exclude-standard` 对应的当前工作树 path/content，不能因 index 为空而跳过冻结 HEAD。`-StagedOnly` 仍先扫描 HEAD，再扫描 index，供 evidence commit 前使用。每个 path 字符串本身也作为输入扫描。普通 Repository/Path/ExpandZip调用必须提供三个非空环境值；package-only只要求真实API ID/hash，Bot Token可缺省但通用Token regex始终启用；package与普通scope并用仍要求三项真实值。脚本对每个已提供真实值生成 raw、`EscapeDataString`、大小写 `%3A`，并最多三轮严格percent-decode。内置allowlist只能逐字移除明确固定synthetic值及编码形式，不能按目录名、tests或fixtures整类放行。`-ExpandZip` 先扫zip原始bytes/entry name，再在随机temp拒绝symlink/zip-slip/重复path后展开扫描并containment清理。任一命中只以固定退出码和`secret audit failed`失败，不能打印值、来源、path、行号、片段或异常对象；读取/解码/Git/zip枚举失败同样fail closed。

package mode把DMG/NSIS原始bytes作为Bot Token补充门禁，并对真实DMG挂载卷根/NSIS安装根执行完整逐文件扫描；API ID/hash以展开树为权威。macOS `PackageRoot`必须是DMG mount root，唯一 credential逻辑路径是`Downany.app/Contents/Resources/telegram-bot-api/app-credentials.json`；Windows唯一逻辑路径是`resources/telegram-bot-api/app-credentials.json`，均以`/`规范化后ordinal case-sensitive比较。该文件必须恰好一个、regular non-link、bytes精确等于generator canonical bytes；只有其中API ID/hash两个JSON value byte-span可豁免。文件名、其余bytes、任意其他path/file中的raw/encoded/二次解码API值都失败；Bot Token/通用Token形态在credential文件内也永不豁免。扫描不跟随link递归；macOS只允许卷根唯一标准项`Applications`是symlink且target逐字为`/Applications`，scanner扫描其path/target、把它纳入manifest但绝不跟随；除此之外每个link target规范化后必须仍在PackageRoot。其他越界link、第二个Applications link、重复/大小写冲突path、special file、读取失败均fail closed。所有binary流式扫描并保留跨chunk carry，禁止整件DMG/NSIS/Electron binary读入内存。

树manifest在内存按UTF-8 path bytes排序，相对根路径为`.`的根目录与所有子目录都必须入表；directory项为`{path,type:"directory"}`，regular项为`{path,type:"file",size,sha256}`，link项为`{path,type:"symlink",target}`，禁止其他字段。标准`Applications → /Applications`同样进入manifest；所有directory/file/link的path和link target都经秘密扫描，目录名不得成为漏洞。scanner只输出compact JSON的SHA。package成功时stdout恰好一行strict receipt `{schemaVersion:1,mode:"package_tree",platform,policy:"telegram-app-credentials-v1",artifactSha256,treeManifestSha256,entryCount,regularFileCount,treeBytesScanned,credentialFileCount:1,result:"passed"}`；`entryCount >= regularFileCount >= 1`、`treeBytesScanned > 0`、两个SHA为64位lowercase hex。失败stdout为空且stderr仍只有固定错误；非package模式保持原输出合同。`telegramPackaging.test.mjs` 除原fixture外，用可用的PowerShell 5.1/7证明相同输入同退出码；临时Git覆盖clean HEAD命中、filename encoded token、非fixture通用token、二次编码、真实API值、zip entry与synthetic正负例。两平台package-tree fixture还覆盖canonical credential唯一时通过；mac fixture以完整mount root为输入，标准`Applications → /Applications`唯一放行但不跟随，并证明`.background`、卷图标、任意app外隐藏文件或目录名含API值/Token时失败。API值出现在其他file/path/encoded内容、缺失/重复/错path、字段重排/额外/重复、BOM/CRLF、credential symlink、root reparse、非标准/重复/越界link、path冲突均失败；Bot Token在credential/普通file/path/artifact raw bytes的raw/encoded/二次编码均失败，且stdout/stderr不含fixture值或路径。

上段scanner的Git入口以此处完整签名为唯一权威：CLI追加`[-GitExecutable <canonical-absolute-path> -ExpectedHead <40-lowercase-hex>]`，两项必须同时出现且只允许在`-Repository`或`-StagedOnly`存在时出现；任一Git scope缺少它们、非Git scope携带它们、相对/裸名/PATH解析、HEAD不等或参数组合错误都在任何扫描/child spawn前失败。scanner只能以该绝对路径、`shell=false`、二进制stdout/stderr管道执行exact只读argv集合：`rev-parse --verify HEAD`、`ls-tree -r -z <ExpectedHead>`、`ls-files --stage -z`、`ls-files --cached --others --exclude-standard -z`以及按前两条输出得到的唯一40/64位object ID执行`cat-file blob <oid>`；禁止`show`、任意ref/pathspec/config参数、任意写命令或从文本shell拼接。首尾`rev-parse`都必须等于ExpectedHead；tree/index object与工作树regular-file path全部按raw NUL协议解析，blob以原始bytes扫描，不能经过PowerShell字符串转码。Task17调用时Git只能来自下文`Invoke-ReleaseSecretScannerOwned`建立的read-only owned scanner-Git环境；Task13独立fixture必须显式提供同等临时隔离环境。测试新增replace-ref把HEAD映射到无秘密替代tree、危险`core.fsmonitor/alternateRefsCommand`、system/global/local/worktree config污染、父`GIT_*`与PATH首位fake Git、binary blob/NUL path；scanner必须仍扫描真实ExpectedHead bytes，所有sentinel与Git mutation为零，任何不安全local/worktree config都fail closed。

紧接上段的Git三项参数以此处为最终exact集合：`-GitExecutable <canonical-absolute-path> -ExpectedHead <40-lowercase-hex> -GitEnvironmentPolicySha256 <64-lowercase-hex>`必须三项全有或全无，且仍只允许Repository/StagedOnly互斥scope。scanner对Git child的环境只接受下文runner预构造的credential-free policy；参数hash不等、缺失/额外凭据键或任意额外env键都在Git spawn前失败。

scanner Git参数组最终固定为：Repository scope精确携带`-GitExecutable/-ExpectedHead/-GitEnvironmentPolicySha256`三项且禁止`-GitIndexPath`；StagedOnly精确携带同三项再加`-GitIndexPath <canonical-absolute-path>`，后者必须由runner从当前raw publication marker的`evidenceIndexRelativePath`与candidate staging containment派生，且native owner的`sourceMarkerSha256`必须逐字等于该marker raw SHA。其他scope携带任一Git参数都失败。scanner对GitIndexPath逐ancestor拒绝link/reparse、要求existing regular non-link、禁止越界/real index/任意用户路径，并把canonical path纳入credential-free environment policy preimage；Git调用前后index raw SHA与stage manifest必须逐字不变。绝对路径只存在于本次private argv/内存，native identity只散列argv，owner/receipt/log不得保存或输出它。

- [ ] **Step 6: 设置 ignore 规则**

忽略 `desktop/resources/telegram-bot-api/**`、`desktop/resources/process-host/**` 与 `desktop/resources/third-party-licenses/**`，各自仅反向包含 `.gitkeep`；确认现有 `desktop/resources/bin/**` 规则继续覆盖 FFmpeg executable staging，但许可证只进入 `third-party-licenses`。忽略 `.build/telegram-bot-api/`、`.build/process-host/`、`.build/ffmpeg-macos/`、`.build/vcpkg/`、`.build/vcpkg_installed/` 与本地生成的 source bundle。测试只在临时目录生成文件。

- [ ] **Step 7: 跑测试与静态秘密检查**

```powershell
node --test scripts/tests/telegramPackaging.test.mjs
git check-ignore desktop/resources/telegram-bot-api/app-credentials.json desktop/resources/telegram-bot-api/telegram-bot-api.exe desktop/resources/process-host/DownanyProcessHost.exe
rg -n "adfd7f6a8e990272851777eeb3ae0def4216f161|ea1a7396b05637a53bf23c078647ecc0edee4b80|68af2cc3feb8c78aec2722c728fd87f03515fa7c|aae016bfd52fcad2bc9657c2c782cfdf73b1ed5f|bb329a0a2cd0274d05519d61c667c062e06990d72e125ee2dfa8de64f0119d16|1fdbca85aaea513c9cc6c14d347f76543346d3da|b7c1c846dacca68ee4ebf5c390742c973b3d5d14a6d44b061f500d8e4ac74fc0|0e219c43701f955436ef4a20486a7237a417dbc6|a25620d9bf989c9c029a7d1642999c4c265abb0bad811deb2f77b0b5b2b12e5b|5a0c1896a0d5a5ac1eb89cd24b008d2b718dd1df6fd2f75451b59ca66e49e572|101b39b1e2e9e529b3eedbdca1da71c80ff84c781f3504c05cf45774d52068de|695b772cec0aec35efa443bb2da265b84bba23fd139b3fc6fd25c2a514e0fd77|ff7f230e7df2844afef7dc49631cda03a30455f3|f640dce86563f9814a11c5452cb84eef85c58243eab37d6ccb9672a966148112|7cd4a91608030a5a404220c0beb1f307de84af26|5ee42c4eee1e6b4464bb23722f90b45303f79442df63083f05322f1785f5fdde|a5c15eb94f2878e44ffc74086b0cd2ea8db55488|0385e654db3abda17a83d81a74f463fc067da80a|05301997b2f9590f49c672cf3dfd3d3dfa7ad521|c6bc0c612605622aaef101a33a751f9de2ecc193|73b247f34ef3ae1859b8c2c34d321d34ebc5db15|4dc98e1909830e2bdc2a9cc2236e3c5d5037335b|ef79995d51245acd8a5653df7cc9116bb3cfd01b|94cb9a1c7feb608adf2b9f8fe2dbd6925ffbf90d" packaging scripts docs
```

Expected: PASS；两个生成文件都被 ignore；Telegram、FFmpeg、curl-cffi wheel/native closure 与普通发布资产的 lock SHA 都可审计。

- [ ] **Step 8: Commit**

```powershell
git add packaging/telegram-bot-api/source.lock.json packaging/telegram-bot-api/vcpkg.json packaging/telegram-bot-api/vcpkg-configuration.json packaging/telegram-bot-api/windows-system-dll-policy.json packaging/telegram-bot-api/licenses/BSL-1.0.txt packaging/telegram-bot-api/licenses/OpenSSL.txt packaging/telegram-bot-api/licenses/zlib.txt packaging/ffmpeg-macos/source.lock.json packaging/ffmpeg-macos/COPYING.LGPLv2.1 packaging/ffmpeg-macos/lame-3.100-macos.patch packaging/ffmpeg-macos/LAME-COPYING packaging/ffmpeg-windows/source.lock.json packaging/ffmpeg-windows/COPYING.LGPLv3 packaging/ffmpeg-windows/THIRD_PARTY_LICENSES.txt packaging/requirements-sidecar.txt packaging/requirements-sidecar-macos-arm64.lock.txt packaging/requirements-sidecar-windows-x64.lock.txt packaging/sidecar-sources.lock.json packaging/sidecar-install-artifacts.lock.json packaging/curl-cffi-native.lock.json packaging/sidecar-windows-runtime-policy.json packaging/cpython-windows-runtime.lock.json packaging/cpython-macos-runtime.lock.json packaging/cpython-windows-runtime-licenses packaging/curl-cffi-native-licenses packaging/sidecar-THIRD_PARTY_LICENSES.txt packaging/SOURCE-OFFER.txt.in packaging/release-binaries.lock.json THIRD_PARTY_NOTICES.md desktop/resources/telegram-bot-api/.gitkeep desktop/resources/process-host/.gitkeep desktop/resources/third-party-licenses/.gitkeep .gitignore scripts/lib/telegramPackaging.mjs scripts/tests/telegramPackaging.test.mjs scripts/generate_telegram_build_credentials.mjs scripts/generate_telegram_resource_manifest.mjs scripts/audit_telegram_secrets.ps1 scripts/install_sidecar_locked.py scripts/verify_curl_cffi_native.py scripts/verify_cpython_windows_runtime.py scripts/build_release_source_bundle.sh scripts/verify_release_source_bundle.mjs
git update-index --chmod=+x scripts/build_release_source_bundle.sh
git commit -m "build: pin telegram bot api resources"
```

---

### Task 14: 构建并验证 macOS 与 Windows 官方原生服务

**Files:**
- Modify: `src/core/url_parser.py`
- Modify: `src/sidecar/__main__.py`
- Modify: `src/sidecar/bin_paths.py`
- Modify: `src/sidecar/ytdlp_updater.py`
- Modify: `src/sidecar/diagnostics.py`
- Modify: `src/sidecar/protocol.py`
- Modify: `src/sidecar/handlers.py`
- Modify: `tests/core/test_url_parser.py`
- Create: `tests/sidecar/test_main.py`
- Modify: `tests/sidecar/test_bin_paths.py`
- Modify: `tests/sidecar/test_ytdlp_updater.py`
- Modify: `tests/sidecar/test_ytdlp_health.py`
- Modify: `tests/sidecar/test_diagnostics.py`
- Modify: `tests/sidecar/test_protocol.py`
- Modify: `tests/sidecar/test_handlers.py`
- Modify: `desktop/renderer/SettingsApp.tsx`
- Create: `desktop/renderer/SettingsApp.test.tsx`
- Modify: `native/process-host/CMakeLists.txt`
- Create: `scripts/build_telegram_bot_api_macos.sh`
- Create: `scripts/build_telegram_bot_api_windows.ps1`
- Create: `scripts/build_process_host_macos.sh`
- Create: `scripts/build_process_host_windows.ps1`
- Create: `scripts/verify_telegram_bot_api_resource.sh`
- Create: `scripts/verify_telegram_bot_api_resource.ps1`
- Modify: `scripts/install_ffmpeg.sh`
- Modify: `scripts/fetch_release_binaries.sh`
- Modify: `scripts/fetch_release_binaries.ps1`
- Modify: `scripts/tests/telegramPackaging.test.mjs`

- [ ] **Step 1: 写脚本参数与安全失败测试**

纯函数测试解析脚本命令，断言 clone 后必须 checkout source lock commit、submodule update、Release build、目标架构验证；Windows Telegram 必须 `-A x64`、pinned vcpkg、`x64-windows-static`、CMP0091 NEW 和同一个显式 `VCPKG_INSTALLED_DIR`；macOS Telegram 必须固定 arm64、`CMAKE_OSX_DEPLOYMENT_TARGET=11.0`，并把锁定 zlib 1.3.2 作为实际静态链接输入。`DownanyProcessHost` 两端从仓库同一 source 构建：Windows 配置同样必须在首次 `project()` 前启用 CMP0091 NEW 并把 Release target 固定为 `MSVC_RUNTIME_LIBRARY=MultiThreaded`，不得使用默认 `/MD` 或靠随包 CRT DLL 补救；macOS arm64 固定 deployment target 11.0。构建后必须运行 `scripts/test_process_host.py` 的真实 parent-death/grandchild/stdio smoke，并对构建产物及真实安装包内 Windows host 运行同一 PE/import verifier；资源目录只含当前平台一个 host executable与 `.gitkeep`。其余 OpenSSL/FFmpeg/LAME/lock 与安全清理要求保持不变。任何下载/构建错误必须非零退出，不能留下伪成功二进制。

- [ ] **Step 2: 确认失败**

```powershell
node --test scripts/tests/telegramPackaging.test.mjs
```

Expected: FAIL，构建与验证脚本尚不存在。

- [ ] **Step 3: 取消重复 yt-dlp executable 并修正冻结态入口**

`desktop/resources/bin` 不再 stage `yt-dlp`/`yt-dlp.exe`；`bin_paths.py` 删除 bundled yt-dlp resolver，只保留 FFmpeg 路径。无用户外置文件时 `current_version()` 与 diagnostics 直接读取 `from yt_dlp.version import __version__ as bundled_ytdlp_version`，冻结态禁止 spawn `python/python3 -m yt_dlp --version`。已有用户数据目录里的旧 external binary 不删除，但新版本不再读取或执行它。

`url_parser.build_parse_command` 在开发态仍返回 `[sys.executable,"-m","yt_dlp",...]`；`getattr(sys,"frozen",False)` 为真时固定返回 `[sys.executable,"--run-yt-dlp",...]`。`src.sidecar.__main__` 在启动 JSON Lines server 前识别唯一内部 mux `--run-yt-dlp`，调用 `yt_dlp.main(sys.argv[2:])` 并以其退出码结束；普通启动路径完全不变。测试把 `sys.frozen` 设为真并启动 fake frozen entry，断言不会递归进入 Sidecar 协议、stdout 是 yt-dlp JSON而不是 hello。

现有独立 updater 下载外部 binary 后不会替换 `DownloadManager` 实际 import 的模块，所以本任务关闭假更新：`updater.checkYtDlp` 仍返回 bundled version/latest 信息并增加 `managedByApp=true`；`updater.updateYtDlp` 不联网、不落用户文件，返回稳定 `APP_UPDATE_REQUIRED`。`SettingsApp` 删除“更新 yt-dlp”动作，显示“yt-dlp 随 Downany 更新”；测试断言页面没有独立更新按钮，旧 IPC 调用也不会写文件。`packaging/requirements-sidecar.txt`、pip report 与 `importlib.metadata.version("yt-dlp")` 使用 PyPI 规范化版本 `2026.7.4`，但 `yt_dlp.version.__version__` 的运行时原始字面量必须精确为 `2026.07.04`；health 不再次规范化，测试同时断言两者，Package smoke 在 Task 15 精确断言运行时原始值。

```powershell
pytest tests/core/test_url_parser.py tests/sidecar/test_main.py tests/sidecar/test_bin_paths.py tests/sidecar/test_ytdlp_updater.py tests/sidecar/test_ytdlp_health.py tests/sidecar/test_diagnostics.py tests/sidecar/test_protocol.py tests/sidecar/test_handlers.py -q
npm.cmd --prefix desktop test -- SettingsApp.test.tsx
```

- [ ] **Step 4: 实现 macOS 原生构建**

`build_telegram_bot_api_macos.sh` 启动即要求 `uname -m` 精确为 `arm64`，`TARGET_ARCH` 缺省或显式值都只能是 `arm64`；Intel host 和 `TARGET_ARCH=x86_64` 必须非零退出，防止产出内容与 `mac-arm64` 文件名不符。脚本先验证清理目标位于仓库 `.build/telegram-bot-api` 内，再 clone、checkout pinned commit 并执行 `git submodule sync --recursive` 与 `git submodule update --init --recursive`。工具只用 `brew install cmake gperf`；OpenSSL 输入严格从 lock 下载到随机临时文件并校验 `243a86649cf6f23eeb6a2ff2456e09e5d77dd9018a54d3d96b0c6bdd6ba6c7f1`，安全解压后执行：

```bash
export MACOSX_DEPLOYMENT_TARGET=11.0
export CC="$(xcrun --find clang)"
./Configure darwin64-arm64-cc no-shared no-tests no-module \
  --prefix="${OPENSSL_STAGE_DIR}" \
  --openssldir="${OPENSSL_STAGE_DIR}/ssl" \
  --libdir=lib \
  -arch arm64 \
  -mmacosx-version-min=11.0
make -j "$(sysctl -n hw.ncpu)"
make install_sw
```

继续前必须断言 `${OPENSSL_STAGE_DIR}/lib/libssl.a` 与 `libcrypto.a` 都存在；用 `lipo -archs` 检查两个 archive 中的全部 Mach-O object 只含 `arm64`，并拒绝 stage 内任意 `.dylib`、非 arm64 object 或指向 Homebrew 的 symlink。该检查失败时 Telegram CMake 绝不能启动。

同一脚本必须从 `source.lock.json.zlib` 下载并核对 size/SHA256 后安全解压 zlib 1.3.2；禁止使用 SDK/Homebrew 的浮动 libz。它在随机 containment 内执行：

```bash
export CC="$(xcrun --find clang)"
export CFLAGS="-O2 -arch arm64 -mmacosx-version-min=11.0"
export LDFLAGS="-arch arm64 -mmacosx-version-min=11.0"
./configure --static --prefix="${ZLIB_STAGE_DIR}"
make -j "$(sysctl -n hw.ncpu)"
make install
```

继续前必须证明 `${ZLIB_STAGE_DIR}/lib/libz.a` 与 headers 存在，archive 全部 Mach-O object 仅为 arm64、minOS 不高于 11.0；stage 中任意 `.dylib`、symlink、非 arm64 object 或 lock 外文件均失败。

然后 Telegram 执行：

```bash
export PATH="$(brew --prefix gperf)/bin:${PATH}"
TELEGRAM_LINK_MAP="${BUILD_DIR}/telegram-bot-api.link-map"
cmake -S "${SOURCE_DIR}" -B "${BUILD_DIR}" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_ARCHITECTURES="arm64" \
  -DCMAKE_OSX_DEPLOYMENT_TARGET:STRING=11.0 \
  -DOPENSSL_ROOT_DIR="${OPENSSL_STAGE_DIR}" \
  -DOPENSSL_USE_STATIC_LIBS=TRUE \
  -DZLIB_ROOT="${ZLIB_STAGE_DIR}" \
  -DZLIB_LIBRARY:FILEPATH="${ZLIB_STAGE_DIR}/lib/libz.a" \
  -DZLIB_INCLUDE_DIR:PATH="${ZLIB_STAGE_DIR}/include" \
  "-DCMAKE_PREFIX_PATH=${OPENSSL_STAGE_DIR};${ZLIB_STAGE_DIR}" \
  "-DCMAKE_EXE_LINKER_FLAGS=-Wl,-map,${TELEGRAM_LINK_MAP}" \
  -DCMAKE_INSTALL_PREFIX="${STAGE_DIR}"
cmake --build "${BUILD_DIR}" --target install --parallel
```

构建后 verifier 解析 `CMakeCache.txt`，要求实际 `ZLIB_LIBRARY/ZLIB_LIBRARY_RELEASE` realpath 唯一等于锁定 `libz.a`、include realpath 唯一等于锁定 stage；link map 必须属于最终 `telegram-bot-api` 且至少包含一个来自该绝对 `libz.a` 的 archive member。最终 `otool -L` 不得出现 `libz*.dylib`、Homebrew 或 build path。cache、map、archive SHA 或动态依赖任一不符即失败；source bundle 中 zlib 1.3.2 source/license/manifest 映射保持唯一精确。

staging 前把资源目录解析为仓库内精确绝对路径 `desktop/resources/telegram-bot-api`，先用 `test ! -L "${RESOURCE_DIR}"` 拒绝 root symlink，再用 `find "${RESOURCE_DIR}" -mindepth 1 -maxdepth 1 -type l -print -quit` 断言不存在任何直接子 symlink；只有两项都通过并验证 containment 后，才允许执行 `find "${RESOURCE_DIR}" -mindepth 1 -maxdepth 1 ! -name .gitkeep -exec rm -rf -- {} +` 清理直接子项。禁止对未解析变量、仓库根或 home 执行删除。复制 stage 中 executable，把已提交的 BSL/OpenSSL/zlib 许可证和根 `THIRD_PARTY_NOTICES.md` 复制到资源 `licenses/`，把 notice 中版本占位替换为当前 `desktop/package.json` version 后再生成 manifest；不假设 Homebrew 提供 OpenSSL/zlib 或稳定 license 路径。资源 allowlist 仅允许 `.gitkeep`、`telegram-bot-api`、`manifest.json` 与 `licenses/{BSL-1.0.txt,OpenSSL.txt,zlib.txt,THIRD_PARTY_NOTICES.md}`，发现 `.exe`、`.dll`、`.dylib`、credentials 或其他文件立即失败。

同一步把 `install_ffmpeg.sh` 从“下载 evermeet Intel 静态 zip”改成“从 pinned 官方源码构建”。保持原有第一个参数为安装目录，但 build/source/stage 只能位于仓库 `.build/ffmpeg-macos`，并用同样的 resolved containment 与 root/child symlink 拒绝规则安全清理。脚本从 `packaging/ffmpeg-macos/source.lock.json` 读取 repository/commit/version/deploymentTarget，clone 后 `git checkout --detach`，并用 `git rev-parse HEAD` 精确比对 lock。再从 lock 下载 LAME 3.100 archive，校验 `ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e`，安全解压后严格应用已提交 patch；patch 只能删除 `include/libmp3lame.sym` 中在 macOS 造成 undefined symbol 的 `lame_init_old` export，其他 hunk 或已应用/不匹配都失败。随后执行：

```bash
export CC="$(xcrun --find clang)"
export CFLAGS="-O2 -arch arm64 -mmacosx-version-min=11.0 -fno-common"
export LDFLAGS="-arch arm64 -mmacosx-version-min=11.0"
./configure \
  --prefix="${LAME_STAGE_DIR}" \
  --disable-shared \
  --enable-static \
  --disable-frontend \
  --disable-decoder \
  --disable-gtktest \
  --disable-cpml
make -j "$(sysctl -n hw.ncpu)"
make install
```

然后在 Apple Silicon host 构建 FFmpeg：

```bash
./configure \
  --prefix="${FFMPEG_STAGE_DIR}" \
  --cc="$(xcrun --find clang)" \
  --arch=arm64 \
  --target-os=darwin \
  --disable-debug \
  --disable-doc \
  --disable-ffplay \
  --disable-ffprobe \
  --disable-shared \
  --enable-static \
  --disable-gpl \
  --disable-nonfree \
  --disable-autodetect \
  --enable-securetransport \
  --enable-videotoolbox \
  --enable-audiotoolbox \
  --enable-libmp3lame \
  --extra-cflags="-arch arm64 -mmacosx-version-min=11.0 -I${LAME_STAGE_DIR}/include" \
  --extra-ldflags="-arch arm64 -mmacosx-version-min=11.0 -L${LAME_STAGE_DIR}/lib" \
  --pkg-config-flags="--static"
make -j "$(sysctl -n hw.ncpu)"
make install
```

构建环境设置 `PKG_CONFIG_PATH="${LAME_STAGE_DIR}/lib/pkgconfig"`。安装目标只复制 `${FFMPEG_STAGE_DIR}/bin/ffmpeg`，不得在 `desktop/resources/bin` 下另建或遗留 `licenses/`；脚本同时验证已提交的 `packaging/ffmpeg-macos/COPYING.LGPLv2.1` 与 `LAME-COPYING` 存在，Task 15 再把它们以精确文件名 `FFmpeg-LGPL-2.1-or-later.txt`、`LAME-LGPL-2.0-or-later.txt` stage 到统一的 `third-party-licenses`。`lipo -archs` 必须精确为 `arm64`，`otool -L` 只能引用 `/usr/lib/` 或 `/System/Library/`，arm64 slice 的 load command minimum OS 必须不高于 `11.0`。除 `ffmpeg -version` 和 1 秒视频 remux，还必须让 `ffmpeg -hide_banner -encoders` 包含 `libmp3lame`，再用 `lavfi sine` 真正编码 1 秒 MP3 并解码到 null；缺 encoder 或空/不可解码 MP3 都失败。Windows fetch 同样只把 `ffmpeg.exe` 写入 bin，许可证由 Task 15 从已提交文件统一 stage，杜绝两套路径和重复 notice。

`fetch_release_binaries.sh` 与 `.ps1` 删除 SHA 可选语义和 URL/version 环境覆盖路径，唯一输入是 `packaging/release-binaries.lock.json`。两端都不得下载/复制额外 yt-dlp executable；macOS 只调用新的 source-build `install_ffmpeg.sh`；Windows 两种入口只下载月末 LGPL FFmpeg zip，匹配 `b7c1c846dacca68ee4ebf5c390742c973b3d5d14a6d44b061f500d8e4ac74fc0` 后才原子解压/复制。下载先落到同目录随机临时名，失败时 trap/finally 清理，永不覆盖现有已验证 binary。Windows 解压后同样断言 encoder 包含 `libmp3lame` 并完成真实 1 秒 MP3 编解码 smoke；两端 fixture 分别让错误 SHA、浮动 URL/GPL/daily 资产、缺 lock 字段和半截下载失败。

- [ ] **Step 5: 实现 Windows x64 原生构建**

PowerShell 脚本校验 VS C++、CMake、Git；在 `.build/vcpkg` checkout `ea1a7396b05637a53bf23c078647ecc0edee4b80` 并 bootstrap。把唯一安装根解析为仓库内 `.build/vcpkg_installed` 并赋给 `$VcpkgInstalledDir`；显式 install 与 CMake 必须引用同一路径，禁止一处读取 `$VcpkgRoot/installed`、另一处写 manifest 默认目录。命令固定为：

```powershell
$TargetTriplet = 'x64-windows-static'
$HostTriplet = 'x64-windows'
& $Vcpkg install `
  "--x-manifest-root=$ManifestRoot" `
  "--x-install-root=$VcpkgInstalledDir" `
  "--triplet=$TargetTriplet" `
  "--host-triplet=$HostTriplet"
cmake -S $SourceDir -B $BuildDir -A x64 `
  "-DCMAKE_TOOLCHAIN_FILE:FILEPATH=$VcpkgRoot\scripts\buildsystems\vcpkg.cmake" `
  "-DVCPKG_MANIFEST_MODE=ON" `
  "-DVCPKG_MANIFEST_DIR:PATH=$ManifestRoot" `
  "-DVCPKG_INSTALLED_DIR:PATH=$VcpkgInstalledDir" `
  "-DVCPKG_TARGET_TRIPLET=$TargetTriplet" `
  "-DVCPKG_HOST_TRIPLET=$HostTriplet" `
  "-DOPENSSL_USE_STATIC_LIBS=TRUE" `
  "-DCMAKE_POLICY_DEFAULT_CMP0091=NEW" `
  "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded" `
  "-DCMAKE_INSTALL_PREFIX:PATH=$StageDir"
cmake --build $BuildDir --target install --config Release --parallel
```

`build_process_host_windows.ps1` 必须使用独立 build dir，以同样的静态 CRT 策略配置项目：

```powershell
cmake -S $ProcessHostSourceDir -B $ProcessHostBuildDir -A x64 `
  "-DCMAKE_POLICY_DEFAULT_CMP0091=NEW" `
  "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded"
cmake --build $ProcessHostBuildDir --config Release --parallel
```

`native/process-host/CMakeLists.txt` 必须在首次 `project()`/`enable_language()` 前让 CMP0091 为 NEW，并把 Release target 的 `MSVC_RUNTIME_LIBRARY` 精确设为 `MultiThreaded`。脚本增加互斥 `-VerifyExecutable <absolute-path>` 模式，构建产物与真实 NSIS 安装目录调用同一验证路径：PE machine 精确 AMD64；用 VS2022 vswhere 定位的 dumpbin 同时解析 ordinary/delay imports；delay imports精确为空；ordinary import按 ASCII lowercase basename排序去重，只允许 Windows API-set或 `%SystemRoot%\System32` 的直接 regular child，后者必须存在且 Authenticode Valid、签名组织为 Microsoft Corporation。明确拒绝 VCRUNTIME、MSVCP、CONCRT、ucrtbase、api-ms-win-crt、路径分隔符、`..`、PATH/current-directory解析及任意随包 DLL。fixture删除CMP0091或MultiThreaded、制造/MD、delay import、伪System32、第三方有效签名和错误machine都必须失败；`resources/process-host` 只能有唯一 executable。

staging 前同样解析并验证精确资源目录。先拒绝 `$ResourceDir` 自身的 `ReparsePoint`，再把 `Get-ChildItem -LiteralPath $ResourceDir -Force` 固化为 `$Children`；第一轮遍历中任何 child 的 `Attributes -band [IO.FileAttributes]::ReparsePoint` 都立即抛错，绝不对它调用 `Remove-Item -Recurse`；只有第一轮全部通过后，第二轮才对非 `.gitkeep` child 执行 `Remove-Item -LiteralPath $_.FullName -Recurse -Force`。每个删除目标都是 provider 返回且再次通过 containment 的精确绝对路径，不拼接跨 shell 路径。fixture 覆盖 root junction、child junction、child symlink、hidden child 与正常目录。通过 `${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe` 与 `-version '[17.0,18.0)' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64` 查找 VS2022，再从 `VC\Auxiliary\Build\Microsoft.VCToolsVersion.default.txt` 解析 `$DumpBin`，不假设普通 PowerShell PATH 含 dumpbin。复制 `telegram-bot-api.exe`；`$DumpBin /DEPENDENTS` 的每项必须通过 Task 13 的 System32 path/signature policy，任何 OpenSSL、zlib、MSVCP、VCRUNTIME、UCRT 或其他非 Microsoft System32 DLL 都立即失败，不做临时 DLL 猜测/收集。先确认 `$VcpkgInstalledDir/x64-windows-static/share/{openssl,zlib}/copyright` 存在作为 pinned dependency 门禁，再把仓库已提交的 BSL/OpenSSL/zlib 文件与根 `THIRD_PARTY_NOTICES.md` 复制到资源 licenses。资源 allowlist 只允许 `.gitkeep`、`telegram-bot-api.exe`、`manifest.json` 和这四份 notices；发现 macOS executable、`.dll`、`.dylib`、credentials 或其他文件立即失败。

- [ ] **Step 6: 实现二进制验证脚本**

macOS：`test -x`、`lipo -archs` 对 Telegram executable 必须精确为 arm64；`otool -L` 除 executable 自身外只允许 `/usr/lib/` 或 `/System/Library/`，拒绝 Homebrew、`.build`、`@rpath`、`@loader_path` 与 `@executable_path`；`otool -l -arch arm64` 解析 `LC_BUILD_VERSION`/`LC_VERSION_MIN_MACOSX` 并断言 minOS 不高于 `11.0`；受控启动 `--help` 成功。Windows：PE machine 必须 `8664`；`dumpbin /dependents` 每一项都通过版本化 System32 path/signature policy，因 static triplet 不允许随包第三方 DLL；受控 `--help` 返回成功。两端先运行上述平台资源 allowlist，再要求四份 notice 存在并核对 manifest SHA256 与 source lock commit；manifest 中也不得出现另一平台文件或 `app-credentials.json`。

两个 Telegram verifier 必须支持复用相同强校验来检查 staging 与真实安装包：macOS 为 `verify_telegram_bot_api_resource.sh [--resource-dir PATH] [--credentials absent|required]`，Windows 为 `verify_telegram_bot_api_resource.ps1 [-ResourceDir PATH] [-CredentialsMode Absent|Required]`。默认资源目录是工作区 staging，默认 credentials absent；`required` 只额外允许并校验 `app-credentials.json` schema，仍禁止把它收入 manifest。Windows ProcessHost 由 `build_process_host_windows.ps1 -VerifyExecutable <absolute-path>` 独立执行上一节的静态 CRT、ordinary/delay imports、PE machine与签名门禁；Task 15 对实际 NSIS 安装目录再次调用该模式，不能用 Telegram verifier或 runner自带 VC runtime掩盖缺陷。

- [ ] **Step 7: 在各自原生 runner 实际构建**

macOS：

```bash
./scripts/build_telegram_bot_api_macos.sh
./scripts/verify_telegram_bot_api_resource.sh
./scripts/build_process_host_macos.sh
python3 scripts/test_process_host.py --executable desktop/resources/process-host/DownanyProcessHost --platform darwin
```

Windows：

```powershell
.\scripts\build_telegram_bot_api_windows.ps1
.\scripts\verify_telegram_bot_api_resource.ps1
.\scripts\build_process_host_windows.ps1
python scripts/test_process_host.py --executable desktop/resources/process-host/DownanyProcessHost.exe --platform win32
.\scripts\build_process_host_windows.ps1 -VerifyExecutable (Resolve-Path 'desktop/resources/process-host/DownanyProcessHost.exe').Path
```

Expected: 两端 PASS；Telegram 与 process-host 资源目录都只有当前平台 allowlist；process host 真正收敛父崩溃后的 root+grandchild且不污染 JSONL stdout。无 source tree、另一平台二进制、DLL 或 credentials；其余 FFmpeg/MP3 条件不变。

- [ ] **Step 8: Commit**

```powershell
git add src/core/url_parser.py src/sidecar/__main__.py src/sidecar/bin_paths.py src/sidecar/ytdlp_updater.py src/sidecar/diagnostics.py src/sidecar/protocol.py src/sidecar/handlers.py tests/core/test_url_parser.py tests/sidecar/test_main.py tests/sidecar/test_bin_paths.py tests/sidecar/test_ytdlp_updater.py tests/sidecar/test_ytdlp_health.py tests/sidecar/test_diagnostics.py tests/sidecar/test_protocol.py tests/sidecar/test_handlers.py desktop/renderer/SettingsApp.tsx desktop/renderer/SettingsApp.test.tsx native/process-host/CMakeLists.txt scripts/build_telegram_bot_api_macos.sh scripts/build_telegram_bot_api_windows.ps1 scripts/build_process_host_macos.sh scripts/build_process_host_windows.ps1 scripts/verify_telegram_bot_api_resource.sh scripts/verify_telegram_bot_api_resource.ps1 scripts/install_ffmpeg.sh scripts/fetch_release_binaries.sh scripts/fetch_release_binaries.ps1 scripts/tests/telegramPackaging.test.mjs
git update-index --chmod=+x scripts/build_telegram_bot_api_macos.sh scripts/build_process_host_macos.sh scripts/verify_telegram_bot_api_resource.sh
git ls-files --stage scripts/build_telegram_bot_api_macos.sh scripts/build_process_host_macos.sh scripts/verify_telegram_bot_api_resource.sh
git commit -m "build: compile telegram bot api on macOS and Windows"
```

`git ls-files --stage` 必须显示三个新 `.sh` 为 executable mode `100755`；否则不得提交。

---

### Task 15: 装配 DMG/NSIS 并建立 release CI

**Files:**
- Modify: `packaging/sidecar.spec`
- Modify: `packaging/cpython-windows-runtime.lock.json`
- Modify: `packaging/cpython-macos-runtime.lock.json`
- Modify: `scripts/build_sidecar.sh`
- Modify: `desktop/package.json`
- Modify: `desktop/package-lock.json`
- Modify: `desktop/electron-builder.yml`
- Create: `desktop/electron/telegram/packaging.test.ts`
- Create: `desktop/electron/packageSmoke.ts`
- Create: `desktop/electron/packageSmoke.test.ts`
- Modify: `desktop/electron/main.ts`
- Modify: `scripts/build_macos_dmg.sh`
- Modify: `scripts/build_windows_nsis.ps1`
- Create: `scripts/verify_macos_package_arch.sh`
- Create: `.github/workflows/release-packages.yml`
- Modify: `scripts/tests/telegramPackaging.test.mjs`
- Create: `scripts/read_release_versions.mjs`
- Create: `scripts/run_telegram_release_acceptance.ps1`
- Create: `scripts/tests/telegramReleaseAcceptance.test.mjs`

- [ ] **Step 1: 安装直接 YAML 测试依赖并写资源布局失败测试**

执行 `npm.cmd --prefix desktop install --save-dev yaml`，提交 package 与 lockfile。`packaging.test.ts` 解析 builder/workflow，断言资源 mapping（含 process host）、arm64/minOS、平台隔离、五个 job、四份客户 artifact与两组 internal audit。每个 action 使用列出的40位 commit。release job if 必须同时含 `event=push`、tag ref和 `github.run_attempt == 1`，删任一项 fixture都失败；workflow_dispatch或rerun均 skip。job先用 authenticated paginated list 要求该tag的Release集合严格为空，任何既有draft/public Release都零mutation失败；随后只用单次`gh release create --draft --verify-tag`创建全新draft并上传四件exact set，任一response loss保留本次partial draft供runner隔离，绝不复用、清空或删除Release/asset。在创建/asset mutation前后验证由`tag/GITHUB_SHA/固定tagger`推导的完整canonical tag identity（ref object SHA、payload与direct target均一致），绝不把 Release target metadata当权威，也不公开。`GH_REPO`固定设置。

新增 `scripts/read_release_versions.mjs`，只接受`--worktree`，或`--head-and-worktree --git-executable <canonical-absolute-path>`这一组互斥模式，stdout 恰好一行 JSON、stderr 只给稳定 code、任何读取/Git/JSON错误都非零退出。`--worktree` 固定输出 `{desktop,lockTop,lockRoot,extension}`；`--head-and-worktree` 固定输出 `{head:{...},worktree:{...}}`。worktree 用 `fs.readFileSync`；HEAD只允许对runner已按Task17 toolchain复核并显式注入的绝对Git路径调用`execFileSync(gitExecutable,["show","HEAD:<exact-path>"],{shell:false,env:ownedGitEnv})`，拒绝相对路径、裸`git`、PATH解析或普通`process.env`。四个源字段只来自 desktop package、desktop lock 顶层/`packages[""]` 和 extension manifest。测试在含 `packages[""]` 的 fixture repo 中分别从 Windows PowerShell 5.1、PowerShell 7 与 bash 以钉住Node和fake绝对Git调用，证明 JSON/exit code 一致、PATH首位fake git为零调用，避免 Windows 原生参数规则破坏 inline `node -e` 引号。

新增 committed `scripts/run_telegram_release_acceptance.ps1` 作为 Task 17A/17B 的唯一正式编排入口；后文 PowerShell fence 只调用该入口，操作者不得逐段复制内部函数形成多个无共享 finally 的 shell。最终脚本导出互斥 `-Step recover|freeze|automation|secret-audit|formal-run|record-windows|record-macos|record-manual|prepare-evidence|commit-evidence|publish`，只供三个 record阶段成对使用的 `-Mode generate|ingest -AcceptanceInput <directory>`，以及只供recover使用的`-Abort formal|acceptance|publication`。

入口先完成纯内存参数解析与组合校验；未知参数、错误组合或非规范路径在任何文件、Git、GitHub、credential provider或native process调用前失败。每个通过参数校验的invocation（含recover/generate/ingest）都必须取得固定`.build/telegram-release-runner.lock`的跨进程OS独占lease。该文件固定为空的regular non-link，父目录通过`.build` containment；用`FileMode.OpenOrCreate + FileAccess.ReadWrite + FileShare.None`打开，`IOException`固定返回`TELEGRAM_RELEASE_RUNNER_BUSY`且所有其他mutation调用数为零。lock文件永久保留且绝不删除，避免旧handle关闭与新inode创建间双owner；handle不得被child继承。lease从自动recover前一直持有到最外层finally完成credential清零、native tree收敛和operation owner清理，最后才Dispose。

所有Git/GitHub/scanner/test/build/package命令都只经Task17A定义的owned-native adapter执行：静态锁定工具走`Invoke-CheckedNativeOwned`，仅平台QA generate阶段的已验证安装器/应用/卸载器走`Invoke-CheckedCandidateNativeOwned`；禁止普通`&`、`Start-Process`、裸`Process.Start`或shell拼接。recover/freeze/automation/formal-run/commit-evidence/publish永不请求真实凭据；secret-audit、三个record与prepare-evidence使用Task17A短生命周期credential lease。`telegramReleaseAcceptance.test.mjs`从Windows PowerShell 5.1与可用PS7覆盖每个step成功/throw/cancel、跨进程runner lease、真实native parent hard-kill、preflight receipt、ledger/canonical ingest、push response loss、late run、三阶段显式abort、临时index/lock、远端evidence ref、冻结Git blob与不信任真实index stat flags的clean-tree verifier，并断言环境清空、受控树归零且stdout/stderr零fixture值/路径。

workflow fixture还必须证明：去掉 default-branch SHA equality、改回 `GET /releases/tags/{tag}` 探测 draft、允许复用既有同tag draft、出现既有public/多个同tag Release后仍调用create/upload、重新引入任何Release/asset DELETE、允许 `workflow_dispatch` 进入 release、或把 extension version 与 desktop 强制相等时测试都失败；正确 fixture只要求 extension 自身是严格 semver，tag只匹配 desktop version。`gh release create`在新draft创建后任一asset upload失败或response loss时必须停止且保留partial draft，后续runner只绑定quarantine，不允许workflow重跑、清空或覆盖。

`packageSmoke.ts` 导出以下精确依赖；它直接验证 packaged Supervisor，不依赖 vault、Bot Token 或 `Controller.initialize()`：

```ts
export interface PackageSmokeOwnedTree {
  registration: "verified";
  instanceId: string;
  guardianPid: number;
  targetPid: number;
  memberPids: number[];
}

export interface PackageSmokeOwnerStates {
  sidecar: PackageSmokeOwnedTree | null;
  telegram: PackageSmokeOwnedTree | null;
}

export interface PackageSmokeDeps {
  startSidecar(): Promise<void>;
  waitForSidecarHello(timeoutMs: number): Promise<void>;
  waitForSidecarReady(timeoutMs: number): Promise<{
    startupLeaseRecoveryComplete: true;
    outputRecoveryPending: boolean;
  }>;
  getYtDlpHealth(): Promise<{ ok: boolean; version: string }>;
  supervisor: Pick<TelegramSupervisorPort, "start" | "health" | "stop" | "getState">;
  readOwnerStates(): Promise<PackageSmokeOwnerStates>;
  probeTcp(host: "127.0.0.1", port: number): Promise<boolean>;
  processExists(pid: number): Promise<boolean>;
  stopSidecar(): Promise<void>;
  exit(code: 0 | 1): void;
}

export function runPackageSmoke(deps: PackageSmokeDeps): Promise<0 | 1>;
```

`packageSmoke.test.ts` 先为 `main.ts` 的 `--downany-package-smoke` 写失败测试。该模式不创建窗口，固定执行：确认包内 process host regular/non-link 且架构正确 → 通过该 host 启动真实 Sidecar并等 hello+app.ready → health 断言 bundled yt-dlp → 从包内 credentials 构造 Supervisor并同样经 host 启动 → 断言 loopback/ready/TCP → 读取 Sidecar 与 Telegram 两份 raw v5 owner state并转换成上述 exact DTO。两项都必须非空、registration=verified、instanceId 非空且互异；每棵树 guardian/target/member PID 都为正数、升序唯一并包含 guardian+target，两棵树 PID 集合互不相交，逐个 `processExists` 都为 true后缓存完整 PID exact-set。finally 固定先 stop Supervisor再 stop Sidecar，在内部 deadline轮询到 `readOwnerStates()` 精确 `{sidecar:null,telegram:null}`、缓存 PID全部消失、TCP关闭、Supervisor state=stopped后才 exit 0。任一 owner state残留、guardian消失但target/后代尚存、共享PID、端口仍开或cleanup超时都 exit 1。全程不读 vault/Bot Token；任一步失败或内部30秒超时走同一 finally，外层60秒。

- [ ] **Step 2: 确认失败**

```powershell
npm.cmd --prefix desktop test -- packaging.test.ts
node --test scripts/tests/telegramPackaging.test.mjs
```

Expected: FAIL，打包配置尚未装配 Telegram 资源。

- [ ] **Step 3: 修改 electron-builder 资源布局**

在现有根级 `extraResources` list 末尾追加以下三项，不能创建第二个 `extraResources` key：

```yaml
- from: resources/telegram-bot-api
  to: telegram-bot-api
  filter:
    - "**/*"
    - "!**/.gitkeep"
- from: resources/process-host
  to: process-host
  filter:
    - "**/*"
    - "!**/.gitkeep"
- from: resources/third-party-licenses
  to: third-party-licenses
  filter:
    - "**/*"
    - "!**/.gitkeep"
```

在现有根级 `mac` mapping 内追加，不能创建第二个 `mac` key：

```yaml
minimumSystemVersion: "11.0"
binaries:
  - Contents/Resources/telegram-bot-api/telegram-bot-api
  - Contents/Resources/process-host/DownanyProcessHost
```

同时把 macOS `artifactName` 固定为 `Downany-${version}-mac-arm64.${ext}`，并把 `desktop/package.json` 的 `dist:mac` 固定为 `electron-builder --mac --arm64 --config electron-builder.yml`；本计划的官方 macOS release runner与 Telegram/Sidecar/Electron/FFmpeg 产物均为 arm64，不用含糊的 `-mac` 文件名伪装 universal。保留当前 `identity: null` 和 NSIS x64，不伪称已签名。Windows static 构建禁止在 Telegram 资源目录携带第三方 DLL；包内 System32 policy 与 Task 14 完全一致。

- [ ] **Step 4: 修改本地打包编排**

两个脚本增加 `BUILD_TELEGRAM_BOT_API` 与 `BUILD_PROCESS_HOST`，默认都为 `1`。release 构建必须使用锁定 Python 3.11.9，并调用 Task 13 的 `install_sidecar_locked.py`；Windows 由 runtime lock 下载官方 installer到随机 containment。macOS release 由 runtime lock 下载 action artifact 到随机 download/toolcache staging、核对 size/SHA 后，在一次性 hosted VM 的显式 opt-in 下运行其全局 framework 安装脚本；随后只能从 lock 的 `interpreterPath` 创建临时 release venv，并验证 realpath/global framework/runtime report，不能断言解释器位于临时 staging。非 hosted 本地路径只接受显式提供且全量验证通过的 interpreter，二者都禁止直接用未验证的 ambient runner Python。顺序固定为：按 lock 构建/获取 FFmpeg → 安装精确 wheel并生成 `sidecar-install-report-<platform>.json` → build Sidecar → 两端验证 curl-cffi closure → macOS 用 runtime lock 生成 `desktop/release/audit/sidecar-native-report-macos-arm64.json`，Windows 用 runtime lock 生成 `desktop/release/audit/sidecar-native-report-windows-x64.json` → 验证 bundled yt-dlp `2026.07.04` → 调用当前平台 `build_process_host_*` 并运行 `test_process_host.py` → build/verify Telegram service → stage平台精确许可证/source offer → Electron package → 对挂载 DMG/安装 NSIS 后的包内 Sidecar分别用 `--expected-report` 逐字段复核 → 再验证 process host、Telegram资源、credentials 与平台隔离 → 清理临时 credential/Python。四份规范化报告固定为两个 install report与两个 native report，均按原子 rename写到 `desktop/release/audit/`，禁止绝对路径、runner、用户名与时间戳。即使 installer、native verifier、builder或包内断言失败也执行临时清理；macOS hosted VM 的全局 framework 由 runner 销毁回收，不运行危险的递归删除。`BUILD_TELEGRAM_BOT_API=0` 或 `BUILD_PROCESS_HOST=0` 只允许当前平台对应资源已通过全部 verifier时继续；process host 必须是 regular non-link、macOS 精确 arm64/minOS≤11、Windows PE AMD64，且其 sourceDisposition 固定为 `project_source`，不伪装成第三方组件。

Task 13 先提交 component/source/license closure；完成最终 `sidecar.spec` 后，第一次 lock 维护只能对明确 bare onedir 运行以下精确命令：

```powershell
$WinEmit = Join-Path ([IO.Path]::GetTempPath()) 'downany-cpython-windows-members.json'
python scripts/verify_cpython_windows_runtime.py `
  --onedir desktop/resources/sidecar/DownanySidecar `
  --lock packaging/cpython-windows-runtime.lock.json `
  --curl-lock packaging/curl-cffi-native.lock.json `
  --policy packaging/sidecar-windows-runtime-policy.json `
  --emit-member-paths $WinEmit
```

```bash
MAC_EMIT="$(mktemp "${TMPDIR:-/tmp}/downany-cpython-macos-members.XXXXXX.json")"
./scripts/verify_macos_package_arch.sh \
  --sidecar-dir desktop/resources/sidecar/DownanySidecar \
  --arch arm64 \
  --max-min-os 11.0 \
  --runtime-lock packaging/cpython-macos-runtime.lock.json \
  --curl-lock packaging/curl-cffi-native.lock.json \
  --emit-runtime-lock-members "$MAC_EMIT"
```

Windows 输出完整排序 `{path,componentIds,sourceDisposition,imports}`；macOS 输出 `{path,componentIds,sourceDisposition,rpaths,imports}`，每个 import保留 `kind`。emit 与 normal report/expected-report/validate-report 互斥；只扫描给定 regular non-link bare onedir，只原子写输出 JSON，不改 lock。传入 runtime lock 仅提供 immutable metadata/component/source mapping，emit 时忽略旧 expected members。人工逐项核对后用 `apply_patch` 写 lock并删除 temp，再以普通模式证明 exact equality。`CI=true`/release build硬拒绝 emit。

`third-party-licenses` 的平台 allowlist 与来源固定。两端把 `packaging/sidecar-THIRD_PARTY_LICENSES.txt → Sidecar-THIRD-PARTY-LICENSES.txt`，并从 `packaging/SOURCE-OFFER.txt.in` 生成 `SOURCE-OFFER.txt`；macOS 只再把 `packaging/ffmpeg-macos/COPYING.LGPLv2.1 → FFmpeg-LGPL-2.1-or-later.txt`、`LAME-COPYING → LAME-LGPL-2.0-or-later.txt`；Windows 只再把 `packaging/ffmpeg-windows/COPYING.LGPLv3 → FFmpeg-LGPL-3.0-or-later.txt`、`THIRD_PARTY_LICENSES.txt → FFmpeg-BtbN-THIRD-PARTY-LICENSES.txt`。任何另一平台 notice、额外 executable、credential、旧版本 source offer 或未登记文件都失败。安装包内 `SOURCE-OFFER.txt` 的 version 必须等于 `desktop/package.json` 和 tag。

`build_macos_dmg.sh` 必须在任何下载/构建前断言 `uname -m = arm64`，拒绝其他 `TARGET_ARCH`，并最终执行显式 `--arm64`。`verify_macos_package_arch.sh APP_PATH arm64 11.0 --runtime-lock ... --report ...` 用 NUL 分隔枚举 `.app` 全部 Mach-O，要求 arm64/minOS `<=11.0`，并按 Task 13 对 Sidecar 子树产出全成员/import/source报告；至少明确枚举 Electron main/helpers、Sidecar、FFmpeg和 Telegram，且包内无独立 yt-dlp。构建脚本对 unpacked app 生成一次报告，挂载 DMG 后用 `--expected-report` 再枚举比较。fixture 覆盖漏 arm64、minOS 12、无 load command、空格路径、额外/缺失 member、import 漂移、未映射 source与意外 yt-dlp executable。

- [ ] **Step 5: 创建 release workflow**

新建文件内容必须完整落为以下可执行 workflow，不把 permissions、artifact 汇总或 release 上传留给实现者补写：

```yaml
name: Release packages

on:
  workflow_dispatch:
  push:
    tags:
      - "v*"

permissions:
  contents: read

concurrency:
  group: release-packages-${{ github.ref }}
  cancel-in-progress: false

jobs:
  extension:
    runs-on: ubuntu-24.04
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
        with:
          node-version: "20"
      - name: Test extension and verify release versions
        shell: bash
        run: |
          node browser-extension/shared.test.js
          node browser-extension/sniff-core.test.js
          DESKTOP_VERSION="$(node -p "require('./desktop/package.json').version")"
          EXTENSION_VERSION="$(node -p "require('./browser-extension/manifest.json').version")"
          [[ "${EXTENSION_VERSION}" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || {
            echo "extension manifest version must be strict semver" >&2
            exit 1
          }
          if [[ "${GITHUB_REF}" == refs/tags/v* ]]; then
            test "${GITHUB_REF_NAME#v}" = "${DESKTOP_VERSION}" || {
              echo "tag version does not match desktop/package.json" >&2
              exit 1
            }
          fi
      - name: Build extension zip
        shell: bash
        run: |
          EXTENSION_VERSION="$(node -p "require('./browser-extension/manifest.json').version")"
          EXTENSION_ZIP="Downany-chrome-extension-${EXTENSION_VERSION}.zip"
          rm -f Downany-chrome-extension-*.zip
          (
            cd browser-extension
            zip -r "../${EXTENSION_ZIP}" . \
              -x "*.test.js" "*.test.mjs" ".*" "*/.*" "__MACOSX*" "*/__MACOSX*" "*.DS_Store" "*/.DS_Store" "node_modules/*" "*/node_modules/*"
          )
          unzip -t "${EXTENSION_ZIP}"
          if unzip -Z1 "${EXTENSION_ZIP}" | grep -E '(^|/)\.[^/]+|(^|/)__MACOSX(/|$)|\.DS_Store$|\.test\.(js|mjs)$|(^|/)node_modules/'; then
            echo "extension zip contains excluded files" >&2
            exit 1
          fi
      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02
        with:
          name: Downany-extension
          path: Downany-chrome-extension-*.zip
          if-no-files-found: error
          retention-days: 7

  macos:
    runs-on: macos-15
    timeout-minutes: 180
    env:
      DOWNANY_ALLOW_PINNED_GLOBAL_CPYTHON_INSTALL: "1"
      DOWNANY_RELEASE_RUNNER_ENVIRONMENT: ${{ runner.environment }}
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
        with:
          node-version: "20"
          cache: npm
          cache-dependency-path: desktop/package-lock.json
      - uses: actions/setup-python@a26af69be951a213d495a4c3e4e4022e16d87065
        with:
          python-version: "3.11.9"
          architecture: arm64
      - name: Run full regression and packaging contracts
        shell: bash
        run: |
          python -m pip install --upgrade pip
          python -m pip install -r requirements-dev.txt
          pytest tests/core tests/data tests/sidecar tests/cli -q
          npm ci --prefix desktop
          npm --prefix desktop test
          npm --prefix desktop run build
          node --test scripts/tests/telegramPackaging.test.mjs
          npm --prefix desktop test -- packaging.test.ts
      - name: Build DMG
        shell: bash
        env:
          TARGET_ARCH: arm64
          DOWNANY_TELEGRAM_API_ID: ${{ secrets.DOWNANY_TELEGRAM_API_ID }}
          DOWNANY_TELEGRAM_API_HASH: ${{ secrets.DOWNANY_TELEGRAM_API_HASH }}
        run: |
          [[ "${DOWNANY_TELEGRAM_API_ID}" =~ ^[1-9][0-9]*$ ]] || { echo "invalid DOWNANY_TELEGRAM_API_ID" >&2; exit 1; }
          [[ "${DOWNANY_TELEGRAM_API_HASH}" =~ ^[0-9A-Fa-f]{32}$ ]] || { echo "invalid DOWNANY_TELEGRAM_API_HASH" >&2; exit 1; }
          ./scripts/build_macos_dmg.sh
      - name: Verify packaged macOS resources and smoke
        timeout-minutes: 3
        shell: bash
        env:
          DOWNANY_TELEGRAM_API_ID: ${{ secrets.DOWNANY_TELEGRAM_API_ID }}
          DOWNANY_TELEGRAM_API_HASH: ${{ secrets.DOWNANY_TELEGRAM_API_HASH }}
        run: |
          set -euo pipefail
          test "$(find desktop/release -maxdepth 1 -type f -name '*.dmg' | wc -l | tr -d ' ')" = "1"
          DMG_PATH="$(find desktop/release -maxdepth 1 -type f -name '*.dmg' -print -quit)"
          case "$(basename "${DMG_PATH}")" in
            Downany-*-mac-arm64.dmg) ;;
            *) echo "unexpected DMG name: ${DMG_PATH}" >&2; exit 1 ;;
          esac
          MOUNT_DIR="$(mktemp -d)"
          APP_PATH=''
          APP_PID=''
          MOUNTED=0
          child_pids() {
            [[ -n "${APP_PATH}" ]] || return 0
            pgrep -f -- "${APP_PATH}/Contents/Resources/(sidecar|telegram-bot-api|process-host)/" || true
          }
          cleanup_package_smoke() {
            local rc=$?
            local cleanup_failed=0
            local pids=''
            trap - EXIT INT TERM
            set +e
            if [[ -n "${APP_PID}" ]] && kill -0 "${APP_PID}" 2>/dev/null; then
              kill -TERM "${APP_PID}" 2>/dev/null
              sleep 2
              kill -0 "${APP_PID}" 2>/dev/null && kill -KILL "${APP_PID}" 2>/dev/null
              wait "${APP_PID}" 2>/dev/null
            fi
            pids="$(child_pids)"
            if [[ -n "${pids}" ]]; then
              [[ ${rc} -ne 0 ]] || cleanup_failed=1
              while IFS= read -r pid; do [[ -z "${pid}" ]] || kill -TERM "${pid}" 2>/dev/null; done <<<"${pids}"
              for _ in 1 2 3 4 5; do
                [[ -z "$(child_pids)" ]] && break
                sleep 1
              done
              pids="$(child_pids)"
              while IFS= read -r pid; do [[ -z "${pid}" ]] || kill -KILL "${pid}" 2>/dev/null; done <<<"${pids}"
              for _ in 1 2 3 4 5; do
                [[ -z "$(child_pids)" ]] && break
                sleep 1
              done
            fi
            [[ -z "$(child_pids)" ]] || cleanup_failed=1
            if ((MOUNTED)); then
              hdiutil detach "${MOUNT_DIR}" -force >/dev/null 2>&1 || cleanup_failed=1
            fi
            [[ ! -d "${MOUNT_DIR}" ]] || rmdir "${MOUNT_DIR}" >/dev/null 2>&1 || cleanup_failed=1
            ((rc != 0 || cleanup_failed == 0)) || rc=1
            exit "${rc}"
          }
          trap cleanup_package_smoke EXIT
          trap 'exit 130' INT TERM
          hdiutil attach "${DMG_PATH}" -nobrowse -readonly -mountpoint "${MOUNT_DIR}"
          MOUNTED=1
          APP_PATH="${MOUNT_DIR}/Downany.app"
          test -d "${APP_PATH}"
          RESOURCE_DIR="${APP_PATH}/Contents/Resources/telegram-bot-api"
          ./scripts/verify_telegram_bot_api_resource.sh --resource-dir "${RESOURCE_DIR}" --credentials required
          DMG_SHA="$(shasum -a 256 "${DMG_PATH}" | awk '{print tolower($1)}')"
          PACKAGE_SCAN_JSON="$(
            pwsh -NoProfile -NonInteractive \
              -File scripts/audit_telegram_secrets.ps1 \
              -PackageArtifact "${DMG_PATH}" \
              -PackageRoot "${MOUNT_DIR}" \
              -PackagePlatform macos-arm64
          )"
          jq -e --arg sha "${DMG_SHA}" '
            (keys == ["artifactSha256","credentialFileCount","entryCount","mode","platform","policy","regularFileCount","result","schemaVersion","treeBytesScanned","treeManifestSha256"]) and
            .schemaVersion == 1 and .mode == "package_tree" and
            .platform == "macos-arm64" and .policy == "telegram-app-credentials-v1" and
            .artifactSha256 == $sha and .credentialFileCount == 1 and
            .entryCount >= .regularFileCount and .regularFileCount >= 1 and
            .treeBytesScanned > 0 and .result == "passed" and
            (.treeManifestSha256 | test("^[0-9a-f]{64}$"))
          ' <<<"${PACKAGE_SCAN_JSON}" >/dev/null
          LICENSE_DIR="${APP_PATH}/Contents/Resources/third-party-licenses"
          test "$(find "${LICENSE_DIR}" -maxdepth 1 -type f | wc -l | tr -d ' ')" = "4"
          test -f "${LICENSE_DIR}/Sidecar-THIRD-PARTY-LICENSES.txt"
          test -f "${LICENSE_DIR}/SOURCE-OFFER.txt"
          test -f "${LICENSE_DIR}/FFmpeg-LGPL-2.1-or-later.txt"
          test -f "${LICENSE_DIR}/LAME-LGPL-2.0-or-later.txt"
          grep -F "/v$(node -p "require('./desktop/package.json').version")/Downany-third-party-sources-" "${LICENSE_DIR}/SOURCE-OFFER.txt"
          ./scripts/verify_macos_package_arch.sh \
            "${APP_PATH}" arm64 11.0 \
            --runtime-lock packaging/cpython-macos-runtime.lock.json \
            --expected-report desktop/release/audit/sidecar-native-report-macos-arm64.json
          test "$(plutil -extract LSMinimumSystemVersion raw "${APP_PATH}/Contents/Info.plist")" = "11.0"
          test ! -e desktop/resources/telegram-bot-api/app-credentials.json
          SMOKE_DATA="${RUNNER_TEMP}/downany-package-smoke"
          mkdir -p "${SMOKE_DATA}"
          DOWNANY_DATA_DIR="${SMOKE_DATA}" "${APP_PATH}/Contents/MacOS/Downany" --downany-package-smoke &
          APP_PID=$!
          DEADLINE=$((SECONDS + 60))
          while kill -0 "${APP_PID}" 2>/dev/null; do
            ((SECONDS < DEADLINE)) || { echo 'package smoke timed out' >&2; exit 124; }
            sleep 1
          done
          set +e
          wait "${APP_PID}"
          SMOKE_RC=$?
          set -e
          APP_PID=''
          ((SMOKE_RC == 0)) || { echo "package smoke failed: ${SMOKE_RC}" >&2; exit 1; }
          [[ -z "$(child_pids)" ]] || { echo 'package smoke left a child process' >&2; exit 1; }
          test ! -e "${SMOKE_DATA}/telegram/owner-state.json"
          test ! -e "${SMOKE_DATA}/telegram/sidecar-owner-state.json"
      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02
        with:
          name: downany-macos-sidecar-audit
          path: |
            desktop/release/audit/sidecar-install-report-macos-arm64.json
            desktop/release/audit/sidecar-native-report-macos-arm64.json
          if-no-files-found: error
          retention-days: 7
      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02
        with:
          name: Downany-macos
          path: desktop/release/Downany-*-mac-arm64.dmg
          if-no-files-found: error
          retention-days: 7

  windows:
    runs-on: windows-2022
    timeout-minutes: 180
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
        with:
          node-version: "20"
          cache: npm
          cache-dependency-path: desktop/package-lock.json
      - uses: actions/setup-python@a26af69be951a213d495a4c3e4e4022e16d87065
        with:
          python-version: "3.11.9"
      - name: Run full regression and packaging contracts
        shell: pwsh
        run: |
          python -m pip install --upgrade pip
          if ($LASTEXITCODE -ne 0) { throw 'pip upgrade failed' }
          python -m pip install -r requirements-dev.txt
          if ($LASTEXITCODE -ne 0) { throw 'dependency installation failed' }
          pytest tests/core tests/data tests/sidecar tests/cli -q
          if ($LASTEXITCODE -ne 0) { throw 'pytest failed' }
          npm.cmd ci --prefix desktop
          if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
          npm.cmd --prefix desktop test
          if ($LASTEXITCODE -ne 0) { throw 'desktop tests failed' }
          npm.cmd --prefix desktop run build
          if ($LASTEXITCODE -ne 0) { throw 'desktop build failed' }
          node --test scripts/tests/telegramPackaging.test.mjs
          if ($LASTEXITCODE -ne 0) { throw 'packaging tests failed' }
          npm.cmd --prefix desktop test -- packaging.test.ts
          if ($LASTEXITCODE -ne 0) { throw 'packaging contract test failed' }
      - name: Build NSIS
        shell: pwsh
        env:
          DOWNANY_TELEGRAM_API_ID: ${{ secrets.DOWNANY_TELEGRAM_API_ID }}
          DOWNANY_TELEGRAM_API_HASH: ${{ secrets.DOWNANY_TELEGRAM_API_HASH }}
        run: |
          if ($env:DOWNANY_TELEGRAM_API_ID -notmatch '^[1-9][0-9]*$') { throw 'invalid DOWNANY_TELEGRAM_API_ID' }
          if ($env:DOWNANY_TELEGRAM_API_HASH -notmatch '^[0-9A-Fa-f]{32}$') { throw 'invalid DOWNANY_TELEGRAM_API_HASH' }
          .\scripts\build_windows_nsis.ps1
      - name: Verify packaged Windows resources and smoke
        timeout-minutes: 3
        shell: pwsh
        env:
          DOWNANY_TELEGRAM_API_ID: ${{ secrets.DOWNANY_TELEGRAM_API_ID }}
          DOWNANY_TELEGRAM_API_HASH: ${{ secrets.DOWNANY_TELEGRAM_API_HASH }}
        run: |
          $Installers = @(Get-ChildItem -LiteralPath 'desktop\release' -File -Filter 'Downany-*-win-x64.exe')
          if ($Installers.Count -ne 1) { throw "expected exactly one NSIS installer, got $($Installers.Count)" }
          $InstallDir = Join-Path $env:RUNNER_TEMP ("Downany 安装 验证 " + [guid]::NewGuid().ToString('N'))
          if ($InstallDir -notmatch ' ' -or -not ($InstallDir.ToCharArray() | Where-Object { [int]$_ -gt 127 })) {
            throw 'NSIS smoke install path must contain both an ASCII space and a non-ASCII code point'
          }
          $SmokeData = Join-Path $env:RUNNER_TEMP ("DownanySmokeData-" + [guid]::NewGuid().ToString('N'))
          New-Item -ItemType Directory -Force -Path $SmokeData | Out-Null
          $Process = $null
          $CleanupErrors = [System.Collections.Generic.List[string]]::new()
          try {
            $Install = Start-Process -FilePath $Installers[0].FullName -ArgumentList @('/S', "/D=$InstallDir") -PassThru -Wait -WindowStyle Hidden
            if ($Install.ExitCode -ne 0) { throw "silent install failed: $($Install.ExitCode)" }
            $SidecarDir = Join-Path $InstallDir 'resources\sidecar\DownanySidecar'
            python scripts/verify_cpython_windows_runtime.py `
              --onedir $SidecarDir `
              --lock packaging/cpython-windows-runtime.lock.json `
              --curl-lock packaging/curl-cffi-native.lock.json `
              --policy packaging/sidecar-windows-runtime-policy.json `
              --expected-report desktop/release/audit/sidecar-native-report-windows-x64.json
            if ($LASTEXITCODE -ne 0) { throw 'installed Sidecar native report mismatch' }
            .\scripts\build_process_host_windows.ps1 `
              -VerifyExecutable (Join-Path $InstallDir 'resources\process-host\DownanyProcessHost.exe')
            if ($LASTEXITCODE -ne 0) { throw 'installed ProcessHost verification failed' }
            $ResourceDir = Join-Path $InstallDir 'resources\telegram-bot-api'
            .\scripts\verify_telegram_bot_api_resource.ps1 -ResourceDir $ResourceDir -CredentialsMode Required
            $SecretAuditScript = (Resolve-Path -LiteralPath 'scripts\audit_telegram_secrets.ps1').Path
            $PackageScanJson = & $SecretAuditScript `
              -PackageArtifact $Installers[0].FullName `
              -PackageRoot $InstallDir `
              -PackagePlatform windows-x64
            if ($LASTEXITCODE -ne 0) { throw 'installed package secret audit failed' }
            $PackageScan = $PackageScanJson | ConvertFrom-Json
            $ExpectedReceiptFields = @('artifactSha256','credentialFileCount','entryCount','mode','platform','policy','regularFileCount','result','schemaVersion','treeBytesScanned','treeManifestSha256')
            $ActualReceiptFields = @($PackageScan.PSObject.Properties.Name | Sort-Object)
            if (($ActualReceiptFields -join "`n") -cne (($ExpectedReceiptFields | Sort-Object) -join "`n")) { throw 'installed package secret audit receipt fields mismatch' }
            $InstallerSha = (Get-FileHash -LiteralPath $Installers[0].FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            if (
              $PackageScan.schemaVersion -ne 1 -or $PackageScan.mode -cne 'package_tree' -or
              $PackageScan.platform -cne 'windows-x64' -or $PackageScan.policy -cne 'telegram-app-credentials-v1' -or
              $PackageScan.artifactSha256 -cne $InstallerSha -or $PackageScan.credentialFileCount -ne 1 -or
              $PackageScan.entryCount -lt $PackageScan.regularFileCount -or $PackageScan.regularFileCount -lt 1 -or
              $PackageScan.treeBytesScanned -le 0 -or $PackageScan.result -cne 'passed' -or
              $PackageScan.treeManifestSha256 -notmatch '^[0-9a-f]{64}$'
            ) { throw 'installed package secret audit receipt mismatch' }
            $LicenseDir = Join-Path $InstallDir 'resources\third-party-licenses'
            $Licenses = @(Get-ChildItem -LiteralPath $LicenseDir -File)
            if ($Licenses.Count -ne 4) { throw "third-party license count mismatch: $($Licenses.Count)" }
            foreach ($Name in @('Sidecar-THIRD-PARTY-LICENSES.txt','SOURCE-OFFER.txt','FFmpeg-LGPL-3.0-or-later.txt','FFmpeg-BtbN-THIRD-PARTY-LICENSES.txt')) {
              if (-not (Test-Path -LiteralPath (Join-Path $LicenseDir $Name))) { throw "missing license: $Name" }
            }
            if (Test-Path -LiteralPath 'desktop\resources\telegram-bot-api\app-credentials.json') { throw 'workspace credentials were not cleaned' }
            $App = Join-Path $InstallDir 'Downany.exe'
            $env:DOWNANY_DATA_DIR = $SmokeData
            $Process = Start-Process -FilePath $App -ArgumentList '--downany-package-smoke' -PassThru -WindowStyle Hidden
            if (-not $Process.WaitForExit(60000)) {
              throw 'package smoke timed out'
            }
            if ($Process.ExitCode -ne 0) { throw "package smoke failed: $($Process.ExitCode)" }
            foreach ($StateName in @('owner-state.json','sidecar-owner-state.json')) {
              $StatePath = Join-Path $SmokeData "telegram\$StateName"
              if (Test-Path -LiteralPath $StatePath) {
                throw "package smoke left owner state: $StateName"
              }
            }
            $Leaked = @(Get-CimInstance Win32_Process | Where-Object {
              ($_.Name -eq 'telegram-bot-api.exe' -or $_.Name -eq 'DownanySidecar.exe' -or $_.Name -eq 'DownanyProcessHost.exe') -and
              $_.ExecutablePath -and
              $_.ExecutablePath.StartsWith($InstallDir, [System.StringComparison]::OrdinalIgnoreCase)
            })
            if ($Leaked.Count -ne 0) { throw "package smoke left child processes: $($Leaked.ProcessId -join ',')" }
          }
          finally {
            if ($Process -and -not $Process.HasExited) {
              Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
              $null = $Process.WaitForExit(5000)
            }
            $Children = @(Get-CimInstance Win32_Process | Where-Object {
              ($_.Name -eq 'telegram-bot-api.exe' -or $_.Name -eq 'DownanySidecar.exe' -or $_.Name -eq 'DownanyProcessHost.exe') -and
              $_.ExecutablePath -and
              $_.ExecutablePath.StartsWith($InstallDir, [System.StringComparison]::OrdinalIgnoreCase)
            })
            foreach ($Child in $Children) {
              Stop-Process -Id $Child.ProcessId -Force -ErrorAction SilentlyContinue
            }
            $Uninstaller = Join-Path $InstallDir 'Uninstall Downany.exe'
            if (Test-Path -LiteralPath $Uninstaller) {
              $Uninstall = Start-Process -FilePath $Uninstaller -ArgumentList '/S' -PassThru -Wait -WindowStyle Hidden
              if ($Uninstall.ExitCode -ne 0) { $CleanupErrors.Add("silent uninstall failed: $($Uninstall.ExitCode)") }
            }
            for ($Attempt = 0; $Attempt -lt 20 -and (Test-Path -LiteralPath $InstallDir); $Attempt++) {
              Start-Sleep -Seconds 1
            }
            if (Test-Path -LiteralPath $InstallDir) {
              $CleanupErrors.Add("install directory remains after uninstall: $InstallDir")
            }
            $RemainingChildren = @(Get-CimInstance Win32_Process | Where-Object {
              ($_.Name -eq 'telegram-bot-api.exe' -or $_.Name -eq 'DownanySidecar.exe' -or $_.Name -eq 'DownanyProcessHost.exe') -and
              $_.ExecutablePath -and
              $_.ExecutablePath.StartsWith($InstallDir, [System.StringComparison]::OrdinalIgnoreCase)
            })
            if ($RemainingChildren.Count -ne 0) {
              $CleanupErrors.Add("child processes remain after cleanup: $($RemainingChildren.ProcessId -join ',')")
            }
            if ($CleanupErrors.Count -ne 0) {
              throw ($CleanupErrors -join '; ')
            }
          }
      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02
        with:
          name: downany-windows-sidecar-audit
          path: |
            desktop/release/audit/sidecar-install-report-windows-x64.json
            desktop/release/audit/sidecar-native-report-windows-x64.json
          if-no-files-found: error
          retention-days: 7
      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02
        with:
          name: Downany-windows
          path: desktop/release/Downany-*-win-x64.exe
          if-no-files-found: error
          retention-days: 7

  sources:
    needs: [macos, windows]
    runs-on: ubuntu-24.04
    timeout-minutes: 180
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
        with:
          node-version: "20"
      - uses: actions/setup-python@a26af69be951a213d495a4c3e4e4022e16d87065
        with:
          python-version: "3.11.9"
      - uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093
        with:
          name: downany-macos-sidecar-audit
          path: ${{ runner.temp }}/sidecar-audit-macos
      - uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093
        with:
          name: downany-windows-sidecar-audit
          path: ${{ runner.temp }}/sidecar-audit-windows
      - name: Build and verify matching source bundle
        shell: bash
        run: |
          set -euo pipefail
          VERSION="$(node -p "require('./desktop/package.json').version")"
          MAC_NATIVE_REPORT="${RUNNER_TEMP}/sidecar-audit-macos/sidecar-native-report-macos-arm64.json"
          WIN_NATIVE_REPORT="${RUNNER_TEMP}/sidecar-audit-windows/sidecar-native-report-windows-x64.json"
          ./scripts/verify_macos_package_arch.sh \
            --validate-report "${MAC_NATIVE_REPORT}" \
            --runtime-lock packaging/cpython-macos-runtime.lock.json \
            --curl-lock packaging/curl-cffi-native.lock.json
          python scripts/verify_cpython_windows_runtime.py \
            --lock packaging/cpython-windows-runtime.lock.json \
            --curl-lock packaging/curl-cffi-native.lock.json \
            --policy packaging/sidecar-windows-runtime-policy.json \
            --validate-report "${WIN_NATIVE_REPORT}"
          mkdir -p "${RUNNER_TEMP}/release-source"
          ./scripts/build_release_source_bundle.sh \
            "${VERSION}" \
            "${RUNNER_TEMP}/release-source" \
            --macos-native-report "${MAC_NATIVE_REPORT}" \
            --windows-native-report "${WIN_NATIVE_REPORT}"
          node scripts/verify_release_source_bundle.mjs \
            "${RUNNER_TEMP}/release-source/Downany-third-party-sources-${VERSION}.tar.zst"
      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02
        with:
          name: Downany-sources
          path: ${{ runner.temp }}/release-source/Downany-third-party-sources-*.tar.zst
          if-no-files-found: error
          retention-days: 7

  release:
    if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v') && github.run_attempt == 1
    needs: [extension, macos, windows, sources]
    runs-on: ubuntu-24.04
    permissions:
      contents: write
    steps:
      - uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093
        with:
          pattern: Downany-*
          path: release-input
          merge-multiple: true
      - name: Verify release set
        shell: bash
        run: |
          test "$(find release-input -maxdepth 1 -type f -name 'Downany-*-mac-arm64.dmg' | wc -l | tr -d ' ')" = "1"
          test "$(find release-input -maxdepth 1 -type f -name 'Downany-*-win-x64.exe' | wc -l | tr -d ' ')" = "1"
          test "$(find release-input -maxdepth 1 -type f -name 'Downany-chrome-extension-*.zip' | wc -l | tr -d ' ')" = "1"
          test "$(find release-input -maxdepth 1 -type f -name 'Downany-third-party-sources-*.tar.zst' | wc -l | tr -d ' ')" = "1"
          test "$(find release-input -maxdepth 1 -type f | wc -l | tr -d ' ')" = "4"
      - name: Stage exact draft release set for acceptance
        shell: bash
        env:
          GH_TOKEN: ${{ github.token }}
          GH_REPO: ${{ github.repository }}
        run: |
          set -euo pipefail
          TAG="${GITHUB_REF_NAME}"
          verify_remote_tag_identity() {
            local tag="$1" expected_commit="$2" encoded ref_json ref_type ref_sha tag_json commit_date tagger_seconds expected_date expected_message expected_sha
            encoded="$(jq -rn --arg value "${tag}" '$value|@uri')"
            ref_json="$(gh api "repos/${GITHUB_REPOSITORY}/git/ref/tags/${encoded}")"
            ref_type="$(jq -er '.object.type' <<<"${ref_json}")"
            ref_sha="$(jq -er '.object.sha' <<<"${ref_json}")"
            [[ "${ref_type}" == tag && "${ref_sha}" =~ ^[0-9a-f]{40}$ ]] || return 1
            tag_json="$(gh api "repos/${GITHUB_REPOSITORY}/git/tags/${ref_sha}")"
            commit_date="$(gh api "repos/${GITHUB_REPOSITORY}/git/commits/${expected_commit}" --jq '.committer.date')"
            tagger_seconds="$(date -u -d "${commit_date}" +%s)"
            [[ "${tagger_seconds}" =~ ^[0-9]+$ ]] || return 1
            expected_date="$(date -u -d "@${tagger_seconds}" '+%Y-%m-%dT%H:%M:%SZ')"
            expected_message="Downany release ${tag}"
            jq -e --arg tag "${tag}" --arg commit "${expected_commit}" --arg date "${expected_date}" --arg message "${expected_message}" '
              .tag == $tag and .object.type == "commit" and .object.sha == $commit and
              .tagger.name == "Downany Release Automation" and
              .tagger.email == "downany-release-automation@users.noreply.github.com" and
              .tagger.date == $date and .message == $message
            ' <<<"${tag_json}" >/dev/null
            expected_sha="$(
              printf 'object %s\ntype commit\ntag %s\ntagger Downany Release Automation <downany-release-automation@users.noreply.github.com> %s +0000\n\nDownany release %s\n' \
                "${expected_commit}" "${tag}" "${tagger_seconds}" "${tag}" |
                git hash-object -t tag --stdin
            )"
            [[ "${expected_sha}" =~ ^[0-9a-f]{40}$ && "${ref_sha}" == "${expected_sha}" ]] || return 1
            printf '%s\n' "${ref_sha}"
          }
          TAG_OBJECT_SHA="$(verify_remote_tag_identity "${TAG}" "${GITHUB_SHA}")" || {
            echo 'remote canonical tag identity mismatch' >&2; exit 1;
          }
          shopt -s nullglob
          mapfile -d '' -t FILES < <(find release-input -mindepth 1 -maxdepth 1 -type f -print0)
          ((${#FILES[@]} == 4)) || { echo 'release set must contain four regular files' >&2; exit 1; }
          for pattern in \
            'Downany-*-mac-arm64.dmg' \
            'Downany-*-win-x64.exe' \
            'Downany-chrome-extension-*.zip' \
            'Downany-third-party-sources-*.tar.zst'; do
            matches=(release-input/$pattern)
            ((${#matches[@]} == 1)) || { echo "release pattern must match once: ${pattern}" >&2; exit 1; }
          done

          DEFAULT_BRANCH="$(gh api "repos/${GITHUB_REPOSITORY}" --jq '.default_branch')"
          DEFAULT_PAGES="${RUNNER_TEMP}/default-branch-pages.json"
          gh api --paginate --slurp "repos/${GITHUB_REPOSITORY}/branches?per_page=100" >"${DEFAULT_PAGES}"
          DEFAULT_SHA="$(jq -er --arg branch "${DEFAULT_BRANCH}" \
            '[.[][] | select(.name == $branch)] | if length == 1 then .[0].commit.sha else error("default branch lookup mismatch") end' \
            "${DEFAULT_PAGES}")"
          [[ "${DEFAULT_SHA}" == "${GITHUB_SHA}" ]] || {
            echo 'release commit is no longer the remote default branch head' >&2
            exit 1
          }

          RELEASE_JSON="${RUNNER_TEMP}/release.json"
          RELEASE_PAGES="${RUNNER_TEMP}/release-pages.json"
          RELEASE_MATCHES="${RUNNER_TEMP}/release-matches.json"
          list_exact_tag_releases() {
            gh api --paginate --slurp "repos/${GITHUB_REPOSITORY}/releases?per_page=100" >"${RELEASE_PAGES}"
            jq --arg tag "${TAG}" '[.[][] | select(.tag_name == $tag)]' \
              "${RELEASE_PAGES}" >"${RELEASE_MATCHES}"
          }
          list_exact_tag_releases
          [[ "$(jq -er 'length' "${RELEASE_MATCHES}")" == 0 ]] || {
            echo 'refusing to reuse or mutate an existing release for this tag' >&2
            exit 1
          }
          [[ "$(verify_remote_tag_identity "${TAG}" "${GITHUB_SHA}")" == "${TAG_OBJECT_SHA}" ]] || {
            echo 'remote canonical tag identity moved before draft creation' >&2; exit 1;
          }

          gh release create "${TAG}" "${FILES[@]}" \
            --repo "${GITHUB_REPOSITORY}" \
            --draft \
            --generate-notes \
            --title "${TAG}" \
            --verify-tag

          list_exact_tag_releases
          jq -e --arg tag "${TAG}" '
            length == 1 and
            .[0].tag_name == $tag and .[0].name == $tag and
            .[0].draft == true and .[0].prerelease == false and
            (.[0].id|tostring|test("^[1-9][0-9]*$"))
          ' "${RELEASE_MATCHES}" >/dev/null || {
            echo 'new draft release identity mismatch after upload' >&2
            exit 1
          }
          jq '.[0]' "${RELEASE_MATCHES}" >"${RELEASE_JSON}"
          RID="$(jq -er '.id' "${RELEASE_JSON}")"
          [[ "$(verify_remote_tag_identity "${TAG}" "${GITHUB_SHA}")" == "${TAG_OBJECT_SHA}" ]] || {
            echo 'remote canonical tag identity moved during draft staging' >&2; exit 1;
          }

          EXPECTED="$({
            for file in "${FILES[@]}"; do
              jq -cn --arg name "$(basename "${file}")" --argjson size "$(stat -c %s "${file}")" \
                '{name:$name,size:$size,state:"uploaded"}'
            done
          } | jq -cs 'sort_by(.name)')"
          remote_assets() {
            gh api --paginate "repos/${GITHUB_REPOSITORY}/releases/${RID}/assets?per_page=100" \
              --jq '.[] | {name:.name,size:.size,state:.state}' | jq -cs 'sort_by(.name)'
          }
          REMOTE="$(remote_assets)"
          [[ "${REMOTE}" == "${EXPECTED}" ]] || { echo "draft asset set mismatch: ${REMOTE}" >&2; exit 1; }
          gh api "repos/${GITHUB_REPOSITORY}/releases/${RID}" |
            jq -e --arg tag "${TAG}" --argjson rid "${RID}" '
              .id == $rid and .tag_name == $tag and .name == $tag and
              .draft == true and .prerelease == false
            ' >/dev/null
```

workflow 中所有 action 锁定为本任务审计过的 immutable commit：`actions/checkout@11d5960a326750d5838078e36cf38b85af677262`、`actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020`、`actions/setup-python@a26af69be951a213d495a4c3e4e4022e16d87065`、`actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02`、`actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093`。release job 只允许首次 tag-push attempt；Create Release前验证default branch SHA等于`GITHUB_SHA`，并按内嵌`verify_remote_tag_identity`验证远端ref必须是由`tag/GITHUB_SHA/固定tagger`推导的唯一canonical annotated-tag object。draft通过 authenticated paginated release list exact tag筛选且必须为零项；任何既有draft/public Release均零mutation失败。随后单次`gh release create --draft --verify-tag`创建全新draft并上传四件exact set；命令失败或response loss留下的partial draft只由runner绑定为quarantine证据，workflow与runner都不复用、不清空且Release/asset DELETE永久为零。创建后必须重新分页得到唯一同tag、同title、`draft=true/prerelease=false`且ID为正整数的Release；asset上传后再次验证同一canonical tag object SHA与payload，四件 exact-set相等后仍保持该draft。`GH_TOKEN/GH_REPO`固定设置，不缓存 native output或 credential。

- [ ] **Step 6: 在本机和 CI 验证布局**

Windows：

```powershell
$env:DOWNANY_TELEGRAM_API_ID = "123456"
$env:DOWNANY_TELEGRAM_API_HASH = "0123456789abcdef0123456789abcdef"
.\scripts\build_windows_nsis.ps1
$Installer = @(Get-ChildItem desktop\release -File -Filter 'Downany-*-win-x64.exe')
if ($Installer.Count -ne 1) { throw 'NSIS count mismatch' }
$InstallDir = Join-Path $env:TEMP ("Downany 安装 验证 " + [guid]::NewGuid().ToString('N'))
if ($InstallDir -notmatch ' ' -or -not ($InstallDir.ToCharArray() | Where-Object { [int]$_ -gt 127 })) {
  throw 'NSIS smoke install path must contain both an ASCII space and a non-ASCII code point'
}
$Smoke = $null
try {
  $Install = Start-Process $Installer[0].FullName -ArgumentList @('/S', "/D=$InstallDir") -Wait -PassThru -WindowStyle Hidden
  if ($Install.ExitCode -ne 0) { throw 'NSIS install failed' }
  .\scripts\verify_telegram_bot_api_resource.ps1 -ResourceDir (Join-Path $InstallDir 'resources\telegram-bot-api') -CredentialsMode Required
  $SecretAuditScript = (Resolve-Path -LiteralPath 'scripts\audit_telegram_secrets.ps1').Path
  $PackageReceiptText = & $SecretAuditScript -PackageArtifact $Installer[0].FullName -PackageRoot $InstallDir -PackagePlatform windows-x64
  if ($LASTEXITCODE -ne 0) { throw 'installed package secret audit failed' }
  $PackageReceipt = $PackageReceiptText | ConvertFrom-Json
  if ($PackageReceipt.artifactSha256 -cne (Get-FileHash $Installer[0].FullName -Algorithm SHA256).Hash.ToLowerInvariant() -or $PackageReceipt.credentialFileCount -ne 1 -or $PackageReceipt.result -cne 'passed') { throw 'installed package secret audit receipt mismatch' }
  .\scripts\build_process_host_windows.ps1 -VerifyExecutable (Join-Path $InstallDir 'resources\process-host\DownanyProcessHost.exe')
  if ($LASTEXITCODE -ne 0) { throw 'installed ProcessHost verification failed' }
  $env:DOWNANY_DATA_DIR = Join-Path $env:TEMP ("DownanySmoke-" + [guid]::NewGuid().ToString('N'))
  $Smoke = Start-Process (Join-Path $InstallDir 'Downany.exe') -ArgumentList '--downany-package-smoke' -PassThru -WindowStyle Hidden
  if (-not $Smoke.WaitForExit(60000)) { throw 'controlled smoke timed out' }
  if ($Smoke.ExitCode -ne 0) { throw 'controlled smoke failed' }
  foreach ($StateName in @('owner-state.json','sidecar-owner-state.json')) {
    if (Test-Path -LiteralPath (Join-Path $env:DOWNANY_DATA_DIR "telegram\$StateName")) {
      throw "controlled smoke left owner state: $StateName"
    }
  }
  if (Test-Path desktop\resources\telegram-bot-api\app-credentials.json) { throw 'workspace credential leaked' }
}
finally {
  if ($Smoke -and -not $Smoke.HasExited) { Stop-Process -Id $Smoke.Id -Force -ErrorAction SilentlyContinue }
  Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -eq 'telegram-bot-api.exe' -or $_.Name -eq 'DownanySidecar.exe' -or $_.Name -eq 'DownanyProcessHost.exe') -and
    $_.ExecutablePath -and $_.ExecutablePath.StartsWith($InstallDir, [StringComparison]::OrdinalIgnoreCase)
  } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  $Uninstaller = Join-Path $InstallDir 'Uninstall Downany.exe'
  if (Test-Path $Uninstaller) {
    $Uninstall = Start-Process $Uninstaller -ArgumentList '/S' -Wait -PassThru -WindowStyle Hidden
    if ($Uninstall.ExitCode -ne 0) { throw 'silent uninstall failed' }
  }
  for ($Attempt = 0; $Attempt -lt 20 -and (Test-Path $InstallDir); $Attempt++) { Start-Sleep 1 }
  if (Test-Path $InstallDir) { throw 'install directory remains after uninstall' }
}
```

Expected: 实际 NSIS 安装目录通过 resource verifier 与 strict package-tree secret receipt，controlled smoke 正常返回 `0`，工作区 credentials 已清理；安装成功、失败或超时都会清理子进程并用安装目录的 `Uninstall Downany.exe /S` 清理，卸载非零或目录残留都使验证失败。Windows workflow/local verifier/Task17 runner 三处都必须生成 contained 的“中文 + ASCII 空格”安装目录、先断言两类字符同时存在，并把 `/D=<完整路径>` 保持为 NSIS 最后一个参数；`packaging.test.ts` 分别删除空格、删除非 ASCII 字符、把 `/D` 移到非末位时都必须失败。macOS 对称地实际挂载唯一 `Downany-*-mac-arm64.dmg`，对挂载卷资源运行 `--credentials required` verifier、package-aware scanner 与全 Mach-O verifier，严格核对 artifact SHA/receipt、检查 `LSMinimumSystemVersion=11.0`，再运行同一 controlled smoke并卸载 DMG。`packaging.test.ts` 必须解析 workflow 并证明两平台 verify step都注入 API ID/hash，在真实 mount/install 后且 detach/uninstall 前调用 package mode，核对 strict field set、artifact SHA与credential count；package-only CI 不要求 Bot Token。

- [ ] **Step 7: Commit**

```powershell
git add packaging/sidecar.spec packaging/cpython-windows-runtime.lock.json packaging/cpython-macos-runtime.lock.json scripts/build_sidecar.sh desktop/package.json desktop/package-lock.json desktop/electron-builder.yml desktop/electron/telegram/packaging.test.ts desktop/electron/packageSmoke.ts desktop/electron/packageSmoke.test.ts desktop/electron/main.ts scripts/build_macos_dmg.sh scripts/build_windows_nsis.ps1 scripts/verify_macos_package_arch.sh .github/workflows/release-packages.yml scripts/tests/telegramPackaging.test.mjs scripts/read_release_versions.mjs scripts/run_telegram_release_acceptance.ps1 scripts/tests/telegramReleaseAcceptance.test.mjs
git update-index --chmod=+x scripts/verify_macos_package_arch.sh
git ls-files --stage scripts/verify_macos_package_arch.sh
git commit -m "build: bundle telegram service in DMG and NSIS"
```

`git ls-files --stage` 必须显示 `scripts/verify_macos_package_arch.sh` 为 `100755`。

---

### Task 16: 更新用户、构建、商业与回归文档

**Files:**
- Modify: `README.md`
- Create: `docs/TELEGRAM-BOT-API-BUILD.md`
- Modify: `docs/RELEASE.md`
- Modify: `docs/COMMERCIAL.md`
- Modify: `docs/REGRESSION-2026-08.md`

- [ ] **Step 1: 写文档验收清单**

在 review checklist 中逐项要求出现：专用 Bot、单目标、启用后新下载、2000 MB 边界、下载/发送独立、Token 加密、不签名现状、官方 commit、两平台构建命令、DMG+NSIS+扩展 zip+对应第三方源码包同 tag、真实 Bot 门禁。

- [ ] **Step 2: 写用户文档**

README 说明从 BotFather 获取 Token、把 Bot 加到私聊/群组/频道、发送测试、启用自动发送、文件过大行为和断开连接结果。不得要求用户配置 `api_id/api_hash`，不得暴露本地服务实现词汇在主流程。

- [ ] **Step 3: 写固定输入、可审计构建与 release 文档**

`TELEGRAM-BOT-API-BUILD.md` 记录 Telegram/FFmpeg source commit、vcpkg baseline、普通 binary SHA256、curl-cffi 两个平台实际 wheel/report、libcurl-impersonate native component closure、依赖、原生命令、资源 manifest、许可证、全 Mach-O/System32 policy 验证和凭据清理。明确这是“固定输入、可审计构建”，不宣称 Homebrew/编译器环境完全 hermetic 或 bit-for-bit 可复现。RELEASE 增加 real Bot、随机回环端口、进程退出、包内资源、版本化扩展 zip、`Downany-third-party-sources-<version>.tar.zst` 与精确四件发布物门禁。COMMERCIAL 记录安装包体积、上游维护、FFmpeg/yt-dlp/curl-cffi 原生分发及对应源码义务、隐私和支持成本。

- [ ] **Step 4: 跑文档静态检查**

```powershell
rg -n "adfd7f6a8e990272851777eeb3ae0def4216f161|68af2cc3feb8c78aec2722c728fd87f03515fa7c|2_000_000_000|DMG|NSIS|extension" README.md docs packaging
rg -n "Downany-third-party-sources-|SOURCE-OFFER|四件" README.md docs packaging
rg -n "用户需要配置 api_id|用户需要配置 api_hash" README.md docs
```

Expected: 前两条覆盖相关文档与精确四件发布物；第三条无结果。

- [ ] **Step 5: Commit**

```powershell
git add README.md docs/TELEGRAM-BOT-API-BUILD.md docs/RELEASE.md docs/COMMERCIAL.md docs/REGRESSION-2026-08.md
git commit -m "docs: document telegram delivery and release gates"
```

---

## Phase 6 — 全链路验收

### Task 17A: 完成、测试并合并唯一 release runner

**Files:**
- Create: `scripts/run_telegram_release_bootstrap.ps1`
- Modify: `scripts/run_telegram_release_acceptance.ps1`
- Modify: `scripts/tests/telegramReleaseAcceptance.test.mjs`
- Create: `scripts/prepare_telegram_release_versions.mjs`
- Create: `scripts/tests/telegramReleaseVersions.test.mjs`

- [ ] **Step 1: 先写全部事务、强杀恢复和版本失败测试**

用 runner 的 fake Git/GitHub/filesystem/clock/credential adapters 覆盖 Task 17B 定义的 formal、acceptance、publication、abandoned-watch、credential lease 与 remote evidence ref 每个状态边界。每个外部 mutation 都要覆盖：调用前强杀、服务端已成功但本地返回非零、重跑读取远端真相、身份不符 fail closed。另覆盖零 workflow run、late run、attempt 2、默认分支前进、draft/public response loss、同 bytes 重复 ingest、不同 bytes 冲突、remote evidence ref 冲突和每种显式 abort。父环境逐个注入大小写变体的`GH_HOST/GH_REPO/GH_CONFIG_DIR/GH_TOKEN/GITHUB_TOKEN/GH_ENTERPRISE_TOKEN/GITHUB_API_URL/GITHUB_SERVER_URL`及指向foreign repo/API的fake config；断言provider只调用钉住gh绝对路径的`auth token --hostname github.com`，后续child只看见canonical session exact env/host/repo，foreign sentinel、foreign mutation与secret回显均为0。测试必须分别在 Windows PowerShell 5.1 与可用的 PowerShell 7 运行同一 fake fixture；任何输出、phase marker、report、Git blob 和环境都不得包含真实/fixture token、API ID/hash、PID、chat ID 或本地绝对路径；唯一例外是后述runner-private native operation owner允许持有受控PID/startedAt，但仍严禁secret/chat ID/本地路径外泄到公共材料。

同一fixture还要把fake `git/gh/node/npm/python/powershell/bash`依次放到父PATH首位、把当前目录放入PATH，并在freeze后分别替换钉住文件、改变stable ID或helper closure；automation、scanner、token provider、baseline、evidence push及Task17A/P/R三个执行fence都必须零fake sentinel、零secret、零foreign mutation。工具漂移只保留owner/phase marker并返回`RELEASE_TOOLCHAIN_IDENTITY_MISMATCH`；强杀后先按旧owner收敛整树，树空前不得尝试新工具。

同一fixture还要逐项替换private lock中的ProcessHost、TypeScript/Vite/Vitest entrypoint、递归JS/native/child executable closure与`desktop/package-lock.json` name/version/integrity；任一漂移、`.bin` wrapper、link/reparse、未知后代或参数变化都必须在启动Node/ProcessHost前返回`RELEASE_TOOLCHAIN_IDENTITY_MISMATCH`。正常automation只允许钉住Python/Node、锁定workspace closure和已预构建ProcessHost，CMake、MSBuild、clang、npm/npm.cmd及shell sentinel调用数必须为0；Vite所需esbuild等child executable必须命中closure manifest，否则失败。两个QA toolchain hash可彼此不同且不同于编排机，generate report原样记录本机hash、central ingest接受合法差异但拒绝缺失/非hex/伪填编排机hash。工具链初始化/重新初始化还必须与正式invocation竞争同一永久runner lease：A持有正式phase时初始化返回`TELEGRAM_RELEASE_RUNNER_BUSY`且private lock/批准记录零写入；初始化取得lease后先收敛旧native owner并确认整树为空，再重验active formal/acceptance/publication marker均为零，才允许temp→flush→rename→回读private lock与批准记录。分别在Windows与macOS覆盖初始化打开旧runner后、private-lock rename前后强杀，以及旧formal invocation持已打开fd/handle时发起重初始化；任何交错都不得产生两个可用toolchain truth、不得让active marker绑定已被替换的lock。另用精确barrier执行“A先捕获旧verified proof但尚未取lease→B取得lease并原子替换新lock后释放→A取得lease”：A必须先收敛旧owner，再由under-lease rebind发现path当前stable ID/raw SHA/runner hash不再等于proof，返回`RELEASE_PRIVATE_LOCK_IDENTITY_MISMATCH`且phase marker、Git/GitHub与远端mutation全部为零。

强杀门禁必须启动真实`DownanyProcessHost`、runner bridge与阻塞fake target，分别在operation intent写前、launching写后/bridge spawn前、bridge handshake前、quarantined写后/resume前、resume后/target返回前、target返回后/exit_observed前、exit_observed后/owner删除前强杀PowerShell runner。下一invocation须先取得runner lease，再收敛旧bridge/guardian/target/全部后代并确认exact tree为空，之后才可读写Git/GitHub/index；阻塞target的late-mutation sentinel永不得出现。candidate表驱动覆盖六个role（installer、uninstaller、两端smoke app、两端interactive app）、artifact_bound→package_bound替换、wrong artifact/package SHA、unknown role/path/argv、relative path逃逸、link/reparse、在非generate阶段调用、安装器派生child逃出containment、app成员不在package manifest、binding response-loss及每个role运行中hard-kill；interactive app另覆盖用户正常退出、超时、父runner强杀与任何Explorer/Finder/普通Start-Process旁路均为零。NSIS表驱动另覆盖runner从已验证installed uninstaller句柄预制唯一同字节temp副本、把副本身份原子写回binding后以副本为根完整删除成功，以及复制前/写临时文件后/rename前后/更新binding前后强杀、篡改副本、第二副本、错误`_?=`、额外参数与temp逃逸；每条失败都必须在副本用户代码执行前失败，旧树/专属temp归零。任一失败都必须零dynamic escape，旧候选树先归零，binding只在report已落盘后删除。scanner case另证明强杀后没有继续持有Telegram credential environment的进程。再用两个真实PowerShell进程证明：A持lease时B返回`TELEGRAM_RELEASE_RUNNER_BUSY`且mutation=0；强杀A后B取得同一inode lease但先恢复A的durable native operation。并发ingest不得丢ledger，publish/abort不得交叉。测试结束只允许永久零字节runner lock，operation owner、bridge、candidate binding/index/lock和后台进程全部消失。

上述“A旧proof→B成功替换→A rebind拒绝”精确序列只适用于macOS，因为旧fd不阻止rename；Windows对应测试要求A持有的不共享write/delete handle使B的替换在发布前失败、旧lock保持原字节，随后A在lease内rebind同一stable ID成功。Windows另以关闭A proof handle后B替换、A不得复用已dispose proof覆盖同一安全边界。

macOS candidate app还要用真实三树fixture覆盖外层app target PGID，以及Task7创建的Sidecar、Telegram两个独立inner target PGID与各自独立guardian identity：正常退出、关窗后台存活、外层runner/app强杀及每个inner owner-state写入边界后恢复，都必须先阻止外层app再次spawn/restart，再按两份v5 owner state分别验证/收敛guardian和target PGID，最后证明三个target PGID、两个inner guardian和两份owner state全部为空。不得要求guardian属于target PGID，也不得要求一个target进程同时属于outer与inner PGID；Windows继续验证outer Job对nested Job后代的完整containment。另覆盖outer app已resume但两个Task7 launching intent都尚未写入即强杀，以及Sidecar已observed/Telegram仍unobserved和反向两个混合边界：外层归零后，每个unobserved slot独立等待5秒spawn window、对该服务连续两次exact candidate枚举均为0才落自身`confirmed_empty_without_inner`，observed slot按snapshot收敛；两个slot都terminal后才提升总`confirmed_empty`。任一候选或枚举错误则fail closed。任一inner identity漂移、owner-state丢失但仍有匹配进程、状态文件越界/link或三树任一未空都保持native owner并返回`NATIVE_OPERATION_RECOVERY_REQUIRED`，report与binding不得提交/删除。

`telegramReleaseVersions.test.mjs` 使用临时仓库覆盖runner protocol的两种互斥模式：Baseline要求新desktop严格大于当前文件版本且remote proof证明对应tag/release/evidence ref均未使用，extension缺席时逐字保留；Abandoned要求desktop/extension分别严格大于marker值且不要求相等。两种模式都要求package.json、package-lock顶层与`packages[""]`三者相等；只允许生成被声明版本文件的planned bytes；第二个workspace replace后强杀再运行得到同一bytes；未知/额外marker或remote-proof字段、已用版本、非严格semver、版本未递增或GitHub读取失败均零commit。Task17P/17R执行fixture还要分别在`desktop/package.json`、`desktop/package-lock.json`、`browser-extension/manifest.json`预置同路径unstaged、staged、assume-unchanged、skip-worktree与fsmonitor-valid污染；写版本前的受控baseline必须全部拒绝，helper、workspace replace、`git add`、commit与远端mutation计数均为0。

Task17A fixture还必须分别在已dot-source批准runner scriptblock之后、调用baseline API之前，以同路径regular-file原子替换方式改写bootstrap与runner；新bytes保持strict UTF-8但SHA不同。两种情况都必须返回`RELEASE_APPROVED_SOURCE_IDENTITY_MISMATCH`，且ProcessHost、test/build、GitSession、git add/commit调用数均为0。另覆盖required数组缺项、额外项、重复path、unknown path、非lowercase hash，以及baseline成功后到Freeze前再次替换两文件；后者必须由Freeze拒绝且GitSession创建数为0。三个A/P/R commit fixture都从空system/global/local identity开始，并分别污染父进程六个`GIT_AUTHOR_*`/`GIT_COMMITTER_*`；提交必须成功且commit object中的name/email/date逐字等于session绑定值，父污染零传播。commit child响应丢失后只接受由同一parent/tree/message/identity重算出的唯一SHA，身份缺失、额外来源或漂移均不得第二次提交。

版本事务fixture必须覆盖baseline后到helper副本捕获前替换helper或任一输入、捕获后替换workspace helper、父GH/GITHUB/config/API/proxy污染与foreign repository、token/metadata失败、Node环境/argv/stdin/owner/marker秘密扫描，以及marker、remote proof、helper output、每个target replace、git add、commit调用与commit响应返回前后的真实强杀。捕获后替换workspace helper只能执行已捕获的受信副本，随后因workspace identity漂移拒绝commit；混合preimage/output只能按marker收敛成唯一output，第三种bytes fail closed；commit响应丢失只认唯一parent+exact diff且不得第二次commit；active marker下换版本参数立即拒绝。remote版本在apply前或add前变为已使用时add/commit为零；在private add成功后、commit前翻转时commit为零、真实index全程等于原baseline并guarded恢复worktree。逐点强杀add intent前、candidate index lock创建后、candidate index rename后、post-add检查/`index_staged`落盘前、commit返回前后、真实index同步lock/rename前后；恢复必须把candidate index判为base、exact output staged或foreign三种且只接受前两种，最终要么HEAD/index/worktree全等原baseline，要么HEAD为唯一新commit且真实index/worktree精确等于其tree。另逐项注入版本helper返回后的test/build/diff/add/commit普通异常，Task17P/17R必须调用同参`-Abort`并把HEAD、真实index、工作树与config恢复为原baseline；在`abort_requested`、删除candidate index/lock、`rollback_pending`、每个preimage replace、clean baseline复核与root删除前后强杀均须幂等收敛。commit已落地但响应丢失后再Abort必须返回`commit_observed`且绝不回滚；foreign HEAD、真实index、worktree bytes、config或owner出现时Abort必须零覆盖并保留marker。成功`aborted`后允许不同版本参数与toolchain重新初始化。注入foreign candidate/real staged entry、额外lock/sibling或不同index bytes必须零覆盖并保留marker。每条成功/失败路径最终均无Token lease、GitHub config、native tree、GitSession、candidate/real index lock或无owner staging残留。

另以真实双进程覆盖每个version marker状态与toolchain初始化竞争：marker存在时初始化即使已取得runner lease也必须返回`VERSION_PREPARATION_ACTIVE`，private lock与批准记录零写入；普通runner用marker中同一toolchainSha256完成或回滚并清root后，初始化才可成功。手工替换private lock或提交不同批准hash时，普通runner只允许先收敛旧native tree，随后identity mismatch且marker/index/worktree零改写。

- [ ] **Step 2: 实现最终 runner 与凭据 lease**

runner 的最终公开参数、strict DTO、状态机和命令以 Task 17B 为唯一合同；Task 17B 不得再修改 runner、测试、workflow 或 helper。所有 marker 只在`.build` containment下以同目录临时文件、flush、原子rename、回读schema/hash写入；未知字段或身份不符fail closed。纯参数校验后先取得全程runner lease；每次入口的首个transaction动作都是无凭据native-operation recovery，旧树/owner或active phase marker未收敛时禁止新tag、版本、Release、ledger、index或evidence mutation。

除操作者从已批准绝对路径启动的**当前根PowerShell进程**外，所有新native child都只经`Invoke-CheckedNativeOwned`或受phase限制的`Invoke-CheckedCandidateNativeOwned`执行；根进程不是runner创建的child，不写native-operation owner，也不预占runner lease。runner复用Task7已构建并验证的`desktop/resources/process-host/DownanyProcessHost.exe`或无后缀macOS binary；每台编排/QA机先完成当前平台Task14 build、binary verifier与parent-death smoke。资源缺失、link/reparse、平台错误或未验证时返回`PROCESS_HOST_REQUIRED`且transaction mutation=0，环境变量不得替换executable。为让Windows PowerShell 5.1使用fd3协议，runner内嵌固定UTF-8 Node bridge bytes，只在持runner lease时写`.build/telegram-release-native-bridge/v1/bridge.mjs`：随机同目录temp→flush→原子rename→回读byte SHA；既有文件只允许exact bytes，link/reparse或额外sibling fail closed。bridge只在内存传argv/env/stdin，不把它们落盘，不进入tracked source/evidence/receipt；tree空后删除，强杀遗留由下一invocation按exact bytes复用并清理。

ProcessHost只解决进程树所有权，不把`PATH`中的同名程序变成可信工具。新增的`run_telegram_release_bootstrap.ps1`是唯一最小自举实现：加载时只定义`Open-ApprovedRunnerInitialization`与`Open-ApprovedReleaseBootstrap`并立即返回，绝不解析CLI、打开runner lease、spawn或产生仓库/远端mutation。runner的已验证内存scriptblock只接受互斥的`RunnerInitializationProof`或`BootstrapProof`、定义对应函数并立即返回，由它提供唯一`Initialize-ReleaseToolchain`与`Resolve-ReleaseToolchain`。bootstrap文件本身不能自行建立信任：每个根fence先用下文固定的纯.NET加载前言读取其raw bytes，与工作区外显式`ExpectedBootstrapSha256`比较，按strict UTF-8/no BOM/no NUL转成内存scriptblock并只dot-source该捕获bytes；hash不符时script side effect、lease、owner与phase mutation全为零。路径/ancestor在读取前后被替换成不同bytes仍失败，替换成相同已批准bytes不改变执行语义。首次初始化没有private lock，必须从已批准bootstrap scriptblock调用`Open-ApprovedRunnerInitialization -ExpectedWorkspaceRoot <canonical> -PlatformName <platform> -BootstrapSha256 <verified-external-hash> -ExpectedRunnerSha256 <external-approved>`，由它以no-follow handle读取runner、验证外部hash并返回一次性`RunnerInitializationProof`，再只以`-InitializationProof` dot-source该proof内runner scriptblock；绝不能从路径直接dot-source。随后在同一已批准PowerShell进程中调用初始化函数，显式传入Git、`git-remote-https`、gh、Node、Python、当前PowerShell、当前平台已由Task 14构建并验证的ProcessHost，以及`desktop/node_modules`内vitest、TypeScript、Vite三个真实JS entrypoint的**绝对路径**；macOS再必填`/bin/bash`，两端还必须通过可重复`-TrustedPathDirectory <absolute>`显式批准平台验证脚本会启动的系统/工具目录。函数只用当前进程/.NET文件API解析和散列，禁止`Get-Command`、`where/which`、PATH/PATHEXT、alias/function、当前目录、环境变量或shell shim参与选择。普通工具路径逐ancestor拒绝link/reparse；macOS只允许逐跳核验后钉住最终realpath。它们必须是regular file、位于操作者批准的系统/工具安装root而非workspace、`.build`、temp或当前目录，记录size、SHA256、平台stable file ID、严格version/provenance；Git的HTTPS helper、exec-path及会由该Git进程启动的固定helper closure也逐文件钉住。Windows trusted-directory exact set只允许规范realpath后的`%SystemRoot%\System32`、VS Installer目录、当前Task14 verifier使用的唯一VS2022工具bin目录以及上述已批准工具自身closure；macOS只允许规范realpath后的`/bin`、`/usr/bin`与上述工具closure。每个目录的全部regular executable/helper逐项入manifest，link逐跳核验，未入manifest的后代仍失败；因此`hdiutil/otool/lipo/plutil`、Windows verifier的`vswhere/dumpbin`等平台命令不是PATH例外。ProcessHost是唯一允许位于当前平台资源目录的native executable，初始化时把其platform/hash/stable ID与Task 14 verifier结果绑定；三个workspace Node entrypoint是唯一允许位于workspace的静态工具输入，必须是`desktop/node_modules`的regular non-link descendant，并由`desktop/package-lock.json`中的exact package name/version/integrity、entrypoint raw SHA和递归加载closure manifest共同绑定。它们不得从`.bin` wrapper、npm script、PATH或shell解析；正式runner从不重新构建ProcessHost，也不调用CMake、编译器、npm/npm.cmd或任意未钉住workspace CLI。初始化只写ignored private `.build/telegram-release-toolchain/<platform>.json`，父目录/文件逐ancestor拒绝link/reparse，macOS强制并复核0700/0600，Windows只允许当前用户SID与SYSTEM Full Control且关闭继承；不读凭据、不执行目标工具、不访问Git/GitHub、不修改仓库。它只向操作者输出批准记录，路径不得进入公共marker、binding、report、evidence、receipt或日志。

两个bootstrap入口的exact参数不得采用前文缩写：初始化入口固定为`Open-ApprovedRunnerInitialization -ExpectedWorkspaceRoot <canonical> -PlatformName <platform> -BootstrapSha256 <verified-external-hash> -ExpectedRunnerSha256 <external-approved>`；正式入口固定为`Open-ApprovedReleaseBootstrap -ExpectedWorkspaceRoot <canonical> -PlatformName <platform> -BootstrapSha256 <verified-external-hash> -ExpectedRunnerSha256 <external-approved> -ExpectedPrivateLockSha256 <external-approved>`。任一缺失、额外或从环境反推的参数都在打开runner/private lock前失败。

private lock 的canonical UTF-8/LF strict DTO固定为：

~~~json
{
  "schemaVersion": 1,
  "platform": "windows-x64",
  "runnerScriptSha256": "64-lowercase-hex",
  "processHost": {
    "platform": "windows-x64",
    "canonicalPath": "C:/absolute/repository/desktop/resources/process-host/DownanyProcessHost.exe",
    "size": 1,
    "sha256": "64-lowercase-hex",
    "stableFileId": "platform-canonical-file-id",
    "verificationPolicy": "task14-process-host-v1"
  },
  "tools": [
    {
      "logicalName": "git",
      "kind": "executable",
      "canonicalPath": "C:/absolute/operator-approved/path/git.exe",
      "size": 1,
      "sha256": "64-lowercase-hex",
      "stableFileId": "platform-canonical-file-id",
      "version": "strict-version",
      "provenance": "operator-approved-absolute"
    }
  ],
  "workspaceNodeTools": [
    {
      "logicalName": "typescript",
      "packageName": "typescript",
      "packageVersion": "5.9.3",
      "packageIntegrity": "sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==",
      "canonicalRelativePath": "desktop/node_modules/typescript/bin/tsc",
      "size": 1,
      "sha256": "64-lowercase-hex",
      "stableFileId": "platform-canonical-file-id",
      "closureManifestSha256": "64-lowercase-hex"
    },
    {
      "logicalName": "vite",
      "packageName": "vite",
      "packageVersion": "5.4.21",
      "packageIntegrity": "sha512-o5a9xKjbtuhY6Bi5S3+HvbRERmouabWbyUcpXXUA1u+GNUKoROi9byOJ8M0nHbHYHkYICiMlqxkg1KkYmm25Sw==",
      "canonicalRelativePath": "desktop/node_modules/vite/bin/vite.js",
      "size": 1,
      "sha256": "64-lowercase-hex",
      "stableFileId": "platform-canonical-file-id",
      "closureManifestSha256": "64-lowercase-hex"
    },
    {
      "logicalName": "vitest",
      "packageName": "vitest",
      "packageVersion": "2.1.9",
      "packageIntegrity": "sha512-MSmPM9REYqDGBI8439mA4mWhV5sKmDlBKWIYbA3lRb2PTHACE0mgKwA8yQ2xq9vxDTuk4iPrECBAEW2aoFXY0Q==",
      "canonicalRelativePath": "desktop/node_modules/vitest/vitest.mjs",
      "size": 1,
      "sha256": "64-lowercase-hex",
      "stableFileId": "platform-canonical-file-id",
      "closureManifestSha256": "64-lowercase-hex"
    }
  ],
  "trustedPathDirectories": [
    {
      "canonicalPath": "C:/absolute/operator-approved/tool-directory",
      "manifestSha256": "64-lowercase-hex"
    }
  ]
}
~~~

`runnerScriptSha256`散列当前contained `scripts/run_telegram_release_acceptance.ps1` raw bytes；初始化时由操作者一并批准。Windows `tools.logicalName` exact set为`git/git-remote-https/gh/node/python/powershell`，macOS再加`bash`；按logicalName UTF-8 bytes排序且拒绝额外/缺失项，`kind`仅git-remote-https为`git-helper`，其他为`executable`。`processHost`必须精确一项并匹配当前platform与Task 14已验证resource；`workspaceNodeTools.logicalName` exact set为`typescript/vite/vitest`，按logicalName排序，canonical relative path分别只能指向锁定package真实entrypoint，package name/version/integrity必须逐字段等于当前`desktop/package-lock.json`。closure manifest必须枚举entrypoint递归加载、动态import、worker/native addon与child-process可达的全部regular文件和可执行文件，逐项记录relative path/size/SHA/stableFileId；只允许命中该manifest的后代，拒绝`.bin`、link/reparse、额外或漂移成员。trustedPathDirectories按canonicalPath排序，其manifest列出该目录允许被descendant解析的exact regular-file path/size/SHA/stableFileId，不能只散列目录名。`toolchainSha256`是上述private lock raw bytes SHA。首次初始化还必须在同一个已批准根PowerShell进程中，用显式、来自代码审核/冻结HEAD且不从workspace读取的`ExpectedBootstrapSha256`与`ExpectedRunnerSha256`分别验证bootstrap/runner bytes；成功后只向操作者/CI protected variable输出canonical `{schemaVersion:1,platform,bootstrapSha256,runnerSha256,privateLockSha256}`批准记录，禁止把该记录写回workspace、`.build`、marker或仓库。后续每个执行fence必须显式接收批准记录中的三个hash与canonical workspace root，绝不能从待保护bootstrap、private lock、marker或环境变量反推信任锚。

四个执行fence在任何bootstrap dot-source、lease、owner或phase mutation前都逐字包含同一段固定加载前言。该前言只用当前PowerShell与BCL：把显式workspace root与固定relative path`scripts/run_telegram_release_bootstrap.ps1`组合成唯一absolute path，`ReadAllBytes`后立即计算SHA256并逐字等于外部`ExpectedBootstrapSha256`，拒绝BOM/NUL/非法UTF-8，再从**已捕获bytes**创建并dot-source scriptblock；它不接受环境变量或第二条bootstrap path。因为信任锚在工作区外，读取时发生ancestor link/rename/swap也只能得到“exact approved bytes并安全执行”或“hash不符且零执行”两种结果。已批准bootstrap的公开入口固定为`Open-ApprovedRunnerInitialization`与`Open-ApprovedReleaseBootstrap -ExpectedWorkspaceRoot <canonical> -PlatformName <platform> -BootstrapSha256 <verified-external-hash> -ExpectedRunnerSha256 <external-approved> -ExpectedPrivateLockSha256 <external-approved>`；它自身不得spawn/Add-Type/compiler或加载另一个workspace函数。bootstrap固定解析workspace下private lock与runner两个relative path：Windows逐ancestor以`CreateFileW(FILE_FLAG_OPEN_REPARSE_POINT)`持有handle，拒绝reparse，最终regular file使用不含`FILE_SHARE_WRITE/DELETE`的share mode，并以`GetFileInformationByHandle/GetFinalPathNameByHandleW`验证stable ID与canonical containment；macOS从`/`开始用`openat(O_NOFOLLOW|O_DIRECTORY)`逐层持有dir fd，最终用`openat(O_RDONLY|O_NOFOLLOW)`，`fstat`要求regular、`nlink=1`与canonical containment。private lock另复核0600或当前SID+SYSTEM exact ACL。runner handle必须始终成功且raw SHA等于外部`ExpectedRunnerSha256`，否则在runner side effect前失败；runner bytes只允许strict UTF-8/no BOM/no NUL并生成内存scriptblock。private lock存在且raw SHA等于外部`ExpectedPrivateLockSha256`时，必须与runner同时持有，且lock内`runnerScriptSha256`也等于同一runner hash，生成`state=verified` proof。lock缺失、ACL/identity/hash不符时，不信任或解析其bytes，只生成`state=recovery_only` proof；该proof只允许可信runner取得lease、按既有owner bytes收敛旧native整树，然后无论owner是否存在都返回`RELEASE_PRIVATE_LOCK_IDENTITY_MISMATCH`，不得读phase marker或产生仓库/远端mutation。两个handle/fd持续到本次invocation结束；调用方只dot-source proof内**内存runner scriptblock**，绝不能`. $RunnerPath`或再次按路径打开。bootstrap失败必须关闭全部handle/fd并保持runner side effect、lease、owner、phase mutation为零。

上句的初始化入口名称绝不构成参数缩写：任何首次初始化或重新初始化调用都必须逐字使用前文固定的完整`Open-ApprovedRunnerInitialization -ExpectedWorkspaceRoot <canonical> -PlatformName <platform> -BootstrapSha256 <verified-external-hash> -ExpectedRunnerSha256 <external-approved>`签名；缺少或增加参数一律在打开runner前失败。

`run_telegram_release_bootstrap.ps1`在Windows PowerShell 5.1与macOS PowerShell 7都用当前进程内`Reflection.Emit`定义最小P/Invoke delegate/type，不调用`Add-Type`、CodeDom、csc、shell或任意native child；Task17A测试从四个fence抽取加载前言并要求逐字相等，再以外部expected hash运行bootstrap的真实raw bytes。缺文件、错hash、非法编码、ancestor junction/symlink、读取后swap、runner/lock任一ancestor或leaf link、双文件swap、ACL/identity漂移都必须在既定安全边界fail closed。首次初始化另有真实命令测试，证明从干净PowerShell只靠三个显式hash与workspace root即可生成private lock和canonical批准记录，不存在未定义函数或上一fence状态依赖。

首次初始化的唯一命令形状固定为下列单块；它与正式fence共用相同bootstrap加载前言，但尚无private-lock参数，也不进入任何正式phase：

~~~powershell
param(
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedBootstrapSha256,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedRunnerSha256,
    [Parameter(Mandatory)][string]$ExpectedWorkspaceRoot,
    [Parameter(Mandatory)][string]$GitExecutable,
    [Parameter(Mandatory)][string]$GitRemoteHttpsExecutable,
    [Parameter(Mandatory)][string]$GhExecutable,
    [Parameter(Mandatory)][string]$NodeExecutable,
    [Parameter(Mandatory)][string]$PythonExecutable,
    [Parameter(Mandatory)][string]$PowerShellExecutable,
    [Parameter(Mandatory)][string]$ProcessHostExecutable,
    [Parameter(Mandatory)][string]$DesktopVitestEntrypoint,
    [Parameter(Mandatory)][string]$DesktopTypeScriptEntrypoint,
    [Parameter(Mandatory)][string]$DesktopViteEntrypoint,
    [Parameter(Mandatory)][string[]]$TrustedPathDirectory,
    [string]$BashExecutable
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$PlatformName = if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) { 'windows-x64' } else { 'macos-arm64' }
$CanonicalWorkspaceRoot = [IO.Path]::GetFullPath($ExpectedWorkspaceRoot)
$BootstrapPath = [IO.Path]::GetFullPath([IO.Path]::Combine($CanonicalWorkspaceRoot, 'scripts', 'run_telegram_release_bootstrap.ps1'))
$BootstrapBytes = [IO.File]::ReadAllBytes($BootstrapPath)
$Hasher = [Security.Cryptography.SHA256]::Create()
try { $BootstrapActualSha256 = ([BitConverter]::ToString($Hasher.ComputeHash($BootstrapBytes))).Replace('-', '').ToLowerInvariant() } finally { $Hasher.Dispose() }
if ($BootstrapActualSha256 -cne $ExpectedBootstrapSha256) { throw 'RELEASE_BOOTSTRAP_IDENTITY_MISMATCH' }
if (($BootstrapBytes.Length -ge 3 -and $BootstrapBytes[0] -eq 0xEF -and $BootstrapBytes[1] -eq 0xBB -and $BootstrapBytes[2] -eq 0xBF) -or ($BootstrapBytes -contains [byte]0)) { throw 'RELEASE_BOOTSTRAP_ENCODING_INVALID' }
$StrictUtf8 = New-Object Text.UTF8Encoding($false, $true)
$BootstrapScriptBlock = [ScriptBlock]::Create($StrictUtf8.GetString($BootstrapBytes))
. $BootstrapScriptBlock
$InitializationProof = Open-ApprovedRunnerInitialization -ExpectedWorkspaceRoot $CanonicalWorkspaceRoot -PlatformName $PlatformName -BootstrapSha256 $BootstrapActualSha256 -ExpectedRunnerSha256 $ExpectedRunnerSha256
try {
    . $InitializationProof.RunnerScriptBlock -InitializationProof $InitializationProof
    $InitializationArgs = @{
        InitializationProof = $InitializationProof; GitExecutable = $GitExecutable; GitRemoteHttpsExecutable = $GitRemoteHttpsExecutable
        GhExecutable = $GhExecutable; NodeExecutable = $NodeExecutable; PythonExecutable = $PythonExecutable
        PowerShellExecutable = $PowerShellExecutable; ProcessHostExecutable = $ProcessHostExecutable
        DesktopVitestEntrypoint = $DesktopVitestEntrypoint; DesktopTypeScriptEntrypoint = $DesktopTypeScriptEntrypoint
        DesktopViteEntrypoint = $DesktopViteEntrypoint; TrustedPathDirectory = $TrustedPathDirectory
    }
    if ($PlatformName -eq 'macos-arm64') {
        if ([string]::IsNullOrWhiteSpace($BashExecutable)) { throw 'BASH_EXECUTABLE_REQUIRED' }
        $InitializationArgs.BashExecutable = $BashExecutable
    } elseif (-not [string]::IsNullOrEmpty($BashExecutable)) { throw 'BASH_EXECUTABLE_FORBIDDEN' }
    $Approval = Initialize-ReleaseToolchain @InitializationArgs
    Write-Output $Approval.CanonicalJson
} finally {
    $InitializationProof.HandleLease.Dispose()
}
~~~

`CanonicalJson`必须是无BOM、LF、末尾单LF的canonical批准记录，字段exact为`schemaVersion/platform/bootstrapSha256/runnerSha256/privateLockSha256`且不含路径；操作者把它复制到工作区外受保护存储。初始化finally必须dispose proof；任何失败只允许删除本次尚未发布的临时private-lock文件，不得遗留半成品或触碰Git/GitHub/phase marker。

内存`RunnerInitializationProof` exact成员为`SchemaVersion=1/State="initialization"/CanonicalWorkspaceRoot/Platform/BootstrapSha256/RunnerCanonicalPath/RunnerSha256/RunnerStableId/RunnerScriptBlock/HandleLease`；它没有任何PrivateLock字段，只允许传给runner scriptblock的`-InitializationProof`与`Initialize-ReleaseToolchain -InitializationProof`，不得传给正式根wrapper或进入formal/acceptance/publication phase。`Initialize-ReleaseToolchain`在全部纯参数校验后必须取得与正式runner相同的永久runner lease；持锁后只用已验证runner/.NET先恢复既有native-operation owner并确认guardian/target/全部后代为零，再重新读取并要求active formal/acceptance/publication marker全部不存在，之后才允许创建、替换和回读private lock及批准记录。初始化期间不得执行候选phase mutation、Git/GitHub、凭据或目标工具；任何失败都在确认本次临时文件owner后清理并释放lease，已有有效lock保持原字节。内存`BootstrapProof` exact成员为`SchemaVersion=1/State/CanonicalWorkspaceRoot/Platform/BootstrapSha256/PrivateLockBytes/PrivateLockSha256/PrivateLockStableId/RunnerCanonicalPath/RunnerSha256/RunnerStableId/RunnerScriptBlock/HandleLease`；`State`只允许`verified/recovery_only`，后者三个PrivateLock字段必须全null，前者必须全非null。两种proof都不可序列化、不可复制、一次性private，绝不能进入marker/report/log；runner scriptblock入口只接受互斥的`-InitializationProof`或`-BootstrapProof`，按exact成员/State拒绝混用和额外字段，并只定义对应API后立即返回。正式runner顶层只接受`-BootstrapProof`，不得依赖`$PSScriptRoot/$MyInvocation.MyCommand.Path`，所有root/lock/toolchain bytes来自proof；wrapper finally无论成功/异常都dispose HandleLease，复用已dispose proof失败。dot-source后当前进程调用根wrapper：先纯参数校验、再取得runner lease，仅用已验证runner/.NET与持久owner收敛旧native-operation整树；`recovery_only`到此固定返回lock mismatch。`verified`必须在同一lease内用bootstrap相同no-follow规则重新打开canonical private-lock path，重算当前stable ID/raw SHA并验证当前lock内runnerScriptSha256，三者逐字等于proof后才允许继续；该under-lease rebind不得用proof旧handle的存在替代。任一不等仍保留已完成的旧owner收敛，随后返回`RELEASE_PRIVATE_LOCK_IDENTITY_MISMATCH`，绝不读取phase marker或产生Git/GitHub/远端mutation。rebind成功后才调用`Assert-ReleaseBootstrapHostIdentity`核对当前进程image与lock中powershell身份、解析proof内完整private lock并进入phase recovery/本次Step。身份不符只能终止本次调用，不能倒退已安全完成的旧树恢复；禁止另一个owned PowerShell child包裹根入口。首次freeze把toolchain hash写入formal marker；automation/secret-audit receipt逐字复制，formal→acceptance binding→publication marker/receipt继续复制；后续编排机invocation还必须匹配外部批准hash。QA generate可使用本机不同合法private lock，但必须把本机`runnerToolchainSha256`写入strict report；central ingest只接受规范hash，不接受路径。

上句初始化时“active marker全部不存在”的exact集合还必须同时包含`.build/telegram-release-version-preparation/marker.json`与`.build/telegram-release-tooling-commit/marker.json`：version marker的任一合法状态（包括`commit_observed/cleanup_pending`）或tooling marker的任一合法状态（包括`commit_observed/index_sync_attempted/index_synced/cleanup_pending`）都只能由当前已批准toolchain的普通runner按对应事务合同恢复/清理，初始化不得读取后猜测完成，更不得创建、替换private lock。持runner lease后发现version marker时固定返回`VERSION_PREPARATION_ACTIVE`，发现tooling marker时固定返回`TOOLING_COMMIT_ACTIVE`；任一情况下批准记录与private lock写入数均为零。只有普通runner使用同一toolchain收敛对应native/Git树、删除marker/root并释放lease后的新初始化才可继续。双进程fixture必须把初始化分别卡在tooling commit的`add_attempted/index_staged/commit_attempted/index_sync_attempted`边界，断言初始化全程失败关闭且旧tooling事务仍能恢复。

dot-source已验证内存scriptblock后公开给三个执行fence的唯一工具API固定为`Invoke-ReleaseRunnerInProcess -BootstrapProof <verified-once-object> -ExpectedHostMode <NonInteractive|Interactive> -RunnerArguments <string[]>`、`Invoke-WithReleaseToolingLease -BootstrapProof <verified-once-object> -ExpectedHostMode <NonInteractive|Interactive> -Callback <scriptblock>`、`Get-ReleaseTool -Toolchain <resolved> -LogicalName <id>`、`Get-ReleaseProcessHost -Toolchain <resolved>`、`Assert-ReleaseRepositoryBaseline -Toolchain <resolved> -ExpectedWorkspaceHead <40-lowercase-hex|null> -RequireNeutralIndexFlags <bool> [-AllowedInitialChangedPaths <string[]>]`、`Freeze-ReleaseWorkspaceManifest -Toolchain <resolved> -BaselineProof <baseline-proof> -ExpectedChangedPaths <string[]>`、`Open-ReleaseGitSession -Toolchain <resolved> -WorkspaceManifestProof <manifest-proof> -CandidateHead <40-lowercase-hex|null> -PermittedMutationPaths <string[]>`、`Invoke-CheckedGitOwned -GitSession <private-session> -ArgumentList <string[]> [-CaptureOutput] [-ExpectedCommitManifest <manifest-proof>]`、`Invoke-CheckedNativeOwned -Toolchain <resolved> -LogicalName <non-git-id> -ArgumentList <string[]> [-WorkspaceManifestProof <manifest-proof>] [-CaptureOutput]`、`Invoke-WorkspaceNodeToolOwned -Toolchain <resolved> -LogicalName <typescript|vite|vitest> -ArgumentList <string[]> [-WorkspaceManifestProof <manifest-proof>]`与只供平台QA generate内部调用的`Invoke-CheckedCandidateNativeOwned -Role <windows_installer|windows_app|windows_app_interactive|windows_uninstaller|macos_app|macos_app_interactive> -Binding <strict-object> -ArgumentList <string[]>`；API不得接受`PrivateLock/PrivateLockPath/RunnerPath`并重新读取。`Assert-ReleaseRepositoryBaseline`只在已持runner lease且旧native owner已收敛时调用下文唯一`Verify-RepositoryBaseline`实现；它在自己的固定owned Git sandbox内捕获live HEAD，`ExpectedWorkspaceHead=null`时把该值冻结为本次workspace head，非null时要求逐字相等，并返回exact、一次性只存内存的`{schemaVersion:1,workspaceHeadSha:<40-lowercase-hex>,realIndexSha256:<64-lowercase-hex>,allowedInitialChangedPaths:<sorted-string[]>,initialChangedManifest:<sorted-{path,type,size,sha256}[]>}`。默认两个数组必须为空；只有Task17A tooling fence可传其exact五项，且baseline必须证明真实index仍等于HEAD、工作树changed/untracked exact set恰为该数组、其他路径完全干净，并把当刻每项regular-file bytes写入manifest。`Freeze-ReleaseWorkspaceManifest`要求HEAD/real index/config/flags仍等于baseline proof，重新枚举changed/untracked exact set并逐文件no-follow读取`type="regular"/size/SHA256`；Task17A要求逐字等于baseline中的initial manifest，P/R则从clean baseline后的受信版本helper结果首次建立manifest。它返回callback-private、不可序列化的exact `{schemaVersion:1,workspaceHeadSha,realIndexSha256,changedManifest,manifestSha256}`，其中manifestSha256散列canonical数组。返回前必须确认临时index/lock/config/hooks/owned Git tree均已清理，绝不把真实index stat cache当权威；调用方不得先用普通checked Git取得HEAD。`Open-ReleaseGitSession`逐字验证manifest proof仍绑定当前toolchain/workspace/HEAD/index和每项bytes，把`PermittedMutationPaths`固定为manifest path exact set并返回callback-private、不可序列化、不可跨lease的session；所有Git命令只能传该session。session在每条命令前重验live workspace HEAD、real index、config和manifest bytes只发生已观察的session transition；`git add`后要求stage-0 blob raw bytes逐项等于manifest并原子记录新index truth，commit前要求cached exact set和每个blob仍等于`ExpectedCommitManifest`，commit成功后要求新HEAD的唯一parent为旧`workspaceHeadSha`且tree diff逐项等于同一manifest，然后关闭session。HEAD/index/config/同路径bytes在任一命令前被外部切换都返回`RELEASE_GIT_SESSION_IDENTITY_MISMATCH`且本命令mutation为零。带`WorkspaceManifestProof`的native/workspace wrapper必须在child spawn前与整树退出后分别重验完整manifest，任一差异使本次结果失败且后续Git mutation为零；A/P/R在manifest冻结后的每条test/build都必须传proof。`Invoke-CheckedNativeOwned`显式拒绝`git/git-remote-https`，薄包装也必须先拒绝；正式runner内部Git同样先由baseline+manifest proof打开session，`CandidateHead`可空且不得代替workspace HEAD。`Rebind-ReleasePrivateLockUnderLease`、`Assert-ReleaseBootstrapHostIdentity`与`Resolve-ReleaseToolchain`仅是两个根transaction wrapper在旧owner收敛后依次调用的private helper，外层不得提前调用。两个根wrapper都绝不spawn、绝不在调用前持有runner lease/native owner，并拒绝递归或已持lease调用；它们验证actual host mode后执行同一顺序：proof纯校验→取得runner lease→恢复旧native owner→under-lease private-lock rebind→host identity→proof内full toolchain→phase recovery。正式阶段只用`Invoke-ReleaseRunnerInProcess`；Task17A/P/R的单一开发fence只用`Invoke-WithReleaseToolingLease`，后者把resolved toolchain作为callback唯一参数并在callback全程持lease，callback最后一个native owner与Git session均收敛/关闭后才释放，异常也走同一finally并dispose proof，禁止把proof/toolchain/adapter/session带出callback。普通checked native、Git与workspace wrapper同步返回exact `{ExitCode:int,StdoutLines:string[]}`，所有stderr已按稳定规则处理；它们拒绝相对path和unknown logicalName。workspace wrapper只以钉住Node为native target、钉住entrypoint为argv[0]、contained `desktop`为cwd，删除PATH/PATHEXT且不经npm或shell；参数exact allowlist为`vitest: [run,--config,vitest.config.ts]`、`typescript: [-p,tsconfig.node.json,--noEmit]`、`vite: [build]`，其他参数或entrypoint一律失败。每次spawn都重新复核目标/closure，child environment删除父PATH/PATHEXT后只重建toolchain的exact minimal PATH，任何非候选后代执行未钉住文件都失败。普通`Invoke-CheckedNative/Get-CheckedNativeLines`只允许是非Git API的薄包装，绝不能直接使用`&`、`Start-Process`、`Process.Start`或shell command resolution。

所有owned static/GitHub/Git/scanner/verification/candidate child及ProcessHost target只能调用runner-private唯一`New-ReleaseChildEnvironment -ToolKind <git|gh|node|python|bash|powershell|candidate|process-host> -Phase <strict-enum>`；不得先复制父环境再删部分键。builder从空字典开始：Windows base exact allowlist仅为`SystemRoot/WINDIR/TEMP/TMP/USERPROFILE/APPDATA/LOCALAPPDATA/PROGRAMDATA/HOMEDRIVE/HOMEPATH`，macOS仅为`HOME/TMPDIR/USER/LOGNAME/LANG/LC_ALL`，缺失的locale/可选home组件保持缺失；路径值必须无NUL/换行并满足对应OS绝对路径与既有containment/ACL门禁。随后只回填toolchain重建的`PATH`、本计划明确列出的Git config键、CanonicalGitHubSession的`GH_HOST/GH_REPO/GH_TOKEN`、scanner callback的三项真实凭据、四个app role唯一`DOWNANY_DATA_DIR`及目标工具确需的固定非秘密常量；除此之外任何键都禁止。因从空集合构造，`NODE_OPTIONS/NODE_PATH/NODE_EXTRA_CA_CERTS`及全部`NODE_*/NPM_*/npm_*/ELECTRON_*`、全部`PYTHON*`、`BASH_ENV/ENV/SHELLOPTS/BASHOPTS/CDPATH/GLOBIGNORE/PROMPT_COMMAND/ZDOTDIR/KSHENV`、`LD_PRELOAD/LD_LIBRARY_PATH/LD_AUDIT/LIBPATH/SHLIB_PATH`与全部`DYLD_*`、`HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY`的任意大小写、`SSL_CERT_FILE/SSL_CERT_DIR/REQUESTS_CA_BUNDLE/CURL_CA_BUNDLE`、`SSH_AUTH_SOCK/SSH_ASKPASS`以及未逐字授权的`GIT_*/GH_*/GITHUB_*`永远不会进入child。Node只以钉住absolute node启动；Python每次在用户argv前固定插入`-I -B -P -s -E`并拒绝用户重复/覆盖这些flag；bash固定`--noprofile --norc`；任何owned PowerShell child固定`-NoLogo -NoProfile`并显式匹配其Interactive/NonInteractive模式。builder按Windows大小写不敏感、macOS逐字规则拒绝重复键，返回前后都对sorted非秘密key/value与secret-key-name集合、ToolKind/Phase/固定flags计算canonical `environmentPolicySha256`，秘密值不进入preimage/log/owner；spawn前后与ProcessHost resume前必须重算一致。fixture分别把可写sentinel通过`NODE_OPTIONS=--require`、`NODE_PATH`、`PYTHONPATH`+`sitecustomize`、`PYTHONHOME`、`BASH_ENV`、`LD_PRELOAD`、`DYLD_INSERT_LIBRARIES`、`ELECTRON_RUN_AS_NODE`、代理/CA及父`GIT_/GH_/GITHUB_`注入A/P/B/R、token provider、scanner、workspace tool与六个candidate role，要求sentinel执行、secret输出、非owner文件/remote mutation均为零；删掉任一固定Python/bash/PowerShell隔离flag也必须使测试失败。

上句API目录的两个baseline签名以此处完整形式为唯一权威：`Assert-ReleaseRepositoryBaseline -Toolchain <resolved> -ExpectedWorkspaceHead <40-lowercase-hex|null> -RequireNeutralIndexFlags <bool> [-AllowedInitialChangedPaths <string[]>] [-RequiredInitialChangedSha256 <sorted-{path,sha256}[]>]`与`Freeze-ReleaseWorkspaceManifest -Toolchain <resolved> -BaselineProof <baseline-proof> -ExpectedChangedPaths <string[]> [-VersionPreparationProof <version-preparation-proof>]`。baseline proof exact成员相应追加`requiredInitialChangedSha256:<sorted-{path,sha256}[]>`，默认必须为空；只有Task17A tooling fence允许非空，且exact set只能是`scripts/run_telegram_release_acceptance.ps1 → ExpectedRunnerSha256`与`scripts/run_telegram_release_bootstrap.ps1 → ExpectedBootstrapSha256`两项完整仓库相对路径，按path ordinal排序、字段exact、path唯一、SHA为64位lowercase hex，并且两条path都必须属于`AllowedInitialChangedPaths`。baseline不得另开第二次路径读取来核对：必须直接用本次no-follow稳定读取形成的同一`initialChangedManifest`比较path/SHA，最终重读manifest时再次比较；缺失、额外、重复、unknown path、大小写或hash不等都返回`RELEASE_APPROVED_SOURCE_IDENTITY_MISMATCH`，且native/test/build/Git mutation为零。Task17A调用Freeze时还必须用proof内同一required数组重新核对新的`changedManifest`；任一不等同样失败且GitSession创建数为零。

上句API目录另唯一增加`Close-ReleaseGitSession -GitSession <private-session>`。它只在同一runner lease内等待/收敛该session已启动的owned Git child、关闭并清理私有config/handle并使proof不可再用；调用幂等，且不得改变HEAD、candidate/real index、worktree、version marker或remote truth。commit成功走同一close路径；Task17P/17R遇普通异常时必须先关闭非null session，再进入同参Abort。close失败时保留version marker并fail closed。

上句API目录中的Git调用以此处完整签名为唯一权威：`Invoke-CheckedGitOwned -GitSession <private-session> -ArgumentList <string[]> [-CaptureOutput] [-ExpectedCommitManifest <manifest-proof>] [-ExpectedIndexManifest <private-proof>] [-StandardInputBytes <private-byte-array>]`。`StandardInputBytes`不是通用stdin，只允许runner-private helper构造的三个exact case：①`formal_tag_object` session的唯一`mktag`，bytes由当前raw formal marker重建为canonical tag payload的strict UTF-8、无BOM、LF-only、唯一末尾LF；②`evidence` session在`state=evidence_index_attempted/evidence_tree_written/evidence_commit_attempted/evidence_push_attempted`按`evidenceFiles` path bytes排序初次写入或ensure时执行的`hash-object -w --stdin`，bytes必须由helper以no-follow handle从`.build/telegram-evidence-staging/<desktopVersion>/<evidenceFile.path>`读取，读前后stable ID/size/SHA256不变且逐字等于当前raw publication marker planned SHA；③同一`evidence` session在`state=evidence_commit_attempted/evidence_push_attempted`初次写入或ensure时执行唯一`commit-tree <evidenceTreeSha> -p <headSha>`，bytes必须逐字等于marker `commitInputs.message`的strict UTF-8、无BOM、LF-only、唯一末尾LF。adapter在spawn前按session mode、当前raw marker、exact argv与private bytes重算对应Git object SHA；hash-object/commit-tree stdout必须恰为单个40位lowercase SHA并等于重算值。所有其他mode/argv（包括cat-file、read-tree、update-index、write-tree与两种push）参数必须缺省，显式空数组也拒绝；`ExpectedIndexManifest`同样不是通用输出开关：只允许`evidence` session的exact `diff --cached --name-only -z --no-renames <headSha>`与`ls-files --stage -z`，proof由runner-private helper从current raw publication marker、head tree及5个recomputed blob OID生成并绑定当前GitSession。adapter必须直接在private byte buffer中解析NUL path/stage records、拒绝截断/重复/非stage-0/非法mode或非canonical path，与proof逐项比较后返回`StdoutLines=[]`；这两条命令禁止`-CaptureOutput`，raw bytes不得经string/PowerShell转码。其他argv携带该proof或两条命令缺少/错proof都在spawn前失败。三个case的raw bytes只留在helper private buffer，最外层finally覆盖/释放，不进入日志、DTO、owner、marker或receipt。formal helper的`cat-file tag`仍在adapter内部以private raw stdout bytes执行UTF-8严格解码前检查无BOM、无CR、无NUL且逐字等于canonical payload；只有比较成功后才产生普通`StdoutLines`，raw bytes不得离开helper。

同一API目录唯一增加runner-private `Read-ReleaseCandidateTreeManifestOwned -GitSession <private-evidence-session> -PublicationMarkerSha256 <current-raw-sha>`，返回一次性、不可序列化、不可跨session/lease且必须dispose的`CandidateTreeManifestProof`。它只允许current publication处于`evidence_index_attempted/evidence_tree_written/evidence_commit_attempted/evidence_push_attempted/evidence_committed/evidence_ref_conflict/release_publish_attempted/published_verified`且本次session的`CandidateHead`逐字等于marker `headSha`：`evidence_index_attempted`分支要求candidate index与`.lock`都尚不存在并在任何candidate-index mutation之前调用；其余分支要求旧native tree已收敛、lock不存在、candidate index为marker派生位置的regular non-link且本次调用只能读tree/index、不得修改index/ODB/ref。两类分支都只执行唯一`ls-tree -r -z <CandidateHead>`；adapter只在private byte buffer中解析完整NUL记录，要求每项恰为`<mode> SP <type> SP <40-lowercase-oid> TAB <canonical-repo-relative-path> NUL`，拒绝截断、重复path、非blob/tree合法mode、非法UTF-8/path、submodule或unknown object format，并只以该受控`ls-tree`记录确认对象类型，绝不为构造proof追加未列出的Git argv。raw输出及完整manifest不进入`StdoutLines`、日志、DTO、marker或receipt。proof绑定current publication raw SHA、GitSession identity、CandidateHead、repository object format与完整sorted tree manifest；`ExpectedIndexManifest`只能由该proof、同一raw publication marker及5个recomputed blob OID派生，且marker中5项`originalBlobOid:null|40-lowercase-hex`必须逐项等于proof中对应path的原blob OID/缺失真相，否则在任何index读取或mutation前失败。live workspace/current baseline tree、待验证candidate index输出或调用方自报清单都不得作为head tree来源。OID标识的tree不可变，但每次fresh invocation/recovery仍必须重建fresh proof；proof交换、错session/marker/head或dispose后复用均在spawn前失败。

为消除首个publication marker的来源环，同一API目录另有且仅有`Read-ReleasePrepublicationCandidateTreeOwned -Toolchain <resolved> -WorkspaceManifestProof <manifest-proof> -AcceptanceMarkerSha256 <publication-handoff-prepared-raw-sha> -BindingSha256 <current-binding-raw-sha> -EvidencePaths <exact-sorted-5-paths>`，返回一次性、不可序列化、不可跨lease且必须dispose的`PrepublicationCandidateTreeProof`。它只允许`prepare-evidence`在acceptance marker已原子升级并回读为`publication_handoff_prepared`、publication marker/index/lock均尚不存在时调用；先重验acceptance raw SHA、binding/headSha、五个EvidencePaths与已生成planned file exact set，再以同一WorkspaceManifestProof打开`CandidateHead=headSha/PermittedMutationPaths=[]`的private read-only GitSession。native owner固定`operationKind=git/sourceMarkerSha256=<current acceptance raw SHA>`且不设置`GIT_INDEX_FILE`；唯一argv为`ls-tree -r -z <headSha>`，解析、NUL/path/mode/type/object-format规则与上句完全相同，index/ODB/ref/worktree/GitHub mutation均为零。proof只暴露runner-private、按path排序的五项`{path,originalBlobOid:null|40-lowercase-hex}`与绑定identity，不暴露完整tree/raw stdout；写publication marker前必须再次重验acceptance/binding/workspace proof并逐项复制该值，随后立即dispose。generic Git/session、其他phase/state/source marker或调用方自报OID一律spawn前拒绝；强杀后只从仍为`publication_handoff_prepared`的acceptance marker建立fresh proof，绝不持久化或复用旧proof。

`published_verified`只有在尚不存在通过strict schema、remote truth与`sourcePublicationMarkerSha256`校验的永久publication receipt时，才属于上句publication-owned proof分支。一旦该候选的有效receipt原子落盘并回读，receipt就是唯一提交点与cleanup owner；之后无论publication marker仍存在或已缺失，都必须直接进入Step 9 receipt-owned cleanup，禁止再次要求candidate index存在、重建CandidateTree/ExpectedIndex proof或运行任何evidence Git命令。

Task17A的workspace提交不得直接使用上述通用session改写真实index；同一API目录固定增加`Recover-ReleaseToolingCommitOwned -Toolchain <resolved>`与`Invoke-ReleaseToolingCommitOwned -Toolchain <resolved> -WorkspaceManifestProof <manifest-proof> -ExpectedPaths <sorted-string[]> -CommitMessage "build: finalize recoverable telegram release runner"`。Recover返回exact `{SchemaVersion=1,State="not_found"|"rolled_back"|"commit_observed"}`；Invoke只在完整提交与清理均确认后返回`commit_observed`，其他结果一律throw。两者只能在Task17A同一tooling lease内调用；Recover必须先于baseline，Invoke必须在全部test/build通过后调用。generic `Open-ReleaseGitSession`若Task17A五项manifest试图执行add/commit则返回`RELEASE_TOOLING_COMMIT_API_REQUIRED`。

tooling commit固定private root为`.build/telegram-release-tooling-commit/`，exact成员只允许strict `marker.json`、固定`candidate.index`、可选且唯一`candidate.index.lock`、`preimage/real.index`及marker列出的private git-sandbox regular成员。marker状态只允许`inputs_bound/add_attempted/index_staged/commit_attempted/commit_observed/index_sync_attempted/index_synced/cleanup_pending`，并从第一态绑定schemaVersion、toolchainSha256、workspaceHeadSha、`workspaceManifestSha256`（逐字取自不可序列化proof的稳定`manifestSha256`字段）、五项sorted path/size/SHA manifest、上述固定commitInputs及raw SHA、`candidateIndexRelativePath="candidate.index"`、original real-index raw SHA与完整stage-0 manifest；`expectedCommitSha`在index_staged以前必须为null，之后必须为重算的40位SHA。root、marker、index与sandbox逐ancestor拒绝link/reparse，未知字段、额外成员或第三种bytes均`RELEASE_TOOLING_COMMIT_OWNERSHIP_LOST`且零覆盖。

Invoke在任何Git mutation前原子写/回读inputs_bound marker，以owned `read-tree workspaceHeadSha`创建private candidate index；add前写add_attempted，只把五项manifest exact bytes加入candidate index，随后要求cached path/blob exact set、`diff --cached --check`通过且真实index raw/stage仍等于original。owned `write-tree`得到唯一tree后按parent/tree/commitInputs重算expected SHA并写index_staged；commit前写commit_attempted，使用固定workspace commit argv与六个session identity环境。response success/loss或父runner强杀后都先收敛旧Git tree，再只接受HEAD仍为workspaceHead或逐字等于expected commit；前者可从exact index_staged重试，后者验证唯一parent、tree、message、author/committer与commit SHA后提升commit_observed，其他HEAD fail closed。确认commit后才写index_sync_attempted、取得真实`<index>.lock`并把已验证candidate index raw bytesflush→atomic replace到真实index；恢复只接受真实index为original或candidate exact bytes。最终要求HEAD=expected commit、真实index stage-0等于新tree、五项worktree clean、config未变，再写index_synced。

在删除tooling marker/root前，runner必须先原子写入永久ignored receipt `.build/telegram-release-tooling-commit-receipts/<expectedCommitSha>.json`。receipt strict字段为`schemaVersion/toolchainSha256/workspaceHeadSha/workspaceManifestSha256/expectedPaths/commitInputsSha256/commitSha/committedTreeSha/committedStage0ManifestSha256`，不得含绝对路径、PID或自由文本；写后重新解析commit/tree/identity，要求live stage-0 manifest逐项等于commit tree、无unmerged/skip-worktree/assume-unchanged/fsmonitor-valid entry且worktree clean。receipt提交点以后不再比较real index raw SHA，因为合法`git status`/refresh可只改变stat cache；raw SHA仍只在active marker的index同步边界内判定original/candidate/foreign。Recover先收敛旧native/Git tree：receipt文件名命中live HEAD时只在上述strict逻辑真值匹配后返回commit_observed并幂等清残留marker/root；marker存在且HEAD命中expected commit时补齐index同步、receipt与cleanup后返回commit_observed；marker存在且HEAD仍为workspaceHead时只在真实index/config仍等于original、candidate index/lock exact-owned且五项worktree仍等于manifest时guarded删除private index/root并返回rolled_back，绝不恢复或改写用户五项WIP；foreign HEAD/index/config/bytes一律保留marker并fail closed。强杀可发生在marker、add、candidate lock/rename、commit、真实index lock/rename、receipt rename及cleanup每一边界。active tooling marker阻止toolchain重初始化；永久receipt不阻止，且不得由candidate cleanup删除。

Invoke内部的最外层catch/finally必须执行同一Recover真值分支：确认HEAD仍为workspaceHead时先完整rollback private index/marker再重新抛出原add/diff/commit错误；确认expected commit已落地时完成index/receipt/cleanup并返回commit_observed；foreign真值时保留marker并以ownership error覆盖普通错误。测试/build发生在Invoke之前，失败时tooling marker和candidate index创建数必须为零。父进程强杀不运行finally，只由下一次代码块首个Recover继续。

同一API目录再唯一增加`Invoke-ReleaseVersionPreparationOwned -Toolchain <resolved> -Mode <Baseline|Abandoned> -DesktopVersion <strict-semver> [-ExtensionVersion <strict-semver>] [-AbandonedMarkerRelativePath .build/telegram-release-abandoned.json] [-Abort]`；Task17P/R不得以generic Node/native wrapper直接执行版本helper。该API返回一次性、不可序列化、不可跨lease的exact `{SchemaVersion=1,State="workspace_ready"|"commit_observed"|"aborted",ExpectedPaths=<sorted-string[]>,WorkspaceManifestProof=<private-proof|null>,PreparationProof=<private-proof|null>}`；`workspace_ready`时两个proof全非null，`commit_observed/aborted`时全null。相应地，`Open-ReleaseGitSession`的完整签名取代上句缩写为`Open-ReleaseGitSession -Toolchain <resolved> -WorkspaceManifestProof <manifest-proof> [-VersionPreparationProof <version-preparation-proof>] -CandidateHead <40-lowercase-hex|null> -PermittedMutationPaths <string[]> [-CommitMessage <exact-utf8>]`：Task17A不传version proof，Task17P/R必须传同一PreparationProof；只有三个A/P/R workspace commit session传CommitMessage，值只能分别为代码块中的三个固定message。带该proof的commit在mutation前把事务落为`commit_attempted`；响应成功或丢失后都只以新HEAD唯一parent、exact path/blob manifest、固定message、固定author/committer identity和重算commit SHA确认`commit_observed`，确认前不得第二次commit或清理事务。

所有带CommitMessage的workspace GitSession都在打开时由已验证`workspaceHeadSha`的commit object取得唯一非负十进制committer timestamp，并确定性生成exact `commitInputs={authorName:"Downany Release Automation",authorEmail:"downany-release-automation@users.noreply.github.com",authorDate:"@<parent-committer-unix-seconds> +0000",committerName:"Downany Release Automation",committerEmail:"downany-release-automation@users.noreply.github.com",committerDate:"@<parent-committer-unix-seconds> +0000",message:<CommitMessage>}`；字段集合、顺序、UTF-8/LF message bytes与canonical raw SHA固定，不读Git config、OS用户名、时钟或父环境。Task17A把同一object/raw SHA写入独立tooling marker，Task17P/R在任何workspace replace前写入version marker并由对应private proof绑定。`git commit` argv中的`-m`值必须逐字等于session.message；adapter只在该workspace commit child中回填六个对应`GIT_AUTHOR_*`/`GIT_COMMITTER_*`，禁止其他身份来源。给定parent、tree与inputs必须预先重算expected commit SHA；response loss后observed commit除parent/tree/message外还要逐字段匹配identity与该SHA。

version marker的commit identity以此处为完整定义：不得只存message，必须保存上述exact `commitInputs`、其canonical raw SHA与预先重算的expected commit SHA，并由PreparationProof逐字段绑定；Baseline模式在首次marker写入前固定选择`chore: prepare telegram release version`，Abandoned模式固定选择`chore: prepare next telegram release candidate`，后续Open session传入值必须逐字相等。marker strict parser拒绝旧的message-only形状、缺失/额外identity字段或从环境/config补值。commit payload的message bytes严格为`UTF8(CommitMessage)+单个LF`，workspace commit argv固定为`commit --no-verify --no-gpg-sign --cleanup=verbatim -m <CommitMessage>`，不允许其他cleanup/editor/signing来源。后文Git adapter环境段中的“commit-tree 再从已持久化 commitInputs回填六个变量”以本段为完整覆盖：evidence `commit-tree`读取publication marker inputs，A/P/R workspace `commit`读取GitSession绑定inputs；任何其他Git命令都不得回填这六个identity变量。formal annotated-tag object的tagger identity已经是下文`mktag` canonical stdin payload的一部分，绝不能再由Git环境或config补入。

version marker从`inputs_bound`起必须已有commitInputs及其raw SHA；`expectedCommitSha`在`index_staged`以前必须为null。candidate index完成exact add并由owned `write-tree`得到唯一tree后，runner先按parent/tree/commitInputs重算40位expected SHA并原子写回`index_staged` marker；只有非null且重算一致时才可进入`commit_attempted`。Task17A使用上文独立tooling marker执行同一null→40位SHA边界，不得只依赖进程内session。

P/R确认commit、真实index同步与clean worktree后，在删除version marker/root前必须原子写永久ignored `.build/telegram-release-version-preparation-receipts/<expectedCommitSha>.json`。strict字段为`schemaVersion/mode/toolchainSha256/workspaceHeadSha/requestedDesktopVersion/requestedExtensionVersion/abandonedMarkerSha256/expectedPaths/commitInputsSha256/commitSha/committedTreeSha/committedStage0ManifestSha256`，各模式nullness与原marker相同，不含路径、PID或自由文本。每次Invoke在创建新marker或跑baseline前，先按live HEAD文件名查receipt；只有调用参数、commit parent/tree/identity、requested version files、stage-0 logical manifest与clean worktree全部逐字匹配才返回commit_observed，raw index stat-cache变化不影响。receipt写入/回读、marker cleanup与API return各边界强杀都必须幂等；不同参数或foreign receipt零删除且不得冒充成功。active version marker阻止toolchain reinit，永久version receipt不阻止且不由candidate cleanup删除。

Git adapter环境段中的`GIT_INDEX_FILE`规则以此处为完整mode allowlist：`evidence`只从当前publication marker派生`evidenceIndexRelativePath`，`tooling_commit`只从当前tooling marker派生固定`candidateIndexRelativePath`，`version_preparation`只从当前version marker派生固定`candidateIndexRelativePath`；三类都必须由同一runner lease、当前raw-owner marker SHA与contained regular non-link path共同授权，每个Git child spawn前后重验且禁止跨mode/path复用。real/status/cleanup不得设置，baseline只能设置固定runner-private baseline index，其他mode出现`GIT_INDEX_FILE`一律失败。父进程任何大小写形式的`GIT_INDEX_FILE`始终先删除，绝不作为三类值来源。fixture对三类两两交换marker/path并污染父变量，要求child mutation为零，且tooling/version commit真值确认前真实index raw/stage始终不变。

GitSession内部必须持有不可由调用者伪造的exact mode：tooling API只能创建`tooling_commit`，带VersionPreparationProof的Open只能创建`version_preparation`，`Read-ReleasePrepublicationCandidateTreeOwned`只能在最终`publication_handoff_prepared` acceptance raw SHA下创建`prepublication_candidate_tree`，publication marker下的evidence API只能创建`evidence`，formal marker下的annotated-tag object API只能创建不设置candidate index的`formal_tag_object`，同一formal marker下的remote tag API只能在state=`tag_push_attempted`时创建不设置candidate index的`formal_tag_push`，baseline实现只能创建`baseline`；普通公开参数不得接收任意mode字符串。`prepublication_candidate_tree`固定`ExpectedWorkspaceHead=WorkspaceManifestProof.workspaceHeadSha`、`CandidateHead=binding.headSha`、`PermittedMutationPaths=[]`、`sourceMarkerSha256=<current acceptance raw SHA>`，不设置`GIT_INDEX_FILE`、credential或identity env，exact argv只有adapter-private NUL parser消费的`ls-tree -r -z <CandidateHead>`；任何其他命令、mode/session/source交换都在spawn前失败。`Invoke-CheckedGitOwned`每次从session mode与对应marker proof重新派生环境，不能靠argv猜测。

版本准备是runner-owned小事务，固定private root为`.build/telegram-release-version-preparation/`。在永久runner lease内、旧native owner收敛后、任何GitHub child或版本文件写入前，API创建并回读`marker.json`；该root逐ancestor拒绝link/reparse，exact成员只能是marker、`input/`、`output/`、`preimage/`、`helper/`、`github-config/`、固定`candidate.index`、可选且唯一`candidate.index.lock`及marker所列regular-file manifest。marker状态只允许`inputs_bound/remote_verified/outputs_ready/apply_pending/workspace_ready/add_attempted/index_staged/commit_attempted/commit_observed/abort_requested/rollback_pending/cleanup_pending`，并绑定schemaVersion、mode、workspaceHeadSha、`toolchainSha256`、requested versions、helper closure/input/preimage/output/remote-proof raw SHA、expected paths、上文exact `commitInputs`及其canonical raw SHA、`candidateIndexRelativePath="candidate.index"`、`originalRealIndexSha256`、完整sorted `originalStage0Manifest:<{mode,oid,path}[]>`与state；`preimage/`还保存该raw SHA对应的exact real-index bytes。不含Token、绝对路径、PID或自由文本。每个目标只允许等于exact preimage或exact output，第三种bytes返回`VERSION_PREPARATION_OWNERSHIP_LOST`且零覆盖。强杀后先收敛native/GitHub/Git整树；随后必须要求当前private-lock raw SHA逐字等于marker.toolchainSha256，漂移时只保留已完成的旧树收敛并返回`RELEASE_TOOLCHAIN_IDENTITY_MISMATCH`，不得读写marker/index/worktree。身份相同时，部分replace按同一marker幂等补齐output，参数变化返回`VERSION_PREPARATION_ARGUMENT_MISMATCH`且零清理。Task17P/R的GitSession从workspaceHead以owned `read-tree`创建上述private index，所有add/diff/commit只设置这个candidate `GIT_INDEX_FILE`；在commit真值确认前，真实index raw bytes与stage-0 manifest必须始终逐字等于original baseline。marker/staging只在native owner、GitHub child、GitSession都为空且事务已commit_observed或已完整回滚时删除；任一后续invocation在普通baseline前先恢复该固定事务，所以部分版本写入或candidate index lock不会被误判为无owner污染。

API先用其内部唯一baseline session证明真实index等于HEAD、工作树干净且neutral flags成立，再从该HEAD读取并绑定`prepare_telegram_release_versions.mjs`及递归import closure raw bytes；工作树对应文件必须由同一no-follow读取逐字匹配。它同样绑定desktop package/lock、extension manifest，以及Abandoned模式的strict abandoned marker raw SHA。runner把已验证helper closure与输入bytes复制到private staging，flush、原子rename并回读manifest；Node只执行该已验证副本、只读`input/`、只写`output/`，绝不按workspace helper路径执行或直接修改工作树。runner验证完整输出后先持久化preimage/output manifest，再逐文件temp→flush→atomic replace并回读，最后由同一API内部Freeze产生返回的WorkspaceManifestProof。generic `Invoke-CheckedNativeOwned`遇到Node argv指向workspace或staging中的该helper一律返回`RELEASE_VERSION_PREPARATION_API_REQUIRED`。

带VersionPreparationProof的GitSession在`git add`前与commit mutation前都必须重新建立短生命周期CanonicalGitHubSession，逐字复核repository metadata、requested desktopVersion以及tag/release/evidence ref仍全部不存在，并把新的remote proof raw SHA原子写回version marker。add mutation前先原子写`add_attempted`；若add child失败、响应丢失或父runner强杀，恢复在旧Git树为空后只接受三种private truth：candidate index缺失或stage-0仍等于workspaceHead时重建后重试；stage-0除expected paths命中output manifest外逐项等于workspaceHead、无unmerged/foreign entry且real index仍等于original时原子补写`index_staged`；唯一candidate lock存在时只在marker/path containment匹配且其他sibling为零后删除该私有lock，再从workspaceHead重建candidate index并重放add。其他index/lock/config真值全部返回`VERSION_PREPARATION_OWNERSHIP_LOST`且零删除/覆盖。add后remote变为已使用时commit为零，只删除marker拥有且已收敛的candidate index/lock、guarded恢复worktree preimage并重跑clean baseline；真实index从未改变。commit前原子写`commit_attempted`；响应丢失时，HEAD仍为workspaceHead则从exact index_staged重试，HEAD变化则只接受唯一parent=workspaceHead、固定message与tree diff/blob exact等于output manifest的一个新commit。确认新commit后、删除candidate lock且旧Git树为空，才取得真实`<index>.lock`并把已验证candidate index raw bytes以flush→atomic replace同步成真实index；强杀恢复只接受真实index为original或candidate exact bytes，前者补同步、后者补记`commit_observed`，第三种bytes/foreign lock一律fail closed。最终必须验证HEAD=new commit、真实index stage-0等于新tree、worktree clean且original config未变，随后才清marker/root。该二次查询同样不得把Token交给Node、Git argv、marker或日志。

`-Abort`不是无条件删除逃生口，只允许在同一runner lease内携带与marker逐字相同的Mode、DesktopVersion、可选ExtensionVersion及Abandoned marker身份调用。它先按普通恢复顺序收敛旧native/GitHub/Git整树并读取Git真值，再在任何cleanup mutation前原子写入`abort_requested`。若marker已到`commit_attempted`，必须先判定提交真值：HEAD命中唯一parent、固定message与exact output tree时完成真实index同步、提升`commit_observed`并返回该状态，禁止回滚；HEAD仍等于workspaceHead时才可继续Abort；其他HEAD、真实index、config、owner或路径真值全部返回`VERSION_PREPARATION_OWNERSHIP_LOST`，保留marker且零覆盖。合法Abort还必须证明真实index raw bytes与stage-0 manifest仍逐字等于original、candidate index/lock仅为marker拥有的base或exact output、工作树每个目标只等于preimage或output，且GitSession与全部child tree为空。

通过上述门禁后，runner先guarded删除candidate index与exact lock，再原子写`rollback_pending`；随后只从marker绑定的preimage逐文件执行temp→flush→atomic replace并回读，第三种bytes或foreign变化始终fail closed。全部目标恢复后重新运行clean baseline，要求HEAD、真实index raw SHA/stage-0、config与工作树逐字等于事务原baseline，才删除private root并返回`aborted`。API自身在尚未返回`workspace_ready`前遇到同步普通异常时，最外层finally必须在同一lease内执行这条安全Abort；父进程强杀只保留marker供下次调用恢复。API已返回后，Task17P/17R的test、build、diff、add或commit任一非强杀异常必须在catch中用完全相同参数调用`-Abort`；Abort若发现提交已落地则返回`commit_observed`并视为成功，否则必须返回`aborted`后才重新抛出原异常。`commit_observed`后再次Abort只幂等返回`commit_observed`，绝不删除已提交版本。Abort任一边界再次强杀都由同一marker状态与磁盘真值继续；清理失败不得清marker、覆盖foreign bytes或允许toolchain初始化。

候选native不是通用动态执行逃生口。每个`record-windows|record-macos -Mode generate`在任何候选进程前，必须在candidate-specific staging写入并回读`candidate-native-bindings.json`；该文件由当前acceptance marker raw SHA拥有，unknown role/path/field或其他阶段调用均返回`CANDIDATE_NATIVE_FORBIDDEN`且spawn=0。strict DTO固定为：

~~~json
{
  "schemaVersion": 1,
  "state": "artifact_bound",
  "sourceAcceptanceMarkerSha256": "64-lowercase-hex",
  "inputManifestSha256": "64-lowercase-hex",
  "platform": "windows-x64",
  "artifactSha256": "64-lowercase-hex",
  "packageTreeManifestSha256": null,
  "bindings": [
    {
      "role": "windows_installer",
      "rootKind": "acceptance_input",
      "relativePath": "Downany-1.2.3-win-x64.exe",
      "size": 1,
      "sha256": "64-lowercase-hex",
      "stableFileId": "platform-canonical-file-id",
      "argvPolicy": "nsis-silent-unicode-space-v1",
      "executionCopy": null
    }
  ]
}
~~~

`artifact_bound`只允许一项：Windows为input manifest中唯一windows installer，macOS没有可执行artifact、先用static trusted `hdiutil`挂载DMG后进入下一态。每个binding元素字段exact为`role/rootKind/relativePath/size/sha256/stableFileId/argvPolicy/executionCopy`；除下述已预制的Windows uninstaller外`executionCopy`必须为null。installer必须是acceptance input containment内regular non-link、name/size/SHA逐字等于input manifest；Windows argv精确为`/S`与最后一项`/D=<本候选unicode+space install root>`。安装/挂载后先完成Task15 package verifier、package-aware scanner并得到同artifact SHA的tree manifest，才可原子替换为`state="package_bound"`：Windows bindings exact set为`windows_app/windows_app_interactive/windows_installer/windows_uninstaller`，macOS exact set为`macos_app/macos_app_interactive`；所有app与uninstaller的rootKind只允许`verified_package_root`，同平台smoke/interactive两个app binding必须指向同一产品入口且size/SHA/stable ID逐字相等，uninstaller relativePath固定为包内卸载器，`packageTreeManifestSha256`必须等于scanner receipt。smoke app的argvPolicy固定`package-smoke-v1`且argv精确`--downany-package-smoke`；interactive app的argvPolicy固定`interactive-ui-v1`且argv精确为空数组，必须创建正常产品窗口并使用本候选隔离的真实用户数据目录。Windows uninstaller在任何spawn前，由runner以no-follow、无share-write/delete句柄重新验证installed uninstaller，再在本候选唯一空contained temp root内用exclusive create写随机临时副本、flush-to-disk、回读size/SHA、原子rename到固定`Uninstall Downany.exe`并以no-follow句柄取得stable ID；随后把该binding的`executionCopy`从null单向原子改为exact `{rootKind:"candidate_uninstall_temp",relativePath:"Uninstall Downany.exe",size,sha256,stableFileId,argvPolicy:"nsis-prebound-uninstall-v1"}`并回读raw SHA。响应丢失时只接受same bytes/identity幂等继续；任何不同副本、额外sibling、link/reparse或非空temp root都失败。六个角色以外的candidate role/argv/path一律失败。

四个app role的`DOWNANY_DATA_DIR`不得继承或由操作者指定，runner必须按`candidateIdentitySha256/role`唯一派生`.build/telegram-release-candidates/<candidateIdentitySha256>/runtime/<role>`的private regular non-link containment，创建后复核macOS 0700或Windows当前用户SID+SYSTEM exact ACL，并只在候选app child的受控环境中加入该绝对值；smoke与interactive各自使用不同空root。其他candidate role禁止该键。路径本身不进入公共report/evidence/log；private native owner只保存下述candidate-relative引用。

`Invoke-CheckedCandidateNativeOwned`要求runner lease、active record-generate phase、binding raw owner与input/artifact/package receipt全部仍匹配；它用no-follow handle打开目标、重算size/SHA/stable ID并把binding raw SHA纳入target identity，再走同一个ProcessHost/owner状态机。候选进程树的root必须是绑定目标；Windows installer仅允许其已验证artifact派生、且位于本候选temp/install containment的后代，四个app role的每个非系统后代必须命中verified package tree manifest，系统后代必须命中private lock trusted-directory manifest。interactive role全程持有runner lease与native owner，Token只允许用户直接键入Renderer并由产品safeStorage保存，不得通过runner参数、环境、stdin或日志传递；操作者完成四类目标与失败/重试矩阵后用产品正常“退出”动作结束，runner等待全部受控树为空并设置有界人工会话deadline，关窗但后台仍活或超时都先收敛全部树再失败。`windows_uninstaller`不运行installed original，也不允许运行后再观察动态self-copy：它的root target必须是binding内已预制且逐项复核的`executionCopy`，argv精确为`/S`及最后且唯一的`_?=<verified install root>`，`_?=`值不额外加引号且无其他参数；该形式让NSIS直接在已验证副本内卸载而不再自复制。副本在launch intent前已经命中binding raw SHA/stable ID，故错误/第二副本在用户代码执行前失败。Windows继续由outer kill-on-close Job覆盖nested Job后代；普通macOS static candidate只有outer PGID，两个macOS app role则明确拥有outer app PGID及Task7两份v5 owner state指向的Sidecar、Telegram inner PGID，绝不声称三者属于同一PGID。全部受控树为空且安装根已删除后，才guarded删除binding拥有的副本、确认temp root为空并删除目录。candidate binding文件在QA report原子落盘且所有候选树为空后才删；强杀由acceptance marker+binding raw SHA恢复，禁止把它升级成private toolchain或复用于另一candidate。

所有能访问 GitHub 的 `operationKind="github"` child（钉住的gh、钉住的GitHub API helper及其后代）使用独立 `CanonicalGitHubSession`，不能复用普通继承环境。session先按Windows大小写不敏感、macOS逐字规则删除父环境中**全部**以`GH_`或`GITHUB_`开头的键，包括`GH_HOST/GH_REPO/GH_CONFIG_DIR/GH_TOKEN/GITHUB_TOKEN/GH_ENTERPRISE_TOKEN/GITHUB_API_URL/GITHUB_SERVER_URL`，再把hostname固定为字面`github.com`、repository固定为strict marker/binding中的`owner/repo`；版本准备阶段唯一允许的repository为已验证canonical remote `JackEngineer/downany`。取令牌的唯一入口是owned、无日志、以toolchain中gh绝对路径执行的`gh auth token --hostname github.com`：它在已删除父重定向变量的环境中读取OS标准默认gh配置位置，绝不接受父`GH_CONFIG_DIR`，stdout只进入受保护内存lease。其余GitHub child使用candidate-owned、empty、regular non-link `GH_CONFIG_DIR`，并且环境中只回填`GH_HOST=github.com`、`GH_REPO=<exact owner/repo>`与该lease的`GH_TOKEN`；不回填任何`GITHUB_*`或enterprise/API URL override。每条gh命令仍以同一绝对路径显式传`--hostname github.com`以及`--repo <owner/repo>`或`repos/<owner>/<repo>`endpoint，helper直连时API base固定`https://api.github.com`。首次读取、每次远端mutation前后都查询repository metadata并要求正整数`id`、`full_name`逐字等于owner/repo、`html_url=https://github.com/<owner>/<repo>`且REST `url=https://api.github.com/repos/<owner>/<repo>`；任一redirect/config/host/repo差异零mutation。empty config目录分别位于formal preflight或publication candidate staging，由对应marker/receipt按既有guarded cleanup拥有；token、Authorization header与provider输出不得进入argv、native owner、marker、receipt或日志，整棵child tree退出后的finally清零lease。

上一段CanonicalGitHubSession的“不能复用普通继承环境”由唯一minimal-env builder收窄：token provider与所有GitHub child都从`ToolKind=gh`空基线开始，只能增加本段列出的`GH_HOST/GH_REPO/GH_CONFIG_DIR/GH_TOKEN`；父`GH_/GITHUB_`、proxy/CA、Node/Python/shell/loader注入键均不存在，`gh auth token`仅用builder已验证的OS home/config基线定位标准gh配置。spawn前后`environmentPolicySha256`不等、任一额外键或repository metadata差异都在GitHub读取/mutation前失败。

版本准备是上段empty GitHub config目录所有权的唯一第三种情况：目录只能位于`.build/telegram-release-version-preparation/github-config/`并由同一version-preparation marker raw SHA拥有，Node启动前GitHub child与credential lease必须已收敛且该目录已guarded删除。版本准备的GitHub查询只产出上文无秘密`RemoteVersionAvailabilityProof`；Node只能由唯一minimal-env builder以`ToolKind=node`构造全新环境，禁止把CanonicalGitHubSession、Token、GH/GITHUB、proxy/CA、`NODE_*`或任意父环境传入，也禁止版本helper自行发网。父进程污染的GH/GITHUB/repository/API/config/proxy/Node/loader变量、foreign repository metadata、token获取或remote读取失败、GitHub child强杀均必须使Node spawn、workspace write、Git add/commit和foreign mutation为零，并在恢复后清空credential lease/config/native tree。

永久abandoned watch是empty GitHub config目录所有权的唯一第四种情况，不能借用已经清理的formal preflight、publication staging或version root。fixed runtime root由watch的desktopVersion/headSha确定性派生为`.build/telegram-abandoned-watch-runtime/v<desktopVersion>-<headSha>/`，exact成员只允许按调用顺序互斥出现的`github-config-query/`或`github-config-mutation/`一个empty、regular non-link目录；query目录只供authenticated分页读取canonical tag、matching runs与Release集合，mutation目录只供对当前watch绑定的matching workflow run做cancel并轮询到terminal，任何一组GitHub child整树退出且credential lease清零后都必须guarded删除，随后才可按`query→mutation→query`重建下一组fresh session。watch运行期Git tag/ref、Release与asset mutation调用数永久为零，不建立Git baseline/manifest或GitSession。每次创建、使用、恢复与删除都必须在调用方根runner lease内绑定当前permanent watch raw SHA、candidate identity及native-operation owner，逐ancestor拒绝link/reparse并复核macOS 0700或Windows当前SID+SYSTEM exact ACL；watch raw SHA漂移、extra sibling、两个目录并存、live旧tree或owner不匹配一律零删除/零GitHub mutation并fail closed。父runner hard-kill后下一invocation先从durable native owner收敛旧GitHub整树，再仅在permanent watch raw SHA仍等于owner preimage时清理对应exact目录并重建fresh session；runtime root为空后才删除，permanent watch永不删除。`state=resolved`的watch必须先原子退回并回读`watching`才可调用任何GitHub query或run cancellation；`watching`本身就是可重入的durable attempt state。fixture必须在candidate/preflight/publication staging全不存在时完成late-run cancellation/quarantine验证，并覆盖query/cancel/query各强杀边界、link/extra/双目录/raw-SHA漂移，失败时permanent watch、canonical tag、quarantine draft与foreign remote真值零改写。

上文minimal-env builder列出的账户路径不是“可从父环境复制”的值。runner-private `Resolve-CanonicalOsAccountProfile`必须只从当前进程OS安全主体取得一次性内存proof：Windows以当前access token的SID配合Known Folder API解析`UserProfile/RoamingAppData/LocalAppData`，macOS以`geteuid()+getpwuid_r`解析当前UID与home；返回值必须为绝对canonical路径、无NUL/换行，逐ancestor拒绝link/reparse并验证Windows当前SID+SYSTEM ACL或macOS当前UID所有且不可被group/world写。builder的`USERPROFILE/APPDATA/LOCALAPPDATA/HOMEDRIVE/HOMEPATH`或`HOME/USER/LOGNAME`只能从该proof确定性产生，父进程同名键及`XDG_CONFIG_HOME`一律忽略。token provider是唯一可访问操作者长期gh配置的child：它显式设置`GH_CONFIG_DIR`为Windows `<canonical RoamingAppData>/GitHub CLI`或macOS `<canonical home>/.config/gh`，spawn前以no-follow handle/fd验证该目录及实际读取的config/hosts regular成员仍归当前主体、无越界/link/reparse且ACL/mode合格；缺失只允许稳定认证失败，绝不回退父环境、其他home或搜索路径。其他GitHub child仍只使用phase-owned empty `GH_CONFIG_DIR`。前文任何“清掉父GH_CONFIG_DIR后依赖父HOME/AppData默认发现”的解释均由本段替代。fixture把`HOME/USERPROFILE/APPDATA/LOCALAPPDATA/XDG_CONFIG_HOME/GH_CONFIG_DIR`逐项指向含foreign host/token与执行sentinel的目录，要求token provider只访问OS主体规范root，foreign读取、sentinel、secret输出与远端mutation均为零；规范root身份/ACL/link漂移同样在取Token前失败。

上句API目录唯一追加`Invoke-ReleaseSecretScannerOwned -Toolchain <resolved> -Scope <repository|staged> -ExpectedWorkspaceHead <40-lowercase-hex> -ScannerArguments <string[]> [-WorkspaceManifestProof <manifest-proof>]`；generic native wrapper不得把Repository/StagedOnly直接传给scanner，也不得允许scanner自行解析Git。该API只允许下列三个exact phase/scope/source组合，任一其他phase、scope、marker state或source owner在spawn前拒绝：①`secret-audit`的`Scope=repository`只由`state=prepare_tag`的formal marker持有，`sourceMarkerSha256`等于该formal marker raw SHA；②`prepare-evidence`的`Scope=repository`只由`state in {ready_to_prepare_evidence,publication_handoff_prepared}`的acceptance marker持有，`sourceMarkerSha256`必须等于当次current acceptance raw SHA；③`commit-evidence`的`Scope=staged`只由`state=evidence_index_attempted`的publication marker持有，`sourceMarkerSha256`等于该publication marker raw SHA。组合②两态都必须重验同一binding/ledger/workspace/canonical staging identity；handoff态只允许强杀恢复所需的Repository rescan，随后进入同一prepublication proof/successor写入，绝不得把marker回退ready、改写其既有字段或进入其他phase。该API在已持runner lease、旧native owner已收敛、上述唯一source marker raw SHA仍匹配时，先用非null ExpectedWorkspaceHead完成同一repository baseline/manifest门禁，再创建固定`.build/telegram-release-secret-scanner-git/`：exact成员只允许零字节regular non-link`global.config`与空`hooks/`，逐ancestor/ACL/mode规则、强杀恢复及unknown sibling处理与baseline sandbox相同，root由该唯一source marker raw SHA+runner lease+native owner共同持有。它只从唯一minimal-env builder构造scanner共享process-tree env并追加`GIT_CONFIG_NOSYSTEM=1`、该empty global config、empty hooks、`GIT_NO_REPLACE_OBJECTS=1/GIT_OPTIONAL_LOCKS=0/GIT_TERMINAL_PROMPT=0`及后文Git exact config overrides；父`GIT_*/GH_*/GITHUB_*`与PATH仍不存在。spawn前先用同一隔离环境、钉住绝对Git复核effective local/worktree config逐项命中后文exact allowlist；scanner参数由API强制追加同一绝对`-GitExecutable`和ExpectedWorkspaceHead，用户不得覆盖。`repository`严禁`GIT_INDEX_FILE`；`staged`只能从当前publication marker派生并回读其唯一candidate index，且scanner结束前后index raw SHA/stage manifest必须不变。ProcessHost整树的descendant allowlist只为本调用放行同一钉住Git及上文五类exact只读argv，stable ID/SHA/argv/env任一漂移都先终止整树并使receipt/后续Git mutation为零。API结束必须先确认scanner/Git/guardian/bridge整树为空、credential lease已清零，再guarded删除sandbox；hard-kill由native owner+source marker raw SHA恢复，额外成员或owner漂移零删除并fail closed。此模式是前文“所有Git都经GitSession”和“scanner走Invoke-CheckedNativeOwned”的唯一窄只读例外：它没有通用GitSession或mutation能力，但复用同一minimal env/config identity门禁。`secret-audit`与`prepare-evidence`的Repository scope及`commit-evidence`的StagedOnly scope都必须只经本API；Path/ExpandZip/package-only scanner不启动Git且继续走普通owned scanner target。fixture覆盖三个exact source组合（含prepare-evidence两种state）、所有跨phase/scope/state替换、replace-ref、fake PATH/Git、危险config、candidate-index替换、scanner/Git各强杀边界和二进制blob，要求真实HEAD/index bytes命中、sentinel/secret输出/receipt/tag/Release/evidence mutation为零。

scanner Git环境按本段替代上文任何“scanner与Git共享process-tree env”的措辞。runner在launching intent前同时构造两份不可变环境：scanner根`processTreeEnvironmentPolicySha256`允许三项真实credential key，独立`scannerGitEnvironmentPolicySha256`从空基线按`ToolKind=git/Phase=secret_scanner_readonly`构造，只含OS规范base、钉住Git PATH/closure与该owned sandbox的只读Git变量，三项真实credential key/value以及所有其他scanner-only键都必须不存在。scanner不接收第二条env通道：它从已验证`-GitExecutable`、固定workspace root、固定scanner sandbox、上文`Resolve-CanonicalOsAccountProfile`与计划内只读Git常量确定性重建同一credential-free环境；这些输入都已由CLI/owner/containment校验，最终hash必须逐字等于`-GitEnvironmentPolicySha256`，因此不新增Task7协议、fd、环境变量、磁盘配置或任意输入路径。scanner入口第一步把三项真实值复制到仅当前进程的private byte/string buffer，随后逐项删除process environment并回读不存在；失败时Git spawn=0。之后scanner每次Git spawn都从空`ProcessStartInfo.Environment`填入重建出的exact Git env并再次重算hash，绝不调用默认继承；Git settle后再用内存凭据扫描已取得的raw path/blob/worktree bytes，最外层finally覆盖/释放buffer。前文“scanner credential lease期间不得启动其他native child”只增加这一项窄例外：仅允许钉住的absolute Git、exact只读argv、credential-free env且仍在同一个ProcessHost owned tree内，任何其他child保持禁止。native owner的`scannerGitEnvironmentPolicySha256`仅当`operationKind="scanner"`且scope含Repository或StagedOnly时必须是64位lowercase hex；其他所有operation/scanner scope必须为null，并从launching到cleanup不可改变。恢复时旧树只按持久owner先收敛；新scanner spawn前重新构造两份policy并逐字匹配两个owner字段，凭据值仍不进入hash/owner。fixture在scanner根三项环境存在时让Git child输出其环境key集合到private sentinel，要求三项credential及编码值全部不存在；另覆盖policy hash/env-key篡改、Git强杀与父runner强杀，均先归零整树且零secret输出/receipt/远端mutation。

`Invoke-ReleaseSecretScannerOwned`在`Scope=staged`时必须把同一raw publication marker派生并验证的candidate index canonical absolute path作为唯一`-GitIndexPath`传给scanner，并把该path纳入scannerGit policy hash；`Scope=repository`禁止该参数且禁止`GIT_INDEX_FILE`。scanner deterministic rebuild的输入集合相应只在staged增加这一项已验证private argv，不能自行枚举`.build`、读取另一marker或采用真实index。恢复仍先按owner.sourceMarkerSha256定位原publication marker并重验path/marker/index真值，缺失或漂移只收敛旧树后fail closed，不猜测新path。

唯一private operation owner为`.build/telegram-release-native-operation.json`；它是计划唯一可保存本机PID的runner-private文件，永不进入stdout/stderr/evidence/report/receipt/Renderer。strict DTO固定为：

~~~json
{
  "schemaVersion": 1,
  "state": "launching",
  "operationId": "32-lowercase-hex",
  "operationKind": "git",
  "candidateIdentitySha256": "64-lowercase-hex",
  "sourceMarkerSha256": null,
  "toolchainSha256": "64-lowercase-hex",
  "bridgeEnvironmentPolicySha256": "64-lowercase-hex",
  "processTreeEnvironmentPolicySha256": "64-lowercase-hex",
  "scannerGitEnvironmentPolicySha256": null,
  "candidateBindingSha256": null,
  "targetExecutableSha256": "64-lowercase-hex",
  "bridgeIdentitySha256": "64-lowercase-hex",
  "guardianIdentitySha256": "64-lowercase-hex",
  "targetIdentitySha256": "64-lowercase-hex",
  "bridgePid": null,
  "bridgeStartedAt": null,
  "guardianPid": null,
  "guardianStartedAt": null,
  "targetPid": null,
  "targetStartedAt": null,
  "containmentKind": null,
  "processGroupId": null,
  "nestedProcessTrees": null
}
~~~

`state`只允许`launching/quarantined/running/exit_observed/cleanup_pending`；`operationKind`只允许`git/github/scanner/verification/candidate`。`candidateBindingSha256`始终存在：静态operation必须为null，candidate必须是当前`candidate-native-bindings.json` raw bytes的64位lowercase hex。`bridgeEnvironmentPolicySha256`逐字取Node bridge的唯一minimal-env builder结果；`processTreeEnvironmentPolicySha256`逐字取本次业务target所需minimal-env builder结果，并按Task7现有`spawnContainedProcess(... options.env)`合同作为ProcessHost guardian与其suspended target共享的同一套env。两个字段始终全有、允许彼此不同，并从launching到cleanup任何状态都不得改变；不得虚构Task7不存在的第二条target-env通道。静态target identity散列compact UTF-8 `{canonicalExecutable,executableSha256,stableFileId,args,cwd,toolchainSha256,processTreeEnvironmentPolicySha256}`；candidate target identity改为散列`{role,rootKind,relativePath,size,executableSha256,stableFileId,args,candidateBindingSha256,toolchainSha256,processTreeEnvironmentPolicySha256}`，其中windows_uninstaller的rootKind/relativePath/size/SHA/stable ID全部取自非null executionCopy；不得持久本机absolute path。bridge identity必须包含其钉住Node/bridge文件SHA、stable ID与`bridgeEnvironmentPolicySha256`；guardian与target identity都必须包含各自钉住文件SHA、stable ID与同一个`processTreeEnvironmentPolicySha256`，但两类identity仍分别散列且不得借用bridge hash。candidate app role的`DOWNANY_DATA_DIR`属于这套共享process-tree env，ProcessHost只转交、不读取、不记录；credential值只能进受保护child environment，禁止进入argv、identity或owner。candidate identity散列`{repository,headSha,desktopVersion}`，尚无候选时后两项显式null；active phase存在时`sourceMarkerSha256`必须等于其raw SHA。PID为规范正十进制字符串、startedAt为UTC。`nestedProcessTrees`除两个macOS app role外必须为null；这两个role从launching intent起固定为exact `{state:"active"|"confirmed_empty",candidateDataRootRelativePath:"runtime/<role>",sidecarOwnerStateRelativePath:"telegram/sidecar-owner-state.json",telegramOwnerStateRelativePath:"telegram/owner-state.json",sidecar:NestedTreeSlot,telegram:NestedTreeSlot}`，其中`NestedTreeSlot` exact为`{state:"unobserved"|"observed"|"confirmed_empty"|"confirmed_empty_without_inner",snapshot:null|NestedTreeSnapshot}`。三个relative path都禁止`..`/斜杠变体并与candidate identity派生root共同解析，绝不保存绝对路径；初值固定总`active`且两个slot均`{state:"unobserved",snapshot:null}`。任一合法inner owner state出现时只把对应slot原子改为`observed`并写snapshot；该tree按真值收敛后只把该slot改为`confirmed_empty`并保留最后snapshot。正常exitCode=0允许无snapshot slot直接改`confirmed_empty`；异常退出只有逐slot never-spawned证明可把仍null的该slot改为`confirmed_empty_without_inner`。两个slot都处于`confirmed_empty|confirmed_empty_without_inner`且outer已空时，才可原子把总state从`active`改为`confirmed_empty`。`NestedTreeSnapshot` exact为`{ownerStateSha256,guardian:{pid,startedAt,imageIdentitySha256},targetGroup:{processGroupId,target:{pid,startedAt,imageIdentitySha256},members:[{pid,startedAt,imageIdentitySha256}]}}`；members只表示target PGID，按数值PID再startedAt排序、PID均为正十进制字符串、processGroupId为正十进制且target与所有members逐项属于该PGID，target必须包含在members，guardian必须不在members且单独按其startedAt/image identity验证。runner每次读到合法v5 inner owner state后，先按Task7 identity规则分别核对guardian与target PGID的OS真值，再把其raw SHA与去路径/argv后的上述snapshot原子写回private owner；新成员没有先持久化snapshot时不得发signal或宣布tree为空。字段始终全有且拒绝额外字段。

spawn固定为：用唯一minimal-env builder构造Node bridge环境和业务process-tree共享环境，计算两个独立policy hash→把两个hash与全PID null的launching intent一并原子写/read-back→启动无业务副作用bridge（argv仅protocol version+operationId）→内存launch DTO携带共享process-tree env→静态operation以no-follow handle/fd打开并复核toolchain目标，candidate operation则先回读active phase与binding raw SHA、从受控root+relativePath解析唯一目标并逐字段复核artifact/package manifest→在bridge spawn前重算bridge policy，在guardian spawn前、目标resume前及整树退出后重算共享process-tree policy并逐字匹配owner→bridge以同operationId作为ProcessHost instanceId和**已验证绝对目标路径**调用Task7既有单一`options.env`启动guardian及suspended target→runner从OS重读实际image的startedAt、canonical executable、SHA/stable ID、command、parent与Job/PGID并逐字匹配owner以及对应toolchain/binding/environment identity→写/read-back quarantined identity→唯一resume→写running。恢复或重试只能按owner内两个持久hash分别重建bridge env与共享process-tree env；任一缺失、互换或漂移都在对应spawn/resume前失败。共享env中的`DOWNANY_DATA_DIR`或其他业务键只供guardian原样转交，guardian不得读取、展开、记录或输出。Windows target须先进入`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` outer Job并验证nested Job后代仍受outer Job约束；macOS root target只进入outer独立PGID。macOS app resume后，runner持续以candidate派生root内两份固定v5 owner state为唯一inner ownership source：逐ancestor拒绝link、复核0600/containment/strict schema，以Task7相同startedAt/executable/command/guardian/target/member规则对OS真值验身，并在每次成员变化后先更新/回读该inner state再继续；Sidecar和Telegram各自PGID不得等于outer PGID或彼此相等。resume前target用户代码=0，路径替换/TOCTOU或任一对应environment policy漂移失败零resume。bridge control关闭或runner identity消失时，bridge关闭fd3并退出，ProcessHost先使outer app无法再次spawn/restart；随后runner/下一次recover按两份owner state收敛仍存inner PGID，并分别确认inner state已由Task7在整树空后删除。普通ProcessHost只在自身树空后退出；macOS app完成还必须两份inner state均不存在且三组OS成员全空，runner才写exit_observed并删owner。非零退出也先完成同样收敛再抛错。finally需终止时写cleanup_pending，关闭bridge control；static/installer/uninstaller使用10秒总deadline，四个app role使用与产品退出合同一致的30秒单调总deadline，依次确认outer target不可再spawn、所有inner tree为空、outer Job/PGID为空。无法确认或inner state丢失但仍有按已验证identity匹配的进程则保留owner并返回`NATIVE_OPERATION_RECOVERY_REQUIRED`，不得继续其他mutation。fixture必须断言bridge与process-tree的ToolKind/flags/env可以产生不同hash，bridge identity只接受bridge hash，guardian/target identity只接受共享process-tree hash，并覆盖两项互换、单项恢复漂移、candidate app共享env包含`DOWNANY_DATA_DIR`但bridge env保持不变，以及Task7没有第二条target-env通道仍能完整运行。

取得runner lease后的第一项恢复永远是native owner，早于abandoned-watch/publication/acceptance/formal和当前toolchain解析。launching且PID全null时按operationId枚举0或1个candidate：0=未spawn，1=按owner中已持久SHA/identity核验后收敛，多于1 fail closed。PID已复用且startedAt/identity不同只证明旧进程消失，绝不终止新进程；仍匹配的bridge/guardian/target须整树收敛。candidate operation的恢复路径由`candidateIdentitySha256/sourceMarkerSha256`唯一派生candidate staging和binding路径；存在时raw SHA必须等于`candidateBindingSha256`，缺失/不同仍先只凭owner内持久进程身份收敛旧树，树空后保留active phase并返回`CANDIDATE_NATIVE_BINDING_LOST`，不得猜测、重建或启动下一候选。windows_uninstaller owner的target identity直接绑定executionCopy；恢复时同一Job中0个匹配target只表示副本进程已退出，1个则随树收敛，任何不同identity或额外副本都只终止本owner整树。复制阶段在owner创建前强杀时，下一invocation先按binding truth收敛：executionCopy为null只guarded删除本候选临时文件并重做复制；非null则只接受same bytes/stable ID，缺失且安装根仍存在时可从重新验证的original幂等重建same binding，缺失且安装根已删除只进入post-uninstall验证，任何不同bytes/identity fail closed。旧树确认空后才删除owner并解析当前private lock；temp cleanup只按当前binding exact executionCopy进行，绝不枚举删除其他文件。当前候选已冻结且toolchain hash不同则返回`RELEASE_TOOLCHAIN_IDENTITY_MISMATCH`，不得创建下一operation。现有每个`*_attempted`仍必须先写phase marker，再写native launching intent。

macOS app operation恢复不能只看outer root/PGID：即使outer target已经退出，也必须由`nestedProcessTrees`重新定位candidate data root，并分别收敛sidecar/telegram两个slot。`observed`或带snapshot的slot对仍存在的owner state做Task7 v5 identity验证并收敛；若文件已经安全删除，则用最后snapshot逐项确认旧identity均不存活后改`confirmed_empty`。`exitCode=0`的已验证package-smoke或产品正常退出可在确认对应文件不存在后，把仍unobserved/null的每个slot独立改`confirmed_empty`。hard-kill/超时/非零/未知退出对每个`unobserved + snapshot=null + 对应文件不存在`的slot独立走never-spawned证明：先关闭bridge并逐身份确认outer guardian/target/PGID全空，以“outer确认空的单调时刻+Task7固定5秒launching窗口”为not-before；到时后用与Task7相同OS inspector仅针对该slot的包内ProcessHost与Sidecar或Telegram executable、candidate data root、受控workDir和command containment连续两次枚举，结果必须精确为0且两次间该owner-state仍未出现；随后在同一runner lease内重验outer仍空、该文件仍不存在并原子写/read-back该slot的`confirmed_empty_without_inner`。另一个slot无论处于observed或terminal都不阻止该证明，也不能替代它。任一次出现候选、文件、outer复活、枚举错误或身份歧义都保留owner并fail closed。两个slot分别terminal后才提升总`confirmed_empty`；outer owner、两个inner owner-state与candidate root的删除顺序必须幂等。任何身份不符只停止并保留证据，不得按PID猜测终止。report、binding cleanup、credential lease清理和下一candidate spawn都以总state=`confirmed_empty`且三树OS真值归零为前置。

runner 内唯一 credential API 固定为：

~~~powershell
Invoke-WithTelegramCredentialLease `
  -Purpose 'scanner' `
  -Callback $CredentialCallback
~~~

provider 逐项用 `Read-Host -AsSecureString` 取得 Bot Token、API ID、API hash，明文只在当前短生命周期 callback 的进程内存存在。`scanner` callback 才可在 inner try/finally 临时设置三项 child environment并只启动 Task 13 的共享 scanner；`bot-proof` callback 不设置环境、不启动 native child，只能在同进程做 Bot API probe、getMe account ID校验和 HMAC alias 计算，并仅返回安全 alias/pass DTO。真实安装包 Token 由验收者直接输入应用 UI，不经过 runner argv/env/file。每个 callback finally 清零 BSTR/byte buffer和引用，outer finally再次删除三项环境变量；从父 shell 继承任一凭据时先删除 child 副本，再以 `PARENT_CREDENTIAL_ENV_FORBIDDEN` 无回显失败。

- [ ] **Step 3: 实现独立版本准备 helper**

`prepare_telegram_release_versions.mjs` 只接受runner内部协议，操作者与Task17P/R不得直接调用：

~~~text
--runner-protocol-v1 --mode <baseline|abandoned> \
  --desktop <strict-semver> [--extension <strict-semver>]
~~~

两个模式互斥；baseline允许省略extension并逐字保留，abandoned必须显式提供两项。Node helper不联网、不读取workspace、不读取普通`process.env`中的host/repo/token/config/API URL或proxy override，也不接受任意输入/输出路径；它只能由钉住absolute Node通过唯一minimal-env builder启动，spawn前后要求`ToolKind=node/Phase=version_preparation`的`environmentPolicySha256`不变，`NODE_OPTIONS/NODE_PATH/NODE_EXTRA_CA_CERTS`及全部未授权键不存在。cwd固定为版本事务root，输入只能来自已验证`input/`，输出只能写新建的`output/`。stdin必须是runner通过专用`CanonicalGitHubSession`取得并canonical化的无秘密`RemoteVersionAvailabilityProof`，exact字段为`schemaVersion/repository/repositoryId/desktopVersion/tagExists/releaseExists/evidenceRefExists`；repository逐字为`JackEngineer/downany`、repositoryId为正decimal string、desktopVersion等于argv，三个布尔值都必须为false。runner先用钉住gh和固定github.com/repository读取并验证该proof，随后关闭GitHub child、清零Token lease，再启动Node；Node环境、argv、stdin、owner与marker均不得含Token或GitHub重定向变量。abandoned模式的strict marker由runner复制到input并要求repository相同。helper只根据输入副本与remote proof确定性生成planned bytes，不直接替换工作树；package-lock顶层与`packages[""]`必须等于desktop，extension独立。helper不删除abandoned/watch、不创建tag、workflow、Git ref或Release；实际workspace replace、强杀恢复与commit确认全部由上文版本事务负责。

- [ ] **Step 4: 以单一 fail-fast block 跑测试并提交 tooling**

~~~powershell
param(
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedBootstrapSha256,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedRunnerSha256,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedPrivateLockSha256,
    [Parameter(Mandatory)][string]$ExpectedWorkspaceRoot
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$PlatformName = if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) { 'windows-x64' } else { 'macos-arm64' }
$CanonicalWorkspaceRoot = [IO.Path]::GetFullPath($ExpectedWorkspaceRoot)
$BootstrapPath = [IO.Path]::GetFullPath([IO.Path]::Combine($CanonicalWorkspaceRoot, 'scripts', 'run_telegram_release_bootstrap.ps1'))
$BootstrapBytes = [IO.File]::ReadAllBytes($BootstrapPath)
$Hasher = [Security.Cryptography.SHA256]::Create()
try { $BootstrapActualSha256 = ([BitConverter]::ToString($Hasher.ComputeHash($BootstrapBytes))).Replace('-', '').ToLowerInvariant() } finally { $Hasher.Dispose() }
if ($BootstrapActualSha256 -cne $ExpectedBootstrapSha256) { throw 'RELEASE_BOOTSTRAP_IDENTITY_MISMATCH' }
if (($BootstrapBytes.Length -ge 3 -and $BootstrapBytes[0] -eq 0xEF -and $BootstrapBytes[1] -eq 0xBB -and $BootstrapBytes[2] -eq 0xBF) -or ($BootstrapBytes -contains [byte]0)) { throw 'RELEASE_BOOTSTRAP_ENCODING_INVALID' }
$StrictUtf8 = New-Object Text.UTF8Encoding($false, $true)
$BootstrapScriptBlock = [ScriptBlock]::Create($StrictUtf8.GetString($BootstrapBytes))
. $BootstrapScriptBlock
$BootstrapProof = Open-ApprovedReleaseBootstrap -ExpectedWorkspaceRoot $CanonicalWorkspaceRoot -PlatformName $PlatformName -BootstrapSha256 $BootstrapActualSha256 -ExpectedRunnerSha256 $ExpectedRunnerSha256 -ExpectedPrivateLockSha256 $ExpectedPrivateLockSha256
. $BootstrapProof.RunnerScriptBlock -BootstrapProof $BootstrapProof
Invoke-WithReleaseToolingLease -BootstrapProof $BootstrapProof -ExpectedHostMode Interactive -Callback {
param($Toolchain)
$WorkspaceManifestProof = $null

function Invoke-CheckedNative {
    param([string]$LogicalName, [string[]]$ArgumentList)
    if ($LogicalName -eq 'git' -or $LogicalName -eq 'git-remote-https') { throw 'Git requires an owned Git session' }
    $Result = Invoke-CheckedNativeOwned -Toolchain $Toolchain -LogicalName $LogicalName -ArgumentList $ArgumentList -WorkspaceManifestProof $WorkspaceManifestProof
    if ($Result.ExitCode -ne 0) { throw "$LogicalName failed with exit code $($Result.ExitCode)" }
}
function Get-CheckedNativeLines {
    param([string]$LogicalName, [string[]]$ArgumentList)
    if ($LogicalName -eq 'git' -or $LogicalName -eq 'git-remote-https') { throw 'Git requires an owned Git session' }
    $Result = Invoke-CheckedNativeOwned -Toolchain $Toolchain -LogicalName $LogicalName -ArgumentList $ArgumentList -WorkspaceManifestProof $WorkspaceManifestProof -CaptureOutput
    if ($Result.ExitCode -ne 0) { throw "$LogicalName failed with exit code $($Result.ExitCode)" }
    return @($Result.StdoutLines)
}
function Assert-ExactPathSet {
    param([string[]]$Actual, [string[]]$Expected)
    $ActualText = (@($Actual | Sort-Object -CaseSensitive) -join "`n")
    $ExpectedText = (@($Expected | Sort-Object -CaseSensitive) -join "`n")
    if ($ActualText -cne $ExpectedText) { throw 'exact path set mismatch' }
}

$ExpectedStaged = @(
    'scripts/prepare_telegram_release_versions.mjs',
    'scripts/run_telegram_release_acceptance.ps1',
    'scripts/run_telegram_release_bootstrap.ps1',
    'scripts/tests/telegramReleaseAcceptance.test.mjs',
    'scripts/tests/telegramReleaseVersions.test.mjs'
)
$ToolingRecovery = Recover-ReleaseToolingCommitOwned -Toolchain $Toolchain
if ($ToolingRecovery.State -ceq 'commit_observed') { return }
if ($ToolingRecovery.State -cne 'not_found' -and $ToolingRecovery.State -cne 'rolled_back') {
    throw 'tooling commit recovery state is invalid'
}
$RequiredApprovedSourceSha256 = @(
    [pscustomobject]@{
        path = 'scripts/run_telegram_release_acceptance.ps1'
        sha256 = [string]$ExpectedRunnerSha256
    },
    [pscustomobject]@{
        path = 'scripts/run_telegram_release_bootstrap.ps1'
        sha256 = [string]$ExpectedBootstrapSha256
    }
)
$BaselineProof = Assert-ReleaseRepositoryBaseline `
    -Toolchain $Toolchain `
    -ExpectedWorkspaceHead $null `
    -RequireNeutralIndexFlags $true `
    -AllowedInitialChangedPaths $ExpectedStaged `
    -RequiredInitialChangedSha256 $RequiredApprovedSourceSha256
$WorkspaceManifestProof = Freeze-ReleaseWorkspaceManifest -Toolchain $Toolchain -BaselineProof $BaselineProof -ExpectedChangedPaths $ExpectedStaged

$IsWindowsHost = [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT
$ProcessHostPath = (Get-ReleaseProcessHost -Toolchain $Toolchain).CanonicalPath
if ($IsWindowsHost) {
    Invoke-CheckedNative 'python' @('scripts/test_process_host.py', '--executable', $ProcessHostPath, '--platform', 'win32')
} else {
    Invoke-CheckedNative 'python' @('scripts/test_process_host.py', '--executable', $ProcessHostPath, '--platform', 'darwin')
}

Invoke-CheckedNative 'node' @('--test', 'scripts/tests/telegramReleaseAcceptance.test.mjs')
Invoke-CheckedNative 'node' @('--test', 'scripts/tests/telegramReleaseVersions.test.mjs')
Invoke-CheckedNative 'node' @('--test', 'scripts/tests/telegramPackaging.test.mjs')
Invoke-CheckedNative 'python' @('-m', 'pytest', 'tests/core', 'tests/data', 'tests/sidecar', 'tests/cli', '-q')
$DesktopTest = Invoke-WorkspaceNodeToolOwned -Toolchain $Toolchain -LogicalName 'vitest' -ArgumentList @('run', '--config', 'vitest.config.ts') -WorkspaceManifestProof $WorkspaceManifestProof
if ($DesktopTest.ExitCode -ne 0) { throw "vitest failed with exit code $($DesktopTest.ExitCode)" }
$DesktopTypes = Invoke-WorkspaceNodeToolOwned -Toolchain $Toolchain -LogicalName 'typescript' -ArgumentList @('-p', 'tsconfig.node.json', '--noEmit') -WorkspaceManifestProof $WorkspaceManifestProof
if ($DesktopTypes.ExitCode -ne 0) { throw "typescript failed with exit code $($DesktopTypes.ExitCode)" }
$DesktopBuild = Invoke-WorkspaceNodeToolOwned -Toolchain $Toolchain -LogicalName 'vite' -ArgumentList @('build') -WorkspaceManifestProof $WorkspaceManifestProof
if ($DesktopBuild.ExitCode -ne 0) { throw "vite failed with exit code $($DesktopBuild.ExitCode)" }
Invoke-CheckedNative 'node' @('browser-extension/shared.test.js')
Invoke-CheckedNative 'node' @('browser-extension/sniff-core.test.js')

$ToolingCommit = Invoke-ReleaseToolingCommitOwned `
    -Toolchain $Toolchain `
    -WorkspaceManifestProof $WorkspaceManifestProof `
    -ExpectedPaths $ExpectedStaged `
    -CommitMessage 'build: finalize recoverable telegram release runner'
if ($ToolingCommit.State -cne 'commit_observed') { throw 'tooling commit did not settle' }
}
~~~

Task 17A、17P、17R 的每个 PowerShell fence必须自包含，不得依赖上一 fence 的变量或function；每块先逐字执行上文固定的bootstrap加载前言，以显式workspace root+工作区外批准的bootstrap/runner/private-lock三个hash得到proof，只dot-source proof内已验证runner scriptblock，再由runner从proof bytes解析private lock。每条 native 命令都必须由上述 checked wrapper立即验证 exit code；测试、build、Git读取、diff-check或commit任一失败都必须在下一条有副作用命令前 throw。`git diff --cached --name-only` 必须与 expected set做机器级 ordinal比较，不能只打印供人工查看。代码块中的`git/node/python/powershell/bash`只允许是logicalName，wrapper不得把字符串原样交给OS；pytest固定为钉住Python的`-m pytest`，desktop test/build固定为钉住Node直接执行三个已锁workspace entrypoint，不允许npm、shell、CMake或编译器后代。ProcessHost必须在进入Task 17前由Task 14构建/验证并写入private lock，Task17A只复核锁定身份并运行parent-death smoke，不在受控runner内重建。Expected: 全部 PASS并创建唯一 tooling commit；测试结束没有 runner marker、临时 index、凭据环境或后台进程。

Task17A成功后唯一允许新增的ignored持久物是上文strict tooling-commit receipt；active marker、candidate index/lock、private sandbox与native owner必须全部消失。再次执行同一fence时，Recover必须先由receipt验证当前HEAD并直接返回，不得因为五项工作树已clean而误报baseline失败或创建第二个commit。

- [ ] **Step 5: 先合入默认分支**

上一步 staged exact set 必须只有上述五项且 commit 已成功。随后使用 `superpowers:finishing-a-development-branch` 完成 review/merge/push；Task 17B 只能从 authenticated default branch执行。执行前重新 `git fetch origin --prune`，用 `gh repo view --json defaultBranchRef` 取得默认分支，要求 tooling commit 是 `origin/<default>` ancestor、当前 HEAD 精确等于该 remote head、index/worktree（忽略 `.build`）为空；还要从 HEAD blob重算 bootstrap/runner/test/helper SHA并与上一步通过测试的 bytes一致。任一不满足均停止，不得创建 tag 或 Release。

---

### Task 17P: 准备首个未使用的正式版本

当前仓库 desktop/package.json 与 lockfile 为 `0.1.0`，远端已经存在 `v0.1.0`；因此本任务在第一次 Task 17B 前必须执行。后续只有当前 desktop版本的 tag、Release 与 evidence ref全部不存在时才可跳过。

**Files:**
- Modify: `desktop/package.json`
- Modify: `desktop/package-lock.json`
- Modify（仅扩展自身也要发新版本时）: `browser-extension/manifest.json`
- Read only: `scripts/run_telegram_release_bootstrap.ps1`
- Read only: `scripts/run_telegram_release_acceptance.ps1`
- Read only: `scripts/prepare_telegram_release_versions.mjs`
- Read only: `scripts/tests/telegramReleaseVersions.test.mjs`

- [ ] **Step 1: 由单一 fail-fast block 生成、测试并提交未使用版本**

~~~powershell
param(
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedBootstrapSha256,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedRunnerSha256,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedPrivateLockSha256,
    [Parameter(Mandatory)][string]$ExpectedWorkspaceRoot
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$PlatformName = if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) { 'windows-x64' } else { 'macos-arm64' }
$CanonicalWorkspaceRoot = [IO.Path]::GetFullPath($ExpectedWorkspaceRoot)
$BootstrapPath = [IO.Path]::GetFullPath([IO.Path]::Combine($CanonicalWorkspaceRoot, 'scripts', 'run_telegram_release_bootstrap.ps1'))
$BootstrapBytes = [IO.File]::ReadAllBytes($BootstrapPath)
$Hasher = [Security.Cryptography.SHA256]::Create()
try { $BootstrapActualSha256 = ([BitConverter]::ToString($Hasher.ComputeHash($BootstrapBytes))).Replace('-', '').ToLowerInvariant() } finally { $Hasher.Dispose() }
if ($BootstrapActualSha256 -cne $ExpectedBootstrapSha256) { throw 'RELEASE_BOOTSTRAP_IDENTITY_MISMATCH' }
if (($BootstrapBytes.Length -ge 3 -and $BootstrapBytes[0] -eq 0xEF -and $BootstrapBytes[1] -eq 0xBB -and $BootstrapBytes[2] -eq 0xBF) -or ($BootstrapBytes -contains [byte]0)) { throw 'RELEASE_BOOTSTRAP_ENCODING_INVALID' }
$StrictUtf8 = New-Object Text.UTF8Encoding($false, $true)
$BootstrapScriptBlock = [ScriptBlock]::Create($StrictUtf8.GetString($BootstrapBytes))
. $BootstrapScriptBlock
$BootstrapProof = Open-ApprovedReleaseBootstrap -ExpectedWorkspaceRoot $CanonicalWorkspaceRoot -PlatformName $PlatformName -BootstrapSha256 $BootstrapActualSha256 -ExpectedRunnerSha256 $ExpectedRunnerSha256 -ExpectedPrivateLockSha256 $ExpectedPrivateLockSha256
. $BootstrapProof.RunnerScriptBlock -BootstrapProof $BootstrapProof
Invoke-WithReleaseToolingLease -BootstrapProof $BootstrapProof -ExpectedHostMode Interactive -Callback {
param($Toolchain)
$WorkspaceManifestProof = $null

function Invoke-CheckedNative {
    param([string]$LogicalName, [string[]]$ArgumentList)
    if ($LogicalName -eq 'git' -or $LogicalName -eq 'git-remote-https') { throw 'Git requires an owned Git session' }
    if ($null -eq $WorkspaceManifestProof) {
        $Result = Invoke-CheckedNativeOwned -Toolchain $Toolchain -LogicalName $LogicalName -ArgumentList $ArgumentList
    } else {
        $Result = Invoke-CheckedNativeOwned -Toolchain $Toolchain -LogicalName $LogicalName -ArgumentList $ArgumentList -WorkspaceManifestProof $WorkspaceManifestProof
    }
    if ($Result.ExitCode -ne 0) { throw "$LogicalName failed with exit code $($Result.ExitCode)" }
}
function Get-CheckedNativeLines {
    param([string]$LogicalName, [string[]]$ArgumentList)
    if ($LogicalName -eq 'git' -or $LogicalName -eq 'git-remote-https') { throw 'Git requires an owned Git session' }
    if ($null -eq $WorkspaceManifestProof) {
        $Result = Invoke-CheckedNativeOwned -Toolchain $Toolchain -LogicalName $LogicalName -ArgumentList $ArgumentList -CaptureOutput
    } else {
        $Result = Invoke-CheckedNativeOwned -Toolchain $Toolchain -LogicalName $LogicalName -ArgumentList $ArgumentList -WorkspaceManifestProof $WorkspaceManifestProof -CaptureOutput
    }
    if ($Result.ExitCode -ne 0) { throw "$LogicalName failed with exit code $($Result.ExitCode)" }
    return @($Result.StdoutLines)
}
function Assert-ExactPathSet {
    param([string[]]$Actual, [string[]]$Expected)
    $ActualText = (@($Actual | Sort-Object -CaseSensitive) -join "`n")
    $ExpectedText = (@($Expected | Sort-Object -CaseSensitive) -join "`n")
    if ($ActualText -cne $ExpectedText) { throw 'exact path set mismatch' }
}

$StrictSemVer = '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
$NewDesktopVersion = ([string](Read-Host 'New desktop version (MAJOR.MINOR.PATCH, without v)')).Trim()
if ($NewDesktopVersion -notmatch $StrictSemVer) { throw 'New desktop version must be strict MAJOR.MINOR.PATCH semver' }
$NewExtensionVersion = ([string](Read-Host 'New extension version (blank keeps the current extension version)')).Trim()
if ($NewExtensionVersion.Length -gt 0 -and $NewExtensionVersion -notmatch $StrictSemVer) {
    throw 'New extension version must be blank or strict MAJOR.MINOR.PATCH semver'
}

$ExpectedStaged = @('desktop/package-lock.json', 'desktop/package.json')
$PreparationArgs = @{
    Toolchain = $Toolchain
    Mode = 'Baseline'
    DesktopVersion = [string]$NewDesktopVersion
}
if ($NewExtensionVersion.Length -gt 0) {
    $ExpectedStaged += 'browser-extension/manifest.json'
    $PreparationArgs.ExtensionVersion = [string]$NewExtensionVersion
}
function Invoke-CheckedGit {
    param([string[]]$ArgumentList, $ExpectedCommitManifest = $null)
    if ($null -ne $ExpectedCommitManifest) {
        $Result = Invoke-CheckedGitOwned -GitSession $GitSession -ArgumentList $ArgumentList -ExpectedCommitManifest $ExpectedCommitManifest
    } else {
        $Result = Invoke-CheckedGitOwned -GitSession $GitSession -ArgumentList $ArgumentList
    }
    if ($Result.ExitCode -ne 0) { throw "git failed with exit code $($Result.ExitCode)" }
}
function Get-CheckedGitLines {
    param([string[]]$ArgumentList)
    $Result = Invoke-CheckedGitOwned -GitSession $GitSession -ArgumentList $ArgumentList -CaptureOutput
    if ($Result.ExitCode -ne 0) { throw "git failed with exit code $($Result.ExitCode)" }
    return @($Result.StdoutLines)
}
$Preparation = $null
$GitSession = $null
try {
    $Preparation = Invoke-ReleaseVersionPreparationOwned @PreparationArgs
    if ($Preparation.State -ceq 'commit_observed') { return }
    if ($Preparation.State -cne 'workspace_ready') { throw 'version preparation state is invalid' }
    Assert-ExactPathSet @($Preparation.ExpectedPaths) $ExpectedStaged
    $WorkspaceManifestProof = $Preparation.WorkspaceManifestProof
    $GitSession = Open-ReleaseGitSession -Toolchain $Toolchain -WorkspaceManifestProof $WorkspaceManifestProof -VersionPreparationProof $Preparation.PreparationProof -CandidateHead $null -PermittedMutationPaths $ExpectedStaged -CommitMessage 'chore: prepare telegram release version'
    $ActualChanged = @(Get-CheckedGitLines @('diff', '--name-only'))
    Assert-ExactPathSet $ActualChanged $ExpectedStaged
    Invoke-CheckedNative 'node' @('--test', 'scripts/tests/telegramReleaseVersions.test.mjs')
    $DesktopTest = Invoke-WorkspaceNodeToolOwned -Toolchain $Toolchain -LogicalName 'vitest' -ArgumentList @('run', '--config', 'vitest.config.ts') -WorkspaceManifestProof $WorkspaceManifestProof
    if ($DesktopTest.ExitCode -ne 0) { throw "vitest failed with exit code $($DesktopTest.ExitCode)" }
    $DesktopTypes = Invoke-WorkspaceNodeToolOwned -Toolchain $Toolchain -LogicalName 'typescript' -ArgumentList @('-p', 'tsconfig.node.json', '--noEmit') -WorkspaceManifestProof $WorkspaceManifestProof
    if ($DesktopTypes.ExitCode -ne 0) { throw "typescript failed with exit code $($DesktopTypes.ExitCode)" }
    $DesktopBuild = Invoke-WorkspaceNodeToolOwned -Toolchain $Toolchain -LogicalName 'vite' -ArgumentList @('build') -WorkspaceManifestProof $WorkspaceManifestProof
    if ($DesktopBuild.ExitCode -ne 0) { throw "vite failed with exit code $($DesktopBuild.ExitCode)" }
    Invoke-CheckedNative 'node' @('browser-extension/shared.test.js')
    Invoke-CheckedGit (@('add', '--') + $ExpectedStaged)
    $ActualStaged = @(Get-CheckedGitLines @('diff', '--cached', '--name-only'))
    Assert-ExactPathSet $ActualStaged $ExpectedStaged
    Invoke-CheckedGit @('diff', '--cached', '--check')
    Invoke-CheckedGit @('commit', '--no-verify', '--no-gpg-sign', '--cleanup=verbatim', '-m', 'chore: prepare telegram release version') -ExpectedCommitManifest $WorkspaceManifestProof
} catch {
    $Failure = $_
    if ($null -ne $GitSession) {
        Close-ReleaseGitSession -GitSession $GitSession
        $GitSession = $null
    }
    if ($null -ne $Preparation -and $Preparation.State -ceq 'workspace_ready') {
        $AbortArgs = $PreparationArgs.Clone()
        $AbortArgs['Abort'] = $true
        $AbortResult = Invoke-ReleaseVersionPreparationOwned @AbortArgs
        if ($AbortResult.State -ceq 'commit_observed') { return }
        if ($AbortResult.State -cne 'aborted') { throw 'version preparation abort did not settle' }
    }
    throw $Failure
}
}
~~~

desktop必须严格大于当前文件版本并且远端 `v<version>` tag/Release、`refs/tags/downany-evidence/v<version>`均不存在；默认不改extension。只有扩展自身内容/版本也要变化时才显式追加 `--extension <new-extension-semver>`，它只需严格大于当前extension值，不与desktop强绑。输出后diff exact set为package+lock两项，或显式带extension时三项。

- [ ] **Step 2: 合入默认分支**

使用 `superpowers:finishing-a-development-branch` 合并并推送 authenticated default branch；重新fetch后要求HEAD精确等于remote default，再进入Task 17B。此任务不创建tag、workflow run、Release或evidence ref。

---

### Task 17B: 自动化回归、秘密审计与双平台真实 Bot 验收

**Files:**
- Read only: `scripts/run_telegram_release_bootstrap.ps1`
- Read only: `scripts/run_telegram_release_acceptance.ps1`
- Read only: `scripts/prepare_telegram_release_versions.mjs`
- Read only: `scripts/tests/telegramReleaseAcceptance.test.mjs`
- Read only: `.github/workflows/release-packages.yml`
- Generate through temporary Git index only: `docs/REGRESSION-2026-08.md`
- Generate through temporary Git index only: `docs/REGRESSION-2026-08.json`
- Generate through temporary Git index only: `docs/REGRESSION-2026-08-windows.json`
- Generate through temporary Git index only: `docs/REGRESSION-2026-08-macos.json`
- Generate through temporary Git index only: `docs/REGRESSION-2026-08-manual.json`

- [ ] **Step 1: 复核最终 runner、marker、跨机摄取与强杀恢复门禁**

Task 17A 已提交的 tests 必须用注入 adapter 覆盖全部阶段、Windows PowerShell 5.1 和可用的 PowerShell 7；本任务先从冻结 HEAD 重跑，不得修改测试来适配现场。正式 runner 的公开参数精确为：

~~~text
-Step recover|freeze|automation|secret-audit|formal-run|
      record-windows|record-macos|record-manual|prepare-evidence|
      commit-evidence|publish
-Mode generate|ingest
-AcceptanceInput <directory>
-Abort formal|acceptance|publication
~~~

Mode 与 AcceptanceInput 只允许三个 record-* 阶段且必须同时出现；Abort 只允许 Step=recover，三个值互斥。未知参数、重复阶段、错误组合或跳阶段必须在runner lock文件打开/创建及任何其他mutation前失败。通过纯参数校验后，每个invocation先取得全程OS独占runner lease；除该永久基础设施lease外，首个transaction动作是native operation recovery，再执行无凭据phase recovery。存在未收敛native owner或active phase marker时禁止新tag、版本递增、Release、ledger、index或evidence mutation。

失败测试必须包含：跳过automation、跳过secret-audit、receipt错head/workflow/blob/scope或额外字段、receipt写后/marker链接后强杀、tag push response loss、late workflow run、run attempt 2、draft API response loss、formal→acceptance→publication 每次 marker handoff 前后强杀、ready ledger写后/acceptance marker写前强杀、canonical record写后/ledger写前强杀、return目录删除后prepare、publication 每态、commit-tree/push/PATCH response loss、远端 evidence ref 冲突、默认分支在 QA 期间前进、跨 run/release report、report 字段删除/额外字段、同 bytes 重复 ingest、不同 bytes 冲突，以及任何失败后 stdout/stderr/marker 均无真实或 fixture 凭据。所有 native command fixture还要把每一条依次设为非零，证明下一条mutation调用数为零。

- [ ] **Step 2: 固定凭据边界与唯一命令形式**

recover、freeze、automation、formal-run、commit-evidence、publish 永不调用 credential provider，可在 NonInteractive 下执行。secret-audit、三个 record-* 与 prepare-evidence 必须交互获取 Telegram credential lease，命令禁止 NonInteractive。scanner lease 只在共享 scanner 的最小 inner try/finally 中临时放入三项 child environment，期间不得启动其他 native child；bot-proof lease 不设置环境且只做同进程 Bot probe/HMAC alias。每个 invocation 的最外层 finally 无条件、无回显删除三项环境变量并清零临时内存。若入口从父 shell 继承任一真实凭据，先清 child 副本，再以 PARENT_CREDENTIAL_ENV_FORBIDDEN 失败，绝不读取或输出值。

正式运行前每台机器只允许从操作者已用绝对路径启动并核验的PowerShell host，以工作区外`ExpectedBootstrapSha256`加载已批准bootstrap bytes，再由bootstrap和外部`ExpectedRunnerSha256`加载已验证runner scriptblock并调用`Initialize-ReleaseToolchain`；其exact参数为`-InitializationProof/-GitExecutable/-GitRemoteHttpsExecutable/-GhExecutable/-NodeExecutable/-PythonExecutable/-PowerShellExecutable/-ProcessHostExecutable/-DesktopVitestEntrypoint/-DesktopTypeScriptEntrypoint/-DesktopViteEntrypoint`与可重复`-TrustedPathDirectory <absolute>`，macOS再必填`-BashExecutable`，每项只接受显式absolute string。初始化输出的批准记录必须立即复制到工作区外受保护存储/CI protected variable，且后续host把其中bootstrapSha256、runnerSha256与privateLockSha256都作为显式脚本参数传入；之后正式命令固定为：

~~~powershell
param(
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedBootstrapSha256,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedRunnerSha256,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedPrivateLockSha256,
    [Parameter(Mandatory)][string]$ExpectedWorkspaceRoot
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$PlatformName = if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) { 'windows-x64' } else { 'macos-arm64' }
$CanonicalWorkspaceRoot = [IO.Path]::GetFullPath($ExpectedWorkspaceRoot)
$BootstrapPath = [IO.Path]::GetFullPath([IO.Path]::Combine($CanonicalWorkspaceRoot, 'scripts', 'run_telegram_release_bootstrap.ps1'))
$BootstrapBytes = [IO.File]::ReadAllBytes($BootstrapPath)
$Hasher = [Security.Cryptography.SHA256]::Create()
try { $BootstrapActualSha256 = ([BitConverter]::ToString($Hasher.ComputeHash($BootstrapBytes))).Replace('-', '').ToLowerInvariant() } finally { $Hasher.Dispose() }
if ($BootstrapActualSha256 -cne $ExpectedBootstrapSha256) { throw 'RELEASE_BOOTSTRAP_IDENTITY_MISMATCH' }
if (($BootstrapBytes.Length -ge 3 -and $BootstrapBytes[0] -eq 0xEF -and $BootstrapBytes[1] -eq 0xBB -and $BootstrapBytes[2] -eq 0xBF) -or ($BootstrapBytes -contains [byte]0)) { throw 'RELEASE_BOOTSTRAP_ENCODING_INVALID' }
$StrictUtf8 = New-Object Text.UTF8Encoding($false, $true)
$BootstrapScriptBlock = [ScriptBlock]::Create($StrictUtf8.GetString($BootstrapBytes))
. $BootstrapScriptBlock
$BootstrapProof = Open-ApprovedReleaseBootstrap -ExpectedWorkspaceRoot $CanonicalWorkspaceRoot -PlatformName $PlatformName -BootstrapSha256 $BootstrapActualSha256 -ExpectedRunnerSha256 $ExpectedRunnerSha256 -ExpectedPrivateLockSha256 $ExpectedPrivateLockSha256
. $BootstrapProof.RunnerScriptBlock -BootstrapProof $BootstrapProof

# 无凭据，可无人值守
Invoke-ReleaseRunnerInProcess -BootstrapProof $BootstrapProof -ExpectedHostMode NonInteractive -RunnerArguments @('-Step', 'recover')
Invoke-ReleaseRunnerInProcess -BootstrapProof $BootstrapProof -ExpectedHostMode NonInteractive -RunnerArguments @('-Step', 'freeze')
Invoke-ReleaseRunnerInProcess -BootstrapProof $BootstrapProof -ExpectedHostMode NonInteractive -RunnerArguments @('-Step', 'automation')
Invoke-ReleaseRunnerInProcess -BootstrapProof $BootstrapProof -ExpectedHostMode NonInteractive -RunnerArguments @('-Step', 'formal-run')
Invoke-ReleaseRunnerInProcess -BootstrapProof $BootstrapProof -ExpectedHostMode NonInteractive -RunnerArguments @('-Step', 'commit-evidence')
Invoke-ReleaseRunnerInProcess -BootstrapProof $BootstrapProof -ExpectedHostMode NonInteractive -RunnerArguments @('-Step', 'publish')

# 需要安全交互
Invoke-ReleaseRunnerInProcess -BootstrapProof $BootstrapProof -ExpectedHostMode Interactive -RunnerArguments @('-Step', 'secret-audit')
Invoke-ReleaseRunnerInProcess -BootstrapProof $BootstrapProof -ExpectedHostMode Interactive -RunnerArguments @('-Step', 'prepare-evidence')

# QA 机器生成，编排机摄取
Invoke-ReleaseRunnerInProcess -BootstrapProof $BootstrapProof -ExpectedHostMode Interactive -RunnerArguments @('-Step', 'record-windows', '-Mode', 'generate', '-AcceptanceInput', '.build/telegram-qa-windows-generate')
Invoke-ReleaseRunnerInProcess -BootstrapProof $BootstrapProof -ExpectedHostMode Interactive -RunnerArguments @('-Step', 'record-windows', '-Mode', 'ingest', '-AcceptanceInput', '.build/telegram-qa-windows-return')
Invoke-ReleaseRunnerInProcess -BootstrapProof $BootstrapProof -ExpectedHostMode Interactive -RunnerArguments @('-Step', 'record-macos', '-Mode', 'generate', '-AcceptanceInput', '.build/telegram-qa-macos-generate')
Invoke-ReleaseRunnerInProcess -BootstrapProof $BootstrapProof -ExpectedHostMode Interactive -RunnerArguments @('-Step', 'record-macos', '-Mode', 'ingest', '-AcceptanceInput', '.build/telegram-qa-macos-return')
Invoke-ReleaseRunnerInProcess -BootstrapProof $BootstrapProof -ExpectedHostMode Interactive -RunnerArguments @('-Step', 'record-manual', '-Mode', 'generate', '-AcceptanceInput', '.build/telegram-qa-manual-generate')
Invoke-ReleaseRunnerInProcess -BootstrapProof $BootstrapProof -ExpectedHostMode Interactive -RunnerArguments @('-Step', 'record-manual', '-Mode', 'ingest', '-AcceptanceInput', '.build/telegram-qa-manual-return')

# 显式放弃对应阶段；每次只允许一个
Invoke-ReleaseRunnerInProcess -BootstrapProof $BootstrapProof -ExpectedHostMode NonInteractive -RunnerArguments @('-Step', 'recover', '-Abort', 'formal')
Invoke-ReleaseRunnerInProcess -BootstrapProof $BootstrapProof -ExpectedHostMode NonInteractive -RunnerArguments @('-Step', 'recover', '-Abort', 'acceptance')
Invoke-ReleaseRunnerInProcess -BootstrapProof $BootstrapProof -ExpectedHostMode NonInteractive -RunnerArguments @('-Step', 'recover', '-Abort', 'publication')
~~~

上面的调用是**逐次 invocation 目录**，不是允许在一个host里整块连续粘贴：每次只从操作者明确批准的PowerShell绝对路径启动一个新根进程，以显式workspace root和工作区外批准的bootstrap/runner/private-lock三hash运行同一固定加载前言，dot-source已捕获且验hash的bootstrap bytes，再dot-source proof内runner scriptblock并只执行一条与实际interactive mode一致的`Invoke-ReleaseRunnerInProcess`，等待返回并由wrapper dispose proof后退出。bootstrap与runner hash必须先命中；private lock命中时才允许正常Step，lock缺失/漂移时只允许recovery-only proof先收敛已有native owner、随后identity mismatch退出。host identity由该调用在旧owner恢复后、完整toolchain解析前验证。根进程由操作者/CI直接启动，runner绝不通过ProcessHost、owned adapter或另一个PowerShell child启动自己；因此根bootstrap不会预占runner lease，也不会创建新的native owner。下一次调用仍由其自身取得lease，先恢复可能已经存在的旧native owner，再验证完整toolchain。测试必须覆盖：bootstrap路径不同bytes替换、workspace/scripts/.build/toolchain任一ancestor junction/symlink、runner/lock叶link、打开第一个后替换第二个、hash后同时替换自洽runner+lock、handle后rename/swap、外部bootstrap/runner/lock hash错误、lock内runner hash错误；bootstrap或runner hash错时script side effect/lease/owner/phase mutation全为零，只有bootstrap/runner外部hash都正确而lock错且存在旧owner时允许唯一lease+整树收敛，仓库/远端/phase mutation仍为零。另覆盖子级自举调用被拒、父控制台强杀留下可恢复phase、包括PowerShell在内任一toolchain成员漂移时recover先收敛旧树再identity mismatch。

真实Bot Token只在evidence ref已验证、Release公开并完成发布后复核时吊销。automation跑全部Python、Electron、扩展、packaging、runner fake-adapter回归；secret-audit用Task13唯一scanner扫冻结HEAD、index、工作树、runtime paths、Renderer export与diagnostics zip。客户资产存在后，extension zip/source bundle仍走普通Path/ExpandZip且API值零豁免；DMG/NSIS必须在真实mount/install后走package-aware mode并核对receipt，原artifact bytes仅补充Bot Token门禁，不能把合法credential中的API值当泄漏或只扫压缩bytes。任一读取/解码/zip/Git/package tree失败都fail closed。

- [ ] **Step 3: 定义 formal、abandoned、binding 与 ledger 的 exact DTO**

本Step内所有“命令返回不明”必须区分同一invocation的普通非零/超时/response-loss与父runner hard-kill，两者不得共用措辞或对象。普通路径只在当前永久runner lease尚存、对应owned child整树已settle后复用当前callback-private GitSession、CanonicalGitHubSession或内存credential lease读取真值，并在本次最外层finally清零。父runner hard-kill后，旧proof/session/Token/lease均已物理消失且严禁序列化、复用或声称“仍受保护”；下一invocation必须取得fresh永久runner lease，先只按durable native owner收敛旧guardian/target/member整树为零，再重验private lock、raw active marker/receipt、workspace baseline与manifest，分别重建fresh private GitSession或fresh CanonicalGitHubSession与fresh GitHubCredentialLease后才读取本地ODB/远端真值。fresh remote-missing查询产生fresh `RemoteMissingProof`，随后才允许ensure相同tag object与重试push。后文任何把父runner hard-kill与“同一session/仍受保护lease”并列的旧短语都由本段逐字替换；fixture必须在object/push child已退出而真值查询尚未开始时强杀父runner，证明旧对象不可用、旧树先归零且fresh invocation可恢复。

一旦formal marker进入`tag_push_attempted`，该版本永久失去复用资格；之后formal/acceptance/publication/watch cleanup对候选Git tag/ref的创建、覆盖与删除调用数全部固定为零，REST ref DELETE、`git push --delete`、删除refspec及任何conditional-delete helper/mode都禁止。失败候选把完整canonical annotated tag连同abandoned/watch当作远端tombstone保留，并强制下一候选的desktop与extension版本分别严格升高，因此旧tag不会阻止下一轮。push响应未知且远端暂时missing时允许先写`tagObserved=false`的watch；任一后续查询首次观察到完整canonical identity时必须先原子单向升级并回读`tagObserved=true`，此后永远只接受同一canonical object。`tagObserved=false`只接受missing或该canonical identity；lightweight、同HEAD异object及任意foreign ref始终fail closed。`tagObserved=true`再变missing同样视为外部破坏并保持watching，绝不重建、删除或覆盖。cleanup只经fresh CanonicalGitHubSession分页取消并等待当前可见matching runs/attempts terminal，再重验tag状态与Release集合；late run由永久watch重复同一流程，tag始终存在时workflow只能看到原canonical identity，不会因cleanup制造missing-tag重建竞态。fixture必须卡在workflow已通过tag验证而尚未Create Release时发起abort，断言runner先取消/等待run、tag/ref mutation始终为零，最终远端只可能保留原canonical tag与零项或唯一quarantine draft；另覆盖push response loss下missing→canonical的单向观察、canonical→missing、foreign/lightweight与late attempt。

任一时刻最多存在一个active formal、acceptance或publication marker。跨阶段交接固定为：先原子写successor、回读strict schema与`sourceMarkerSha256`，再删除predecessor；两者并存的crash恢复只在linkage/hash完全相等时继续。每次合法invocation顺序固定为：取得runner lease→收敛`.build/telegram-release-native-operation.json`并确认旧整树为空→扫描永久abandoned-watch并收敛late run→publication→acceptance→formal。active marker阻止不匹配阶段；resolved watch不阻止更高版本候选。任何remote、Git index/object/ref或其他native mutation前，必须先把phase marker写成对应`*_attempted`/`abort_requested`，再写native launching intent并回读；不能依赖进程内boolean。唯一content-addressed重建例外只有已明确命名的`Ensure-ReleaseAnnotatedTagObjectOwned`与`Ensure-ReleaseEvidenceObjectsOwned`：初次attempted态已持久化全部确定性inputs/expected SHA，后继truth/attempted态只在本地expected object确实missing时以same bytes幂等重建且不得修改index/ref/marker；existing wrong type/payload或任何index/ref mutation仍fail closed。runner lease、operation owner与phase marker分别解决并发owner、迟到child和业务事务恢复，三者不得互相替代。

ignored formal marker 固定为 .build/telegram-formal-run.json，strict DTO 为：

~~~json
{
  "schemaVersion": 1,
  "state": "prepare_tag",
  "repository": "owner/repo",
  "defaultBranch": "main",
  "workflowPath": ".github/workflows/release-packages.yml",
  "workflowBlobSha256": "64-lowercase-hex",
  "tag": "v1.2.3",
  "taggerInputs": {
    "name": "Downany Release Automation",
    "email": "downany-release-automation@users.noreply.github.com",
    "date": "@1700000000 +0000",
    "message": "Downany release v1.2.3"
  },
  "taggerInputsSha256": "64-lowercase-hex",
  "expectedTagObjectSha": "40-lowercase-hex",
  "tagObjectSha": null,
  "headSha": "40-lowercase-hex",
  "toolchainSha256": "64-lowercase-hex",
  "desktopVersion": "1.2.3",
  "extensionVersion": "0.8.2",
  "runId": null,
  "runAttempt": null,
  "releaseId": null,
  "automationReceiptSha256": null,
  "secretAuditReceiptSha256": null,
  "supersedesAbandonedSha256": null
}
~~~

`freeze`在写formal marker前必须从已验证`headSha` commit object读取唯一非负十进制committer timestamp，并固定`taggerInputs={name:"Downany Release Automation",email:"downany-release-automation@users.noreply.github.com",date:"@<head-committer-unix-seconds> +0000",message:"Downany release <tag>"}`；字段顺序、ASCII/UTF-8 bytes与canonical compact JSON加唯一末尾LF固定，`taggerInputsSha256`只散列该canonical bytes。仓库object format必须是`sha1`，否则在marker/tag-object/remote-ref mutation前失败。runner同时构造唯一annotated-tag payload：`object <headSha>\ntype commit\ntag <tag>\ntagger Downany Release Automation <downany-release-automation@users.noreply.github.com> <head-committer-unix-seconds> +0000\n\nDownany release <tag>\n`，并把`SHA1("tag <payload-UTF8-byte-length>\0" + payload)`写入`expectedTagObjectSha`。`tag/taggerInputs/taggerInputsSha256/expectedTagObjectSha`从`prepare_tag`起全程不可改变；任何字段缺失、额外、控制字符、大小写或重算不等都在local object/remote ref mutation前失败。

Task 17B 的前置顺序固定为 `recover → freeze → automation → secret-audit → formal-run`。`freeze` 只创建 `state=prepare_tag` 的 formal marker并把本机已验证private lock raw SHA写入`toolchainSha256`；两个receipt都完成前，local tag-object、remote tag ref、workflow与Release mutation调用数必须为零。receipt固定写入 `.build/telegram-release-preflight/v<desktopVersion>-<headSha>/automation.json` 与同目录 `secret-audit.json`，均逐字复制同一toolchain hash，采用UTF-8无BOM、如下固定字段顺序、LF与唯一末尾LF，禁止时间戳、主机名、本地路径、PID、凭据值或自由文本。

automation receipt exact DTO：

~~~json
{
  "schemaVersion": 1,
  "kind": "automation",
  "repository": "owner/repo",
  "headSha": "40-lowercase-hex",
  "desktopVersion": "1.2.3",
  "extensionVersion": "0.8.2",
  "workflowPath": ".github/workflows/release-packages.yml",
  "workflowBlobSha256": "64-lowercase-hex",
  "runnerBlobSha256": "64-lowercase-hex",
  "toolchainSha256": "64-lowercase-hex",
  "runnerTestBlobSha256": "64-lowercase-hex",
  "suiteId": "telegram-release-automation-v1",
  "result": "passed"
}
~~~

secret-audit receipt exact DTO：

~~~json
{
  "schemaVersion": 1,
  "kind": "secret_audit",
  "repository": "owner/repo",
  "headSha": "40-lowercase-hex",
  "desktopVersion": "1.2.3",
  "extensionVersion": "0.8.2",
  "workflowPath": ".github/workflows/release-packages.yml",
  "workflowBlobSha256": "64-lowercase-hex",
  "runnerBlobSha256": "64-lowercase-hex",
  "toolchainSha256": "64-lowercase-hex",
  "scannerBlobSha256": "64-lowercase-hex",
  "scopeManifestSha256": "64-lowercase-hex",
  "policy": "telegram-release-secret-audit-v1",
  "result": "passed"
}
~~~

所有`*BlobSha256`都散列frozen HEAD对应blob raw bytes；`scopeManifestSha256`散列scanner实际读取的canonical `{path,type,size,sha256}` 数组，不含内容。`automation`只允许formal marker为prepare_tag，先重验当前toolchain raw SHA逐字等于marker，再用checked adapter依次跑Task17A Step4从ProcessHost parent-death smoke开始、到两个browser-extension测试结束的全部Python、Electron、extension、packaging与runner fake-adapter测试/build命令；不重复执行Task17A scoped-WIP baseline/manifest，也绝不执行该tooling任务的git add/commit段。全部成功后再次调用下文唯一 `Verify-RepositoryBaseline(expectedHead, requireNeutralIndexFlags=true)`，再验证workflow blob与toolchain不变，才原子写/flush/rename并回读receipt并把其raw SHA写入`formal.automationReceiptSha256`。`secret-audit`只允许automation hash可重验且同一toolchain仍匹配；scanner全部通过后调用同一baseline verifier，以相同顺序写receipt并链接`formal.secretAuditReceiptSha256`。receipt已写但marker未链接时强杀，recover仅在identity、blob hashes、scope manifest、toolchain和当前candidate全部相等且baseline verifier重跑通过时补链接；不同则拒绝而不是信任旧passed。

state 只允许 prepare_tag、tag_object_written、tag_push_attempted、run_observed、draft_bound、no_side_effect_abort_requested、abort_requested、cleanup_pending。prepare_tag允许两个receipt hash按automation→secret-audit顺序从null变成非null；tag_object_written及之后两者必须均为64位hash且不可改变。`formal-run`在写canonical tag object前及push remote tag ref前都调用 `Verify-RepositoryBaseline(headSha,true)`，再重新读取两个receipt并验证raw SHA、identity/head/workflow/blob/scope仍匹配；任一失败返回`FORMAL_PREFLIGHT_NOT_VERIFIED`且tag-object/run/release mutation为零。`tagObjectSha=null` 只允许 prepare_tag/no_side_effect_abort_requested；tag_object_written及之后的`tagObjectSha`必须是40位SHA且逐字等于`expectedTagObjectSha`。任何初始`mktag`前先原子写prepare_tag；创建调用返回不明时recover只检查expected object：若不存在则以相同payload安全重试，存在则要求type=tag且raw payload逐字等于canonical payload，随后补写`tagObjectSha=expectedTagObjectSha/state=tag_object_written`；其他结果fail closed。runner绝不创建、更新或删除本地`refs/tags/<tag>`，因此本事务不存在本地tag ref或其`.lock` ownership。remote push前必须写tag_push_attempted；push无论退出码如何都从GitHub refs/tag-object API重验远端canonical tag identity，远端缺失时先按下文ensure分支验证或幂等重建同一object，再用同一refspec重试，object SHA与payload全相同才继续，歧义/不同identity停止。唯一run出现后写run_observed；零run在固定10分钟后返回FORMAL_RUN_PENDING并保留marker。`recover -Abort formal`在receipt任意完成度均可走既有无副作用分支；remote-zero双确认后先删除candidate preflight目录，再删除formal marker。进入tag_push_attempted后的abandoned/watch流程保留receipt hashes用于审计。

canonical annotated-tag object只允许由runner-private `Invoke-ReleaseAnnotatedTagObjectOwned -Toolchain <resolved> -FormalMarkerSha256 <current-raw-sha>`首次创建，或由只供push API内部调用的`Ensure-ReleaseAnnotatedTagObjectOwned -Toolchain <resolved> -FormalMarkerSha256 <current-raw-sha> -RemoteMissingProof <private-current-session-proof>`恢复；前者成功只返回exact `{State:"tag_object_written",TagObjectSha:<40-lowercase-hex>}`，后者只返回exact `{State:"verified",TagObjectSha:<40-lowercase-hex>}`。初始API只接受state=prepare_tag且`tagObjectSha=null`；ensure只接受state=tag_object_written或tag_push_attempted、`tagObjectSha=expectedTagObjectSha`，并要求RemoteMissingProof来自当前CanonicalGitHubSession、绑定同一repository/tag/marker raw SHA且证明remote ref刚刚为missing。RemoteMissingProof不含Token/header；产生它的API child必须先退出，GitHub lease只留在父runner受保护内存，ensure的本地Git child环境必须删除全部GH/GITHUB变量且不得获得该lease或Authorization header。两种object API都在同一runner lease内以marker.headSha调用`Assert-ReleaseRepositoryBaseline(...,RequireNeutralIndexFlags=true)`、冻结expected changed set为空的workspace manifest，再用该proof打开不可伪造的`formal_tag_object` GitSession：该session不设置`GIT_INDEX_FILE`，只从当前raw formal marker逐字重验`headSha/tag/taggerInputs/taggerInputsSha256/expectedTagObjectSha`。该mode的exact命令白名单只有三项：唯一write命令`mktag`必须通过`StandardInputBytes`接收helper从当前raw marker重建的canonical tag payload exact UTF-8 bytes；两条只读真值命令分别为`cat-file -t <expectedTagObjectSha>`与`cat-file tag <expectedTagObjectSha>`且stdin参数必须缺省。任何其他argv、错SHA、额外stdin、identity/config/env来源都在spawn前失败，三条命令都不得回填任何`GIT_AUTHOR_*`或`GIT_COMMITTER_*`。同一invocation的成功、非零、超时或response-loss先等待/收敛当前owned Git tree，再用仍有效的当前private session执行上述两条只读命令；父runner hard-kill则由下一invocation取得fresh runner lease、先按durable owner收敛旧树并重验raw marker/toolchain/workspace，再创建fresh baseline/manifest与fresh `formal_tag_object` session，绝不复用或序列化死亡进程的proof/session。object不存在时两种API都可用同一payload安全执行`mktag`，存在则必须type=tag，且`cat-file tag`的private raw stdout bytes按上文严格编码门禁逐字等于canonical payload后才可返回；最终`mktag`返回/重算SHA必须都等于`expectedTagObjectSha`。初始API随后原子写`tagObjectSha=expectedTagObjectSha/state=tag_object_written`；ensure不得修改marker，只把已验证/重建的同一object交还push API。此流程只写content-addressed object，不创建local ref；半写object、响应丢失、父强杀或正常maintenance/prune都只会在fresh真值读取后得到“expected object缺失并幂等重建”或“同一immutable object已存在”两种真相。

remote tag ref只允许由runner-private `Invoke-ReleaseAnnotatedTagPushOwned -Toolchain <resolved> -FormalMarkerSha256 <current-raw-sha>`推进；API只在远端完整canonical identity已确认后返回exact `{State:"verified",TagObjectSha:<expectedTagObjectSha>,HeadSha:<headSha>}`。调用前必须已经原子写state=`tag_push_attempted`，并在同一runner lease内重验raw formal marker、两个preflight receipt与workspace manifest；随后建立`CanonicalGitHubSession`与短生命周期`GitHubCredentialLease`。authenticated remote ref已是完整canonical identity时直接成功；foreign identity立即fail closed；只有missing时才把本次remote query产生的private RemoteMissingProof交给上述ensure API，要求本地expected object存在且payload正确，或在已被maintenance/prune时幂等`mktag`重建同一SHA。ensure成功后才创建不可伪造的`formal_tag_push` GitSession；该mode不设置`GIT_INDEX_FILE`、stdin参数必须缺省、唯一argv固定为`push --no-verify <canonicalHttpsRepositoryUrl> <expectedTagObjectSha>:refs/tags/<tag>`，canonical URL/repository/header只能来自该GitHub session/lease。同一invocation的成功、非零、超时或response-loss先等待/收敛当前owned Git tree，再在仍有效的当前CanonicalGitHubSession与credential lease内只经GitHub refs/tag-object API读取真相，API child也settle后才由最外层finally清零lease。父runner hard-kill后，下一invocation必须取得fresh runner lease、先按durable owner收敛旧native/Git树并重验raw marker/toolchain/receipts/workspace，再创建fresh CanonicalGitHubSession与fresh GitHubCredentialLease查询remote；旧session、proof、Token与lease严禁序列化或复用。remote missing时由该fresh查询取得fresh RemoteMissingProof，再创建fresh object/push GitSession、ensure同一object并用同一refspec重试；完整canonical identity视为成功，foreign/lightweight/同HEAD异object一律fail closed且零覆盖/删除。generic native、`formal_tag_object`或其他GitSession都不得执行该push。fixture覆盖缺credential lease、错URL/refspec/SHA、父GH/GITHUB污染、push commit-before-response-loss、object/push child退出后而真值查询前父runner hard-kill、hard-kill后prune expected object再recover重建，以及各强杀边界；要求旧session/lease不可用、旧树先归零、secret零输出、remote至多出现唯一canonical object、本地ref/lock始终为零。

从remote tag ref首次可观察提交点起，后文唯一的`canonical tag identity`固定指：ref object type=`tag`且其object SHA逐字等于各active/binding/acceptance/publication/abandoned/watch对象传播的`tagObjectSha=expectedTagObjectSha`；tag object的`tag/object/type/tagger/message`逐字段等于上文canonical payload并直接target `headSha`，递归peel结果也必须等于`headSha`。runner-private唯一helper固定为`Assert-CanonicalTagIdentityOwned -Repository <owner/repo> -Tag <vSemver> -TagObjectSha <40-lowercase-hex> -HeadSha <40-lowercase-hex> [-AllowMissing]`，只经CanonicalGitHubSession查询remote ref/tag/commit并返回exact `{State:"verified"|"missing",TagObjectSha:<40-lowercase-hex|null>,HeadSha:<40-lowercase-hex|null>}`；所有formal恢复/tag push、workflow draft staging、acceptance ingest/abort、publication prepare/commit/publish、receipt/watch审计以及把draft推进public的PATCH前后都必须调用等价门禁重新查询并验证完整canonical identity；只peel到同一HEAD不构成身份。lightweight ref或同HEAD异object一律视为foreign：在formal tag push、publish/PATCH-to-public或任何其他remote mutation前发现时必须零删除、零覆盖、零Release mutation并保留当前marker供人工处理；若exact releaseId的public PATCH已可能提交后才观察到tag漂移，只允许先把该owned Release PATCH回draft并验证，随后同样禁止tag/ref mutation并fail closed。相应fixture在push后分别替换成lightweight ref与同HEAD不同tagger/message的annotated object，要求publish/PATCH与tag/ref mutation全部为零。

`recover -Abort formal` 只有从未进入tag_push_attempted时可走无外部副作用退出：先写no_side_effect_abort_requested；authenticated确认remote tag、matching push run、matching Release与evidence ref全为零；本地expected tag object可以存在或不存在，但永远没有local ref，且abort不删除content-addressed object；再次确认四组remote集合仍为空后删除formal marker并返回`FORMAL_PREPARE_ABORTED_NO_SIDE_EFFECT`，不写abandoned/watch且版本可复用。只要曾进入tag_push_attempted，即使当前remote ref缺失，也必须先写abort_requested，再查询remote ref并只接受missing或完整canonical identity；任一同HEAD异object/lightweight立即零run/Release/tag mutation并fail closed。随后分页取消所有当前可见matching run/attempt并逐项等待terminal，重新查询tag并要求仍为原状态或只允许missing首次升级为完整canonical identity；GitHub tag/ref、Release与asset DELETE/覆盖调用数全部为零。若存在唯一matching Release则必须保持`draft=true`并把其exact releaseId作为隔离证据写入abandoned/watch，缺失则releaseId保持null；多个Release、公开Release、tag退化/漂移或身份异常一律拒绝。最后用本次tag真值写`watch.tagObserved`、原子写abandoned/watch并要求新版本，再删除formal marker；任何迟到run由watch先退回watching、取消/等待并绑定可能出现的唯一quarantine draft，永不删除canonical tag。attempt不为1、run/job失败或取消使用同一cleanup。

失败状态固定写 .build/telegram-release-abandoned.json：

~~~json
{
  "schemaVersion": 1,
  "state": "abandoned",
  "source": "formal_run",
  "reason": "run_failed",
  "repository": "owner/repo",
  "workflowPath": ".github/workflows/release-packages.yml",
  "tag": "v1.2.3",
  "tagObjectSha": "40-lowercase-hex",
  "headSha": "40-lowercase-hex",
  "toolchainSha256": "64-lowercase-hex",
  "desktopVersion": "1.2.3",
  "extensionVersion": "0.8.2",
  "runId": null,
  "runAttempt": null,
  "releaseId": null,
  "inputManifestSha256": null,
  "bindingSha256": null,
  "evidenceRef": null,
  "evidenceCommitSha": null,
  "evidenceRefConflictSha256": null,
  "sourceMarkerSha256": "64-lowercase-hex"
}
~~~

source 只允许 formal_run、acceptance 或 publication；reason 只允许 run_failed、run_cancelled、formal_aborted、acceptance_failed、acceptance_aborted、publication_aborted、publication_rollback、evidence_persist_failed、evidence_ref_conflict。nullable 字段对应对象一旦存在就必须填写，不得恢复 null。`evidenceRef/evidenceCommitSha` 必须同时为null或同时非null；非null时remote ref必须peel到该commit。`evidenceRefConflictSha256`非null时前两项必须均为null，并指向下述foreign-ref tombstone。cleanup先原子写并回读abandoned，最后才删active marker。下一轮desktop与extension semver必须分别严格大于abandoned旧值；新formal marker写入supersedesAbandonedSha256并回读后才删canonical abandoned。desktop/package.json必须等于package-lock顶层与packages[""].version；extension semver独立，不要求与desktop相等。

每次 abandon 同时写永久 `.build/telegram-abandoned-watch/v<desktopVersion>-<headSha>.json`，strict 字段为 `schemaVersion/repository/workflowPath/tag/tagObjectSha/tagObserved/headSha/runId/runAttempt/releaseId/evidenceRef/evidenceCommitSha/evidenceRefConflictSha256/state/lastCheckedAt`，并使用相同nullness/互斥规则；`tagObserved`是boolean且只能从false单向升级为true，state只允许watching/resolved。GitHub官方REST合同没有为`DELETE /releases/{release_id}`声明条件写，且`gh release create --verify-tag`的验证与Create API也不是CAS，因此进入tag_push_attempted后runner对tag/ref、Release与asset的DELETE/覆盖调用数永久为零。abort收敛顺序固定为active→abort_requested→查询tag：`tagObserved=false`只接受missing或完整canonical identity，观察到后者先持久化true；`tagObserved=true`只接受完整canonical identity，同HEAD异object/lightweight及canonical→missing都在run/Release mutation前fail closed→分页取消并等待所有当前可见matching runs terminal→重新执行同一tag门禁→确认Release集合只能为零项或唯一`draft=true`的matching quarantine draft；active/binding已传播非null releaseId时必须逐字等于该ID，原值为null而首次发现唯一draft时必须在写abandoned/watch前原子把该ID单向绑定为正整数并回读，第二个ID或已绑定ID漂移立即fail closed→写回canonical abandoned与watch→删除active。canonical tag、quarantine draft及其现有asset按原bytes保留为失败证据，不再公开，也不阻止严格更高版本使用不同tag创建下一候选。后续每次runner入口都分页重查所有watch（包括resolved）；若resolved后出现late run或tagObserved/releaseId需要合法单向升级，先原子退回watching，再取消/等待当前可见runs，随后重新执行tag门禁并确认Release仍为零项或同一唯一quarantine draft，才可重新resolved并更新lastCheckedAt。Release变public、releaseId/数量/tag_name漂移、出现第二个matching Release、tag identity退化或已观察tag消失时一律保持watching并fail closed；watch阶段只允许run cancellation与上述两个本地单向字段升级，tag/ref、Release/asset mutation和PATCH均为零。watch永久保留，任意延迟run都会在下一入口重新进入watching且不能把旧版本误当可复用。

foreign evidence ref不属于候选：发现`evidenceRef`指向非本marker预期commit时，绝不删除、覆盖或force-push，先把publication写成`evidence_ref_conflict`并持久化strict `evidenceRefConflict={evidenceRef,expectedEvidenceCommitSha,observedObjectType,observedObjectSha,observedPeeledCommitSha,observedAt}`；type只允许commit/tag，三个SHA均为40位，observedAt为UTC整秒。随后返回`EVIDENCE_REF_CONFLICT_REQUIRES_ABORT`。显式`recover -Abort publication`先写abort_requested，再原子写永久`.build/telegram-evidence-ref-conflicts/v<desktopVersion>-<headSha>.json`，exact DTO为：

~~~json
{
  "schemaVersion": 1,
  "state": "foreign_ref_isolated",
  "repository": "owner/repo",
  "tag": "v1.2.3",
  "headSha": "40-lowercase-hex",
  "desktopVersion": "1.2.3",
  "evidenceRef": "refs/tags/downany-evidence/v1.2.3",
  "expectedEvidenceCommitSha": "40-lowercase-hex",
  "observedObjectType": "commit",
  "observedObjectSha": "40-lowercase-hex",
  "observedPeeledCommitSha": "40-lowercase-hex",
  "observedAt": "2026-08-11T12:00:00Z",
  "sourcePublicationMarkerSha256": "64-lowercase-hex"
}
~~~

abandoned/watch只记录tombstone raw SHA并以reason=evidence_ref_conflict链接失败候选；候选canonical tag、唯一quarantine draft及其现有assets全部保留，候选tag/ref、Release与asset mutation调用数固定为零。只有tombstone已原子落盘、回读且其`sourcePublicationMarkerSha256`仍逐字等于当前publication raw SHA时，才可按既有guarded local cleanup清理active marker；foreign ref mutation调用数同样必须为零。Task17R只复核tombstone与abandoned linkage，不要求foreign ref继续存在或不变。

正式成功后写 .build/telegram-acceptance-run.json：

~~~json
{
  "schemaVersion": 1,
  "state": "awaiting_reports",
  "repository": "owner/repo",
  "defaultBranch": "main",
  "workflowPath": ".github/workflows/release-packages.yml",
  "workflowBlobSha256": "64-lowercase-hex",
  "tag": "v1.2.3",
  "tagObjectSha": "40-lowercase-hex",
  "headSha": "40-lowercase-hex",
  "toolchainSha256": "64-lowercase-hex",
  "desktopVersion": "1.2.3",
  "extensionVersion": "0.8.2",
  "runId": "decimal-string",
  "runAttempt": 1,
  "releaseId": "decimal-string",
  "inputManifestSha256": "64-lowercase-hex",
  "bindingSha256": "64-lowercase-hex",
  "acceptanceStateSha256": null,
  "sourceFormalMarkerSha256": "64-lowercase-hex"
}
~~~

acceptance marker 的 state 只允许 awaiting_reports、ready_to_prepare_evidence、publication_handoff_prepared、abort_requested、cleanup_pending。`acceptanceStateSha256`在awaiting_reports必须为null，在ready_to_prepare_evidence/publication_handoff_prepared必须是final ledger raw SHA且不可改变；abort_requested/cleanup_pending保留来源态的nullness。`toolchainSha256`逐字继承formal marker且编排机每次mutation前都重验；central binding固定为`.build/telegram-release-binding.json`，QA input中的同名文件必须与其raw bytes相等并携带同一编排机toolchain hash；strict DTO为：

~~~json
{
  "schemaVersion": 1,
  "repository": "owner/repo",
  "defaultBranch": "main",
  "workflowPath": ".github/workflows/release-packages.yml",
  "workflowBlobSha256": "64-lowercase-hex",
  "tag": "v1.2.3",
  "tagObjectSha": "40-lowercase-hex",
  "headSha": "40-lowercase-hex",
  "toolchainSha256": "64-lowercase-hex",
  "desktopVersion": "1.2.3",
  "extensionVersion": "0.8.2",
  "runId": "decimal-string",
  "runAttempt": 1,
  "releaseId": "decimal-string",
  "automationReceiptSha256": "64-lowercase-hex",
  "secretAuditReceiptSha256": "64-lowercase-hex"
}
~~~

central input固定为`.build/telegram-acceptance-input.json`，QA input中的同名文件必须raw-equal；strict DTO为：

~~~json
{
  "schemaVersion": 1,
  "bindingSha256": "64-lowercase-hex",
  "repository": "owner/repo",
  "tag": "v1.2.3",
  "headSha": "40-lowercase-hex",
  "runnerToolchainSha256": "64-lowercase-hex",
  "runId": "decimal-string",
  "runAttempt": 1,
  "releaseId": "decimal-string",
  "assets": [
    {"role":"chrome_extension_zip","releaseAssetId":"decimal-string","fileName":"Downany-chrome-extension-0.8.2.zip","size":1,"sha256":"64-lowercase-hex"},
    {"role":"macos_dmg","releaseAssetId":"decimal-string","fileName":"Downany-1.2.3-mac-arm64.dmg","size":1,"sha256":"64-lowercase-hex"},
    {"role":"source_bundle","releaseAssetId":"decimal-string","fileName":"Downany-third-party-sources-1.2.3.tar.zst","size":1,"sha256":"64-lowercase-hex"},
    {"role":"windows_installer","releaseAssetId":"decimal-string","fileName":"Downany-1.2.3-win-x64.exe","size":1,"sha256":"64-lowercase-hex"}
  ],
  "reports": [
    {"role":"sidecar_install_macos_arm64","workflowArtifactId":"decimal-string","fileName":"sidecar-install-report-macos-arm64.json","size":1,"sha256":"64-lowercase-hex"},
    {"role":"sidecar_install_windows_x64","workflowArtifactId":"decimal-string","fileName":"sidecar-install-report-windows-x64.json","size":1,"sha256":"64-lowercase-hex"},
    {"role":"sidecar_native_macos_arm64","workflowArtifactId":"decimal-string","fileName":"sidecar-native-report-macos-arm64.json","size":1,"sha256":"64-lowercase-hex"},
    {"role":"sidecar_native_windows_x64","workflowArtifactId":"decimal-string","fileName":"sidecar-native-report-windows-x64.json","size":1,"sha256":"64-lowercase-hex"}
  ]
}
~~~

两个数组都按role UTF-8 bytes升序，集合/顺序/字段/fileName精确相等；每个releaseAssetId必须属于binding.releaseId，每个workflowArtifactId必须来自binding.runId/runAttempt=1的run-artifacts API。binding中的两个preflight receipt SHA必须逐字等于最终formal marker并重新验证其raw bytes/identity。两个JSON都是UTF-8无BOM、固定字段顺序、LF与唯一末尾LF，`bindingSha256/inputManifestSha256`散列raw bytes；缺/额外字段、重复/乱序/未知role、版本化fileName不符、跨run/release ID均fail closed。input自身不含其raw hash，避免循环；binding也不含input hash。acceptance ledger固定为：

~~~json
{
  "schemaVersion": 1,
  "state": "awaiting_reports",
  "bindingSha256": "64-lowercase-hex",
  "inputManifestSha256": "64-lowercase-hex",
  "canonicalRoot": ".build/telegram-acceptance-records/v1.2.3-0123456789abcdef0123456789abcdef01234567",
  "records": {
    "windowsReport": {"relativePath":"telegram-windows-acceptance.json","sha256":null},
    "macosReport": {"relativePath":"telegram-macos-acceptance.json","sha256":null},
    "manualReport": {"relativePath":"telegram-manual-acceptance.json","sha256":null},
    "humanEvidenceInput": {"relativePath":"telegram-human-evidence-input.json","sha256":null}
  }
}
~~~

该ledger的唯一固定路径是`.build/telegram-acceptance-ledger.json`。`canonicalRoot`必须逐字由当前desktopVersion与headSha推导、为`.build`内regular non-link containment；records四个key/relativePath固定且禁止斜杠、额外字段或重命名。ledger只允许`awaiting_reports`与`ready_to_prepare_evidence`；awaiting允许四个sha逐项由null变为非null，ready要求全部非null。所有写入都以同目录随机临时文件、flush、原子rename并回读strict schema/raw SHA，binding/input hash自创建起不可改变。

最后一份现场输入摄取完成后的顺序固定为：先把已验证raw bytes写入canonicalRoot并回读 → 原子写四个sha全非null且state=ready_to_prepare_evidence的最终ledger → 回读ledger并计算其canonical raw bytes SHA256 → 原子把acceptance marker更新为`state=ready_to_prepare_evidence`与`acceptanceStateSha256=<ledger raw SHA>` → 回读marker并要求identity、binding/input hash与ledger hash全部匹配。不得声称两个文件“同时原子更新”。recover矩阵精确为：marker awaiting + ledger awaiting继续；marker awaiting + ledger ready时重验四个canonical bytes后只补marker ready/hash；marker ready + ledger ready且raw hash相等时幂等继续；marker ready但ledger缺失/非ready/hash不同则返回`ACCEPTANCE_STATE_LINK_MISMATCH`且零mutation；publication successor存在时按source marker handoff继续，绝不回退或重写final ledger。`publication_handoff_prepared`保留同一非null acceptanceStateSha256，publication marker及五份evidence逐字复制该值；acceptance abort从awaiting发起时该字段可null，从ready发起时必须保留。fake adapter在ready ledger rename后/marker更新前及marker更新后分别强杀，前者只补链接，后者完全幂等；ready marker对应缺失、旧或不同ledger必须零Git/GitHub mutation。任一真实验收失败保持awaiting_reports并返回稳定code；操作者确认候选不可发布时用`recover -Abort acceptance`，先验证marker/binding传播的完整canonical tag identity与matching workflow run仍terminal，要求binding.releaseId对应唯一matching Release仍为`draft=true`并作为quarantine draft保留；tag/ref、Release与asset mutation调用数均为零。随后写`tagObserved=true`的abandoned/watch，回读source linkage后才清理candidate canonical records、central binding/input/ledger与candidate preflight目录。同HEAD异object/lightweight、canonical tag缺失、run重新变为非terminal或Release漂移均保留acceptance marker并fail closed。不能要求publication marker存在，也不能偷偷改版本。

- [ ] **Step 4: 冻结默认分支并创建唯一 attempt-1 draft run**

freeze 要求当前 HEAD 已合并且精确等于 origin 的 authenticated default branch，Task 17A tooling commit 是其 ancestor，index/worktree除 ignored .build 外完全干净，当前 desktop 版本严格 semver且 tag/release/evidence ref均不存在，workflow blob来自 HEAD而非工作树。若当前版本已被使用，freeze 只能返回 VERSION_PREPARATION_REQUIRED，操作者先执行 Task 17R并把版本提交合入默认分支，不能在本步骤临时改版本。formal-run 创建 annotated `v<desktopVersion>` tag并 push；只接受 event=push、ref=该 tag、headSha=冻结 HEAD、run_attempt=1 的唯一 workflow run，且 release job成功。workflow 必须只生成 draft，不公开；runner 使用 authenticated paginated release list按 exact tag过滤，不能用只返回 published release 的 get-by-tag endpoint寻找 draft。所有Release mutation前后都再次验证传播的`tagObjectSha`所代表的完整canonical tag identity，不能只peel到`headSha`；Release target metadata不作为身份门禁。

成功后从binding.releaseId与同一run APIs下载4个客户asset和4个audit report，逐项记录exact ID/role/name/size/SHA并验证bytes；把formal marker两个preflight receipt hash逐字复制到binding，按上述canonical格式写binding、input与awaiting ledger（含固定canonicalRoot/四个null record SHA）并回读raw hash。随后把formal marker写draft_bound，原子写含`sourceFormalMarkerSha256`且`acceptanceStateSha256=null`的acceptance marker并回读，最后才删除formal marker；preflight目录至少保留到publication receipt终验。任何失败都按Step3 durable marker收敛；禁止rerun旧workflow attempt或覆盖tag，aborted候选保留已验证canonical tag与唯一quarantine draft并以abandoned/watch留记录，下一候选必须升版；foreign同HEAD tag零修改。

- [ ] **Step 5: 双平台与 manual 报告采用 generate → transfer → central ingest**

Mode=generate只在QA主机运行：读取`<root>/input/telegram-release-binding.json`与`telegram-acceptance-input.json`并核对raw SHA、tag/head/run/attempt；按input中的releaseAssetId从同一release下载并验证artifact；验收者把真实Token直接输入安装包UI，runner不代传；随后执行真实安装、PackageSmoke双owner tree、Bot四类目标、失败/重试、文件类型、2GB边界。Windows以NSIS完整安装根调用package mode；macOS必须以DMG完整mount root调用，不能只传`Downany.app`，从而把`.background`、卷图标、标准Applications link及其他卷根成员一并纳入receipt。每个平台在真实mount/install仍存在时立即于scanner credential lease调用package-aware mode并保留strict receipt，再以普通scope扫本次runtime data、Renderer export、diagnostics zip/return bundle；用bot-proof lease同进程验证getMe/HMAC alias。报告artifact/receipt SHA必须等于input。generate只写`<root>/return`，不读写中央ledger。

generate在同目录随机staging中完整生成并扫描return bundle，回读后才原子rename到`<root>/return`；目标已存在只允许exact same bytes幂等成功。bundle根只能包含`telegram-acceptance-return-manifest.json`与manifest列出的regular non-link files，禁止额外文件/目录、symlink、junction或reparse point；manifest自身不进入files避免自引用。Mode=ingest只在编排机运行：要求中央binding/input/ledger存在，逐字验证returned binding/input SHA，再以scanner lease扫描整个exact return tree，核对manifest/report strict schema、package receipt与artifact bytes。验证完成后把本kind payload写入ledger指定canonicalRoot；每个文件都用同目录临时文件、flush、原子rename和回读，缺失时创建、相同bytes幂等、不同bytes返回`ACCEPTANCE_REPORT_CONFLICT`。只有canonical bytes已持久化并回读后才更新ledger hash；最后一项再按ledger→marker事务提升ready。

每个 return manifest exact DTO：

~~~json
{
  "schemaVersion": 1,
  "kind": "windows_acceptance",
  "bindingSha256": "64-lowercase-hex",
  "inputManifestSha256": "64-lowercase-hex",
  "files": [
    {
      "role": "acceptance_input",
      "fileName": "telegram-acceptance-input.json",
      "size": 1,
      "sha256": "64-lowercase-hex"
    },
    {
      "role": "platform_report",
      "fileName": "telegram-windows-acceptance.json",
      "size": 1,
      "sha256": "64-lowercase-hex"
    },
    {
      "role": "release_binding",
      "fileName": "telegram-release-binding.json",
      "size": 1,
      "sha256": "64-lowercase-hex"
    }
  ]
}
~~~

kind只允许windows_acceptance、macos_acceptance、manual_acceptance，files按role UTF-8 bytes排序且元素字段exact为`role/fileName/size/sha256`。windows exact set为`acceptance_input/platform_report/release_binding`，对应文件名是上例；macos只把platform report文件名换成`telegram-macos-acceptance.json`。manual exact set为`acceptance_input → telegram-acceptance-input.json`、`human_evidence_input → telegram-human-evidence-input.json`、`manual_report → telegram-manual-acceptance.json`、`release_binding → telegram-release-binding.json`。generate必须把input中的binding/input raw bytes逐字复制到return，对应manifest SHA分别等于原始raw SHA。

ingest成功后的唯一持久owner就是ledger的`.build/telegram-acceptance-records/v<desktopVersion>-<headSha>/`；其中只允许四个固定payload文件，returned binding/input只用于逐字验证而不重复存入canonicalRoot。ledger记录每个canonical relativePath与raw SHA，不记录调用者`AcceptanceInput`路径。`prepare-evidence`只能从中央binding/input、fixed ledger及canonicalRoot读取，绝不再访问此前return目录；成功ingest后删除/移动所有return目录仍必须生成相同五份planned bytes。acceptance/publication abort仅在abandoned/watch持久化后清理candidate canonical records及central binding/input/ledger；成功发布时这些输入至少保留到Step 9在重验preflight raw receipt、remote evidence ref与live Release后写入永久publication receipt，再以该receipt为唯一恢复锚点逐项幂等清理。测试覆盖任意transfer路径、return删除后prepare、canonical写后ledger前强杀、同bytes幂等、不同bytes冲突、returned binding/input不同、manifest漏项/额外/乱序、额外文件/link/reparse与错误candidate目录，失败均不得提升ledger或开始publication。

平台 report exact DTO：

~~~json
{
  "schemaVersion": 1,
  "kind": "windows-x64",
  "repository": "owner/repo",
  "tag": "v1.2.3",
  "headSha": "40-lowercase-hex",
  "runId": "decimal-string",
  "runAttempt": 1,
  "bindingSha256": "64-lowercase-hex",
  "inputManifestSha256": "64-lowercase-hex",
  "runnerToolchainSha256": "64-lowercase-hex",
  "artifact": {
    "role": "windows_installer",
    "fileName": "Downany-1.2.3-win-x64.exe",
    "size": 1,
    "sha256": "64-lowercase-hex"
  },
  "osBuild": "Windows 11 26100",
  "installPathPolicy": "unicode-and-space-v1",
  "botAccountAlias": "16-lowercase-hex",
  "packageVerification": "passed",
  "packageSmoke": "passed",
  "telegramTargetMatrix": "passed",
  "secretAudit": {
    "schemaVersion": 1,
    "mode": "package_tree",
    "platform": "windows-x64",
    "policy": "telegram-app-credentials-v1",
    "artifactSha256": "64-lowercase-hex",
    "treeManifestSha256": "64-lowercase-hex",
    "entryCount": 1,
    "regularFileCount": 1,
    "treeBytesScanned": 1,
    "credentialFileCount": 1,
    "result": "passed"
  }
}
~~~

macOS只把kind、artifact role/name、osBuild、`installPathPolicy`与`secretAudit.platform`替换为macos-arm64、macos_dmg、DMG、安全macOS build string、`not-applicable`和macos-arm64，字段集合不变。每台QA机的`runnerToolchainSha256`来自其本机已验证private lock，可与编排机`toolchainSha256`不同，但generate开始、每个credential child前后与report落盘前必须保持不变。`record-windows -Mode generate` 必须把 NSIS `/D=<path>` 保持为最后一个参数，并在任何安装 mutation 前断言 contained install root 同时含至少一个 ASCII space 与一个非 ASCII code point；完整 install → package verifier → package-aware scanner → package smoke → uninstall 全部只能在该 root 上完成，report 的 `installPathPolicy` 必须精确为 `unicode-and-space-v1`。`record-macos -Mode generate` 固定写 `not-applicable`。两个 generate 都必须在真实install/mount仍存在时，于scanner credential lease内调用Task13 package-aware mode；Windows传完整安装根，macOS传DMG mount root并显式拒绝只传`Downany.app`。workflow receipt不能代替本次QA扫描，runner只能原样解析/嵌入scanner stdout DTO，不允许人工构造passed。central ingest要求receipt strict fields、platform与report kind一致、runnerToolchainSha256为64位lowercase hex、artifactSha256同时等于report artifact/input manifest SHA、policy固定、Windows/macOS `installPathPolicy` 分别精确为上述值、credentialFileCount=1、counts合法、result=passed；缺/额外字段、旧字符串`"passed"`、跨artifact receipt或只扫压缩原始bytes都失败。完整泄漏结论来自真实树；原artifact bytes只是Bot Token补充，extension/source/runtime/diagnostics继续走普通scope且无API值豁免。两个平台receipt全部通过前ledger不得ready、publication不得开始。两端botAccountAlias必须相同，计算固定为HMAC-SHA256(key=UTF8(real Bot Token), message=UTF8("downany-bot-account-v1\0"+getMe.accountId))前16个lowercase hex；Token和完整account ID不得进入任何report/marker/log。

平台generate的candidate调用合同固定为：Windows installer、安装后package smoke、真实UI会话与uninstaller分别通过`windows_installer/windows_app/windows_app_interactive/windows_uninstaller` role；macOS的挂载/卸载、`hdiutil/otool/lipo/plutil`与package verifier只走private lock静态trusted closure，DMG内package smoke与真实UI会话分别走`macos_app/macos_app_interactive` role。interactive app必须由runner受控启动，禁止Explorer、Finder、Dock、`open`、普通`Start-Process`或其他旁路；用户只在该窗口中输入真实Token并按产品正常流程完成验收。两个平台都禁止把候选路径临时加入toolchain。`candidate-native-bindings.json`从首次候选spawn前持续存在，直到本平台report原子落盘并回读strict DTO、native owner已删除且bridge/guardian/target/后代整棵树均确认为空；只有此时才能删除binding。report落盘前任一强杀都必须以同一acceptance marker、binding raw SHA和candidate identity恢复，不得重新发现或猜测安装路径。

manual report exact字段为 schemaVersion、kind=manual、repository、tag、headSha、runnerToolchainSha256、runId、runAttempt、bindingSha256、inputManifestSha256、botAccountAlias、humanEvidenceInputSha256，以及 artifactVerifiers、failureAndRetryMatrix、largeFileBoundary、lifecycleEligibility、realBotTargetMatrix、sourceBundle 六个值为 passed 的字段；禁止自由文本和额外字段。manual generate同样在本机toolchain验证后执行并把其raw SHA写入该字段，不能继承PATH工具。

- [ ] **Step 6: 用 strict human input 确定性生成五份 evidence**

manual generate 同时写 telegram-human-evidence-input.json：

~~~json
{
  "schemaVersion": 1,
  "repository": "owner/repo",
  "tag": "v1.2.3",
  "headSha": "40-lowercase-hex",
  "runId": "decimal-string",
  "runAttempt": 1,
  "bindingSha256": "64-lowercase-hex",
  "inputManifestSha256": "64-lowercase-hex",
  "botAccountAlias": "16-lowercase-hex",
  "osBuilds": {
    "macosArm64": "macOS 15.6",
    "windowsX64": "Windows 11 26100"
  },
  "targetTypes": ["channel", "group", "private", "supergroup"],
  "fileCases": [
    {"role":"document_small","bytes":1024,"result":"passed"},
    {"role":"m4a_small","bytes":1024,"result":"passed"},
    {"role":"mp3_small","bytes":1024,"result":"passed"},
    {"role":"mp4_small","bytes":1024,"result":"passed"},
    {"role":"near_limit","bytes":1950000000,"result":"passed"},
    {"role":"oversize","bytes":2000000001,"result":"passed"}
  ],
  "scenarios": {
    "artifactVerifiers": "passed",
    "failureAndRetryMatrix": "passed",
    "largeFileBoundary": "passed",
    "lifecycleEligibility": "passed",
    "realBotTargetMatrix": "passed",
    "sourceBundle": "passed"
  },
  "screenshots": [
    {
      "platform": "windows-x64",
      "fileName": "windows-private-send.png",
      "sha256": "64-lowercase-hex"
    }
  ]
}
~~~

targetTypes、fileCases和scenarios是上述 exact set。OS build只接受安全字符白名单；截图只接受 basename，禁止斜杠、盘符和 ..；near_limit.bytes 在1900000000..2000000000，oversize.bytes大于2000000000。`prepare-evidence` 只能从此 JSON、三个 report、binding/input和 GitHub API确定性渲染以下 exact 5 个文件，不允许人工编辑 Markdown：

- docs/REGRESSION-2026-08.md
- docs/REGRESSION-2026-08.json
- docs/REGRESSION-2026-08-windows.json
- docs/REGRESSION-2026-08-macos.json
- docs/REGRESSION-2026-08-manual.json

主 JSON exact字段为 schemaVersion、repository、tag、tagObjectSha、tagDirectTargetSha、tagPeeledCommitSha、headSha、runId、runAttempt、releaseId、workflowPath、workflowBlobSha256、automationReceiptSha256、secretAuditReceiptSha256、inputManifestSha256、bindingSha256、acceptanceStateSha256、humanEvidenceInputSha256、botAccountAlias、evidenceRef，以及按 role排序的 assets[4]、reports[4]、acceptance[3]；`tagObjectSha`逐字复制binding，`prepare-evidence`必须在渲染前调用`Assert-CanonicalTagIdentityOwned`重验live tag，随后把已验证的direct target与recursive peel结果分别写入`tagDirectTargetSha/tagPeeledCommitSha`，两者都必须逐字等于`headSha`。两个preflight hash逐字复制binding并在生成前重验receipt raw bytes，每个数组元素只含 role、fileName、size、sha256。五份evidence只记录确定性的evidenceRef名称，严禁包含evidenceCommitSha、evidenceTreeSha、publication receipt SHA或自身blob SHA，否则形成自引用。三个平台/manual原始report按raw bytes进入对应evidence JSON，主JSON绑定其hash。Markdown只展示产品验收事实和安全alias，不写Token、chat ID、用户名路径、API credential或自由手填hash。五份planned bytes只写`.build/telegram-evidence-staging/<version>/` regular non-link containment并逐项扫描；Task17B不直接写工作树对应路径，后续只通过临时Git index进入evidence commit。五份planned bytes的renderer、strict parser与fixture必须共同拒绝主JSON缺失、额外、非40位或与binding/live canonical tag identity不一致的上述三个tag字段。

- [ ] **Step 7: 准备证据并把 publication 做成可恢复事务**

publication marker 固定为 .build/telegram-publication.json，strict DTO：

~~~json
{
  "schemaVersion": 1,
  "repository": "owner/repo",
  "defaultBranch": "main",
  "workflowPath": ".github/workflows/release-packages.yml",
  "workflowBlobSha256": "64-lowercase-hex",
  "releaseId": "decimal-string",
  "tag": "v1.2.3",
  "tagObjectSha": "40-lowercase-hex",
  "headSha": "40-lowercase-hex",
  "toolchainSha256": "64-lowercase-hex",
  "desktopVersion": "1.2.3",
  "extensionVersion": "0.8.2",
  "runId": "decimal-string",
  "runAttempt": 1,
  "inputManifestSha256": "64-lowercase-hex",
  "bindingSha256": "64-lowercase-hex",
  "acceptanceStateSha256": "64-lowercase-hex",
  "humanEvidenceInputSha256": "64-lowercase-hex",
  "sourceAcceptanceMarkerSha256": "64-lowercase-hex",
  "state": "evidence_prepared",
  "disposition": "continue",
  "evidenceRef": "refs/tags/downany-evidence/v1.2.3",
  "evidenceIndexRelativePath": ".build/telegram-evidence-index/v1.2.3/40-lowercase-head-sha.index",
  "evidenceFiles": [
    {
      "path": "docs/REGRESSION-2026-08-macos.json",
      "sha256": "64-lowercase-hex",
      "originalBlobOid": null
    }
  ],
  "evidenceTreeSha": null,
  "commitInputs": null,
  "evidenceCommitSha": null,
  "evidenceRefConflict": null,
  "prePublishAssetSetSha256": null,
  "postPublishAssetSetSha256": null,
  "releasePublishedAt": null
}
~~~

state只允许evidence_prepared、review_pending、evidence_index_attempted、evidence_tree_written、evidence_commit_attempted、evidence_push_attempted、evidence_committed、evidence_ref_conflict、release_publish_attempted、published_verified、abort_requested、cleanup_pending；disposition只允许continue/abort_requested。`toolchainSha256`逐字复制binding中的编排机hash且每次Git/GitHub mutation前后重验。`evidenceIndexRelativePath` 从第一态起必须非空且由候选 identity 唯一派生为 `.build/telegram-evidence-index/v<desktopVersion>/<headSha>.index`；它是 workspace-relative POSIX 路径，禁止绝对路径、`..`、反斜杠、symlink/reparse ancestor或候选外位置。evidenceFiles从第一态起就是按path bytes排序的上述5项exact set，每项exact字段只能是`path/sha256/originalBlobOid`：`sha256`记录planned raw bytes的64位小写SHA256；`originalBlobOid`记录`headSha` tree同路径原blob的40位小写Git object ID，不存在时为null，禁止把Git OID命名或解析成SHA256。tree只在write-tree后非null；`commitInputs`只在evidence_commit_attempted及之后非null；commit只在commit-tree可重算后非null；conflict对象只在evidence_ref_conflict/其abort cleanup存在；pre/post asset hash与publishedAt分别按下述publish边界变为非null。各state的null/non-null组合由strict parser逐项拒绝，不允许额外字段。

`git write-tree`成功并记录evidenceTreeSha后，runner用注入时钟只生成一次并在调用commit-tree前原子持久化下述strict `commitInputs`：

~~~json
{
  "parentSha": "40-lowercase-hex",
  "treeSha": "40-lowercase-hex",
  "message": "docs: record Telegram v1.2.3 acceptance evidence\n",
  "authorName": "Downany Release Evidence",
  "authorEmail": "release-evidence@downany.invalid",
  "authorDate": "2026-08-11T12:00:00Z",
  "committerName": "Downany Release Evidence",
  "committerEmail": "release-evidence@downany.invalid",
  "committerDate": "2026-08-11T12:00:00Z"
}
~~~

parent/tree分别必须等于marker.headSha/evidenceTreeSha；message版本等于desktopVersion且保留唯一末尾LF；两个日期必须相等、UTC整秒。重跑只能复用原object，不能读取当前clock、Git config或操作者身份；checked Git adapter把object精确映射为author/committer env与UTF-8 message bytes，保证response loss后重算同一commit SHA。

`prepare-evidence`顺序固定为：无凭据recover；先从已认证GitHub repository/default-branch API读取唯一40位`currentDefaultHeadSha`，再调用`Assert-ReleaseRepositoryBaseline -ExpectedWorkspaceHead currentDefaultHeadSha -RequireNeutralIndexFlags true`，要求返回proof的`workspaceHeadSha`逐字等于该远端SHA，并要求`marker.headSha`是其ancestor；不得在baseline API前另发Git命令读取HEAD。本地干净基线绑定当前默认分支，候选binding/tag/assets/evidence parent仍逐字绑定`marker.headSha`，两者不得混用。随后验证binding、ready ledger raw SHA、canonicalRoot四份raw bytes、same-run 4+4和live draft；用strict canonical human input在ignored containment staging确定性生成5份bytes；用scanner lease扫描staging、仓库与canonical records，绝不读取已摄取的return目录；推导并验证上述 candidate-specific index path 尚不存在且父目录无link/reparse（存在且没有同一publication marker时返回`EVIDENCE_INDEX_OWNERSHIP_LOST`，不得删除）；先把acceptance marker原子更新为`publication_handoff_prepared`并回读strict schema，以其最终raw bytes计算`sourceAcceptanceMarkerSha256`；再用该hash及固定index相对路径原子写evidence_prepared publication marker并回读；再次要求当前acceptance raw SHA精确等于successor字段，才删除未再修改的acceptance marker；最后升级publication为review_pending并返回。recover看到两marker并存时只在predecessor状态/hash精确匹配时删除predecessor；只剩publication继续；只剩publication_handoff_prepared predecessor则从相同staging与canonical records重建successor。禁止先写successor后再修改predecessor。此时Release始终draft，remote evidence ref仍不存在，独立review可安全拒绝。

上句“计算`sourceAcceptanceMarkerSha256`→写evidence_prepared publication marker”之间必须无条件插入`Read-ReleasePrepublicationCandidateTreeOwned`：以最终`publication_handoff_prepared` raw SHA、同一binding、当前WorkspaceManifestProof及五个planned path取得fresh proof，把每个path在candidate `headSha` tree中的原blob OID/null逐项写为publication `evidenceFiles[].originalBlobOid`；proof缺失、错head/path/OID、acceptance或workspace漂移时publication write调用数为零。若在handoff marker落盘后、proof读取中或successor写前强杀，recover必须从同一handoff bytes重新生成staging、重新扫描、重新取得fresh proof并写出逐字相同successor；current workspace已在v2而candidate为ancestor v1时仍只从candidate tree取OID，禁止从workspace或planned bytes推断。

prepublication fixture必须直接尝试用`evidence/baseline/formal_tag_object`或调用方自报mode执行同一`ls-tree`、交换acceptance raw SHA/binding/CandidateHead/WorkspaceManifestProof、注入`GIT_INDEX_FILE`或credential/identity env、增加任意argv，并在spawn前全部拒绝；再逐点强杀于sandbox目录创建、global.config flush、hooks创建、Git child resume/exit、session close及guarded delete之间，覆盖额外成员、ancestor link与owner SHA漂移。正确`prepublication_candidate_tree`模式的native owner必须先收敛整树与exact sandbox再由fresh invocation重建proof；proof返回及successor写前sandbox/native owner均不存在，publication/index/ODB/ref/GitHub mutation除唯一successor写入外均为零。

handoff recovery fixture还必须从`publication_handoff_prepared`落盘后开始，分别在Repository scanner启动前、scanner/Git child运行中、scanner receipt返回后、prepublication proof前后及successor rename前强杀；每次fresh invocation都只能以当刻handoff raw SHA重新跑同一Repository scan与proof，marker永不回退ready，最终successor bytes及source hash逐字相同，publication写入最多一次且其他Git/index/ODB/ref/GitHub mutation为零。

candidate index 的唯一合法 Git lock companion固定为`<evidenceIndexRelativePath>.lock`，不是任意sibling。首次publication marker创建前index与lock都必须不存在；pre-receipt marker存在后，只有该marker与对应未收敛Git operation可拥有exact lock，任何检查或删除前必须同时持runner lease、完成native operation recovery并确认旧Job/PGID整树为空，绝不能在旧git child仍活时裸删。永久publication receipt只允许在lock已确认不存在时落盘，且receipt-owned cleanup不再启动evidence Git；因此receipt落盘后出现任何同名lock都不可能属于该receipt，必须按foreign ownership fail closed、零删除并永久保留receipt供人工处理。

recover 根据 marker 与 live GitHub真相继续同一候选：evidence_prepared/review_pending只复核 staging exact bytes；evidence_index_attempted及其后各evidence commit态按 Step 8重读临时/远端对象；release_publish_attempted 若服务端已公开则转入发布后核验，仍为draft则安全重试 PATCH。任何状态都不根据本地旧 boolean猜测成功。工作树五路径从未被替换，因此不需要发布后恢复 tracked files；检测到任何对应路径相对 frozen HEAD 有改动立即 `EVIDENCE_PATH_OWNERSHIP_LOST`。

review失败使用`recover -Abort publication`：先原子写disposition/state=abort_requested，再验证remote tag完整canonical identity仍匹配publication marker的`tagObjectSha/headSha`；同HEAD异object、lightweight或missing时，若Release仍draft则零PATCH并fail closed；若exact releaseId已public，只允许先PATCH回draft并验证，随后同样保留marker、零tag/ref/Release DELETE并fail closed。身份通过后，若Release已public才PATCH回draft并验证；随后重新读取exact releaseId并要求仍为`draft=true`，把原canonical tag、该quarantine draft及现有assets作为失败证据保留，tag/ref、Release/asset DELETE与覆盖调用数永久为零。evidence ref不存在则不创建；精确指向marker commit则保留为不可变失败证据，并以ref+commit及`tagObserved=true`写abandoned/watch，绝不force-delete/覆盖；指向其他对象时按前述`evidence_ref_conflict`隔离tombstone，foreign ref mutation始终为零。live asset/evidence/hash异常走同一显式abort，不能自动销毁现场。

远端收敛后把publication原子写为`cleanup_pending`并回读，以该未再修改的raw SHA链接abandoned/watch或conflict tombstone。随后固定执行：恢复/删除属于本候选的native operation owner并确认整树为空→清candidate staging与canonical/central owner数据→若exact`<evidenceIndexRelativePath>.lock`存在则按owner guard删除→删除exact candidate index→只删除已空index目录→最后仅在publication raw SHA仍等于tombstone source hash时删除publication marker。任一local cleanup失败都保留cleanup_pending marker和tombstone供下次recover幂等继续；绝不能先删marker留下无owner index/lock。published_verified只允许最终receipt/marker cleanup，不得回滚已验证发布。

- [ ] **Step 8: 用临时 Git index 持久化远端不可变 evidence ref**

commit-evidence 不要求默认分支仍停在 tag HEAD，也不修改/推送默认分支。每次进入先从已认证GitHub repository/default-branch API读取唯一40位`currentDefaultHeadSha`，再调用`Assert-ReleaseRepositoryBaseline -ExpectedWorkspaceHead currentDefaultHeadSha -RequireNeutralIndexFlags true`并把proof的`workspaceHeadSha`固定为本次`currentHeadSha`；要求`marker.headSha`是其ancestor，且baseline API前不得另发Git命令读取HEAD。在 evidence ref push 前要求live HEAD与authenticated remote default仍等于同一`currentHeadSha`、以非null `ExpectedWorkspaceHead=currentHeadSha`再次验证同一current baseline并重验publication marker raw SHA。candidate index的read-tree/commit parent、tag/blob与五份evidence仍只绑定`marker.headSha`，绝不能把currentHeadSha写成候选parent。随后把 marker 中的 candidate-specific 相对路径解析到 workspace containment 后作为唯一 `GIT_INDEX_FILE` 执行：

所有 Git 子进程必须经同一个 owned Git adapter 创建受控环境并以toolchain中Git的canonical absolute path启动；除baseline/manifest API内部的固定发现session外，每条命令都必须通过`Invoke-CheckedGitOwned`显式携带同一个private `GitSession`，绝不能直接继承父 PowerShell/Actions 的Git定向变量或让PATH选择目标。adapter先复制必要的普通OS环境，再按 Windows 大小写不敏感、macOS逐字的规则删除**所有**键名以 `GIT_`、`GH_`或`GITHUB_`开头的变量，同时删除继承的`PATH/Path/PATHEXT`；之后只允许按命令显式回填：共同的 `GIT_TERMINAL_PROMPT=0`、`GIT_NO_REPLACE_OBJECTS=1`、钉住helper closure的绝对`GIT_EXEC_PATH`与mode-specific `GIT_OPTIONAL_LOCKS`，evidence `commit-tree`与`tooling_commit/version_preparation` workspace `commit`分别从对应marker/session持久化`commitInputs`回填六个`GIT_AUTHOR_*`/`GIT_COMMITTER_*`；`formal_tag_object`只允许前文exact三命令，`mktag`从当前raw formal marker重建canonical stdin payload，两条`cat-file`只接收同一expected SHA且stdin为空，三者都不回填任何identity变量；`formal_tag_push`只允许前文唯一push argv、stdin为空、无identity变量且不设置candidate index，并必须由同一raw formal marker与CanonicalGitHubSession/GitHubCredentialLease共同授权；GitHub credential只能由adapter转成canonical URL专用的临时Authorization config entry，绝不以GH/GITHUB环境回填。`evidence/tooling_commit/version_preparation`只按前文完整mode allowlist回填各自raw-owner marker派生的唯一`GIT_INDEX_FILE`。real baseline/status/cleanup mode 严禁回填 candidate index；baseline mode只允许回填下文固定runner-private baseline index。所有mode都不允许 `GIT_DIR/GIT_WORK_TREE/GIT_COMMON_DIR/GIT_OBJECT_DIRECTORY/GIT_ALTERNATE_OBJECT_DIRECTORIES/GIT_NAMESPACE/GIT_QUARANTINE_PATH/GIT_SHALLOW_FILE`、replace/trace/exec/askpass/SSH override 等父值复活。child的唯一PATH由toolchain `trustedPathDirectories`构造且每个目录manifest必须在spawn前后不变；Git HTTPS只允许钉住的`git-remote-https`，Node/Python/PowerShell descendant必须接收显式绝对工具路径，不能再执行裸名。每个GitSession都不可变持有互不混用的`ExpectedWorkspaceHead=WorkspaceManifestProof.workspaceHeadSha`、exact workspace byte manifest与可空`CandidateHead`：所有real/workspace identity gate及首次mutation前重验只要求`rev-parse --show-toplevel`等于冻结workspace、live `rev-parse HEAD`等于`ExpectedWorkspaceHead`且manifest bytes不变；`CandidateHead`只供tag/blob、candidate read-tree、commit parent和ancestor关系验证，绝不要求live HEAD等于它。prepare-evidence/commit-evidence/publish先用authenticated remote-default SHA作为非null `ExpectedWorkspaceHead`调用baseline API；P/R与receipt-cleanup的首次baseline discovery，以及Task17A带exact五项`AllowedInitialChangedPaths`的scoped discovery，才允许该API在同一净化session内原子捕获`ExpectedWorkspaceHead`。baseline proof返回后必须先冻结workspace manifest，再打开唯一GitSession；本次callback/phase内每个后续Git调用只接收该session，A/P/R在manifest冻结后的每个native test/build还必须传同一manifest proof，不得另开无owner Git、绕过session或继续携带null。测试在manifest返回后、每个test/build前后及diff/add/commit各边界改写同路径bytes或切换HEAD/index/config，要求后续Git mutation为零；另固定覆盖clean v2 default-branch HEAD上为ancestor v1 candidate生成并push evidence，要求workspace gate命中v2、candidate parent仍精确为v1。

上段Git adapter开头的“复制必要普通OS环境”由本句替代：它必须从唯一minimal-env builder的`ToolKind=git`空基线开始，父`GIT_/GH_/GITHUB_`、Node/Python/shell/loader/proxy/CA与PATH/PATHEXT均不存在，再只按本段和下一段的exact config/credential规则回填；spawn前后必须重验同一`environmentPolicySha256`。adapter 还必须隔离 Git config 与 hooks。candidate containment 内创建并回读一个零字节、regular non-link 的 empty global config 和一个为空、无link/reparse的 hooks目录；所有Git命令只由adapter回填 `GIT_CONFIG_NOSYSTEM=1` 与指向该文件的 `GIT_CONFIG_GLOBAL`。在任何读取或mutation前用这个已隔离system/global环境读取 effective local/worktree config，并按Git大小写规范只允许以下必要键：`core.repositoryFormatVersion/fileMode/bare/logAllRefUpdates/symlinks/ignoreCase/precomposeUnicode/worktree`、`extensions.objectFormat/refStorage/worktreeConfig`、唯一 `remote.origin.url/fetch` 与当前 `branch.<name>.remote/merge`；每个值都必须与实际canonical workspace、当前分支、已认证canonical GitHub HTTPS repository和安全布尔/格式精确匹配。除此之外任意 local/worktree 键一律拒绝，不能继续补deny-list；因此 `core.ignoreStat/fsmonitor/askPass/alternateRefsCommand/excludesFile/sparseCheckout*`、`push.gpgSign`、全部 `gpg.*`/signing、`http.*`、`include/url rewrite/pushurl/hooks/credential/proxy/protocol/filter/external driver` 都必然失败。检查结果与local/worktree config raw SHA在每个Git命令前后重验。mutation mode再通过adapter唯一生成的 `GIT_CONFIG_COUNT/KEY_n/VALUE_n` 回填空`credential.helper`、verified empty `core.hooksPath`、`core.ignoreStat=false`、`core.fsmonitor=false`、`core.untrackedCache=false`、`core.sparseCheckout=false`、`core.sparseCheckoutCone=false`、`push.gpgSign=false`、`protocol.allow=never`、`protocol.https.allow=always`；这些 exact config env和上段明确列出的变量是删除全部父`GIT_*`后的唯一例外，父进程同名值永不复用。所有push一律加`--no-verify`，双重保证pre-push hook不执行且不会启动签名后代。

隔离文件的路径固定为已由publication marker拥有的 `<candidateStaging>/git-sandbox/global.config` 与 `<candidateStaging>/git-sandbox/hooks/`；路径可由version/head确定性派生，必须通过regular/non-link/empty检查，并随同一marker或receipt的guarded staging cleanup删除，不能另造无owner临时路径。唯一prepublication例外固定为`<candidateStaging>/prepublication-git-sandbox/global.config`与同根空`hooks/`：只由state=`publication_handoff_prepared`的acceptance marker raw SHA、binding SHA、runner lease及本次native owner共同拥有，exact成员仅这一个零字节regular non-link文件与一个empty non-link目录。`Read-ReleasePrepublicationCandidateTreeOwned`创建前逐ancestor拒绝link/reparse并回读empty identity；返回proof前必须先确认Git child/bridge/guardian/target整树为空、关闭GitSession，再按raw owner guarded删除hooks/global.config/空sandbox目录并确认不存在，successor write前还要重验sandbox与native owner均不存在。父runner强杀后下一invocation只在同一acceptance raw SHA仍匹配时先收敛旧tree、再删除exact-owned成员并fresh重建；额外成员、link或owner/binding漂移均零删除且publication write为零。formal/preflight阶段尚无publication staging时使用从version/head唯一派生的preflight `git-sandbox`，由formal marker及其raw hash持有并随preflight guarded cleanup删除。Task17P/R及任何尚无phase marker的真实workspace baseline只能使用下文固定runner-private baseline sandbox；它由永久runner lease和固定路径共同拥有，不得借用candidate/preflight目录。

所有“clean index/worktree”字样只指以下唯一 `Verify-RepositoryBaseline(expectedWorkspaceHead|null, requireNeutralIndexFlags, allowedInitialChangedPaths=[])`，不得把真实index的stat cache、`git status`、`diff-files`或`ls-files --stage`单独当权威。函数必须在持runner lease、收敛旧native tree后运行，并使用固定runner-private `.build/telegram-release-baseline/` sandbox；其根exact成员只能是regular non-link `index`、可选companion `index.lock`、零字节regular non-link `global.config`和空的non-link `hooks/`目录。该固定sandbox由永久runner lease保护，Git child仍写同一native-operation owner；调用前若有exact-owned遗留，必须先确认旧native tree为空再guarded删除，任何额外成员/链接/身份不符都fail closed且零删除。每个退出路径同样先确认owned Git child已退出，再删lock/index/global.config/空hooks与空根目录。强杀后下一invocation从固定路径恢复，不能产生无owner随机index或config。`expectedWorkspaceHead=null`只允许Task17P、Task17R与permanent receipt cleanup的首次clean baseline discovery；Task17A另可在null discovery时传其固定五项`allowedInitialChangedPaths`，其他调用该数组必须为空。函数必须在同一owned session首尾两次读取唯一40位live HEAD且相等，并把它作为本次`workspaceHeadSha`返回，不能降低其余检查。prepare-evidence/commit-evidence/publish必须使用authenticated remote-default API给出的非null值，禁止null discovery。

函数先在owned session内捕获live HEAD；`expectedWorkspaceHead`非null时要求逐字相等，null时把捕获值冻结为本次`workspaceHeadSha`。随后验证真实index path为canonical git-dir/worktree containment内的regular non-link文件，并读取其raw SHA256。它把真实 `git ls-files --stage -z` 的每个stage-0 `{mode,oid,path}` 与 `git ls-tree -r -z workspaceHeadSha` 精确比较，拒绝unmerged/额外/缺失/不同项；因此Task17A允许的初始变更也必须全为unstaged/untracked，不能预先污染index。`requireNeutralIndexFlags=true`时再分别解析 `git ls-files -v -z`、`-t -z` 与 `-f -z`，拒绝任意 assume-unchanged、skip-worktree或fsmonitor-valid条目。随后只对固定baseline index设置`GIT_INDEX_FILE`，以隔离config执行 `read-tree workspaceHeadSha → update-index -q --really-refresh → diff-files --name-only -z --ignore-submodules=none → ls-files --others --exclude-standard -z`；`-q`只允许合法tracked变更产生的`needs update`不提前终止，其他refresh错误仍失败，最终权威判断始终是后续path+manifest门禁。把modified与untracked路径做canonical ordinal去重后要求逐字等于sorted `allowedInitialChangedPaths`，默认空数组即要求工作树全净。非空时还要对每项canonical containment逐ancestor拒绝link/reparse，以no-follow handle读取regular file、size与raw SHA256，形成sorted `initialChangedManifest`；读前后stable ID/size/SHA必须一致。`$GIT_COMMON_DIR/info/exclude`只允许空白/注释行，global excludes与sparse/fsmonitor/ignoreStat配置已由allowlist拒绝，因此不能隐藏文件。最后重读HEAD、real index raw SHA、stage entries、local/worktree config raw SHA及initial manifest，全部必须不变且HEAD仍等于`workspaceHeadSha`，再返回上述exact proof。candidate head完全不参与本函数的live workspace比较。正式freeze/automation/secret-audit/formal-run/prepare-evidence/commit-evidence/publish固定传true且allowed数组为空；Task17A固定true+exact五项；receipt cleanup固定false+空数组以不破坏后来版本的用户flags，但仍用fresh baseline证明当前worktree内容干净并捕获flags原始输出供前后等值比较。fixture必须证明一个允许的tracked文件变更可成功产出manifest，而任一额外tracked或untracked路径仍失败。

formal tag push与evidence push都不得使用裸`origin`。canonical URL只从经`CanonicalGitHubSession`认证并与当前raw owner marker.repository一致的`owner/repo`派生为`https://github.com/<owner>/<repo>.git`，并在push前后用该session的显式`github.com` API与repository metadata复核身份。`GitHubCredentialLease`只通过owned、无日志的`gh auth token --hostname github.com`取得；Git push child只在额外config entry中为该canonical HTTPS URL设置Authorization header。token/header不得进入argv、native owner、marker、receipt、stdout/stderr，child整树退出后finally清零。两种push命令都显式使用canonical URL；缺lease、父GH/GITHUB环境未清、GitHub metadata不一致、local Git config危险项、URL/identity不一致或empty config/hooks ownership异常都在ref mutation前fail closed。

上文Git adapter的remote-ref mutation allowlist以此处为最终完整集合：candidate release tag只允许`formal_tag_push`以canonical object refspec创建一次；evidence ref只允许`evidence` session在`state=evidence_push_attempted`以`push --no-verify <canonicalHttpsRepositoryUrl> <evidenceCommitSha>:refs/tags/downany-evidence/v<desktopVersion>`创建或确认同一commit。两者都必须绑定各自当前raw marker、fresh CanonicalGitHubSession与fresh GitHubCredentialLease，不设置错误mode的`GIT_INDEX_FILE`、不接受stdin或额外identity来源；candidate tag进入tag_push_attempted后的cleanup以及evidence ref冲突/abort均没有删除、覆盖、force或第二种refspec。`StandardInputBytes`完整allowlist只以本节前文三种case为准：formal mktag、evidence hash-object与evidence commit-tree；formal与evidence的所有`cat-file`及两种push都必须缺省stdin。任何mode交叉、无fresh owner/session/lease、REST ref DELETE、裸`--delete`、删除refspec、force覆盖、wrong candidate/evidence ref或foreign ref mutation都在spawn前失败。

`evidence` GitSession 的本地/远端命令集以本段为唯一完整allowlist，generic caller不能传任意Git argv。所有已存在完整candidate index的状态（`evidence_tree_written/evidence_commit_attempted/evidence_push_attempted/evidence_committed/evidence_ref_conflict/release_publish_attempted/published_verified`）每次fresh invocation或进入state-specific动作前，都必须先由`Read-ReleaseCandidateTreeManifestOwned`执行唯一`ls-tree -r -z <CandidateHead>`取得fresh `CandidateTreeManifestProof`，由它、current marker与5个recomputed planned blob OID派生fresh `ExpectedIndexManifest`，再把proof传给唯一`ls-files --stage -z`的adapter-private NUL parser；完整stage-0 manifest逐项相等、lock不存在且index raw SHA在本次preflight前后不变后才可继续。该later-state只读preflight禁止`diff/read-tree/update-index/write-tree`、ODB写入或ref mutation，proof/raw NUL bytes同样不出private buffer。

`state=evidence_index_attempted`只允许依次执行：先由`Read-ReleaseCandidateTreeManifestOwned`执行唯一`ls-tree -r -z <CandidateHead>`并取得绑定同一session/current publication raw SHA/headSha的fresh `CandidateTreeManifestProof`；再执行一次`read-tree <headSha>`；随后对按UTF-8 path bytes排序的每个`evidenceFiles`元素恰好一次`hash-object -w --stdin`和一次`update-index --add --cacheinfo 100644,<recomputedBlobOid>,<repo-relative-path>`；再仅从该proof、current marker与5个recomputed blob OID构造一次性`ExpectedIndexManifest`，把它逐字传给`diff --cached --name-only -z --no-renames <headSha>`与`ls-files --stage -z`的adapter-private NUL parser（两条都不返回StdoutLines），验证通过后执行一次`write-tree`。helper从marker唯一派生staging path并逐ancestor拒绝link/reparse，以no-follow handle读取planned bytes；Git blob OID必须在spawn前按repository object format从raw bytes重算，hash-object返回值逐字相等后才允许对应cacheinfo，mode固定100644，path/OID/order任一差异在index mutation前失败。diff的NUL集合必须恰为5项，完整stage-0 manifest必须逐项等于proof绑定的CandidateHead tree仅以5个expected blob替换后的结果，且unmerged/额外entry为零；live workspace tree、candidate index自身输出或调用方自报清单都不能构造该expected manifest。StagedOnly scanner通过后才允许write-tree，stdout必须恰为一个40位tree SHA。完成上述shared later-state preflight后，`state=evidence_commit_attempted`才允许以本段前文exact stdin执行唯一`commit-tree <evidenceTreeSha> -p <headSha>`，`state=evidence_push_attempted`才允许前文唯一evidence push；`evidence_committed/evidence_ref_conflict/release_publish_attempted/published_verified`只继续各自remote truth/cleanup合同，不再允许本地evidence Git mutation。每条命令前后都重验publication raw SHA、WorkspaceManifestProof、candidate index path/lock、native owner与toolchain/config/env；除上述state-specific private `ls-tree/ls-files`及本段逐项列出的命令外，所有evidence argv、pathspec、filter、attributes、shell或工作树add都在spawn前拒绝。

为覆盖dangling ODB被正常maintenance/prune清理，同一API目录唯一增加runner-private `Ensure-ReleaseEvidenceObjectsOwned -Toolchain <resolved> -PublicationMarkerSha256 <current-raw-sha> [-EvidenceRemoteMissingProof <private-current-session-proof>]`，返回exact `{State:"verified",TreeSha:<40-lowercase-hex>,CommitSha:<40-lowercase-hex|null>}`。它只接受`evidence_tree_written/evidence_commit_attempted/evidence_push_attempted`：ordinary response-loss可复用仍存活的本次evidence session，但父runner hard-kill后的fresh invocation必须先收敛旧tree，再建立fresh baseline/workspace manifest/evidence session，调用`Read-ReleaseCandidateTreeManifestOwned`取得fresh CandidateTree proof并由它派生fresh ExpectedIndexManifest，以private `ls-files --stage -z`确认candidate index无lock且完整stage manifest精确；旧proof、marker自报original blob或index自身输出都不能替代该验证。通过后才按sorted 5个expected blob OID、marker tree SHA及可用时的重算commit SHA执行只读`cat-file -t <expectedSha>`；存在时type必须分别为blob/tree/commit，missing时才允许用同一private evidence session重跑对应`hash-object -w --stdin`、`write-tree`或`commit-tree <tree> -p <head>`并要求返回原expected SHA，绝不执行read-tree/update-index或修改marker/index/ref。push态必须额外持有本次fresh CanonicalGitHubSession产生、绑定同一publication raw SHA/repository/evidenceRef且证明remote missing的private `EvidenceRemoteMissingProof`；其他两态禁止该参数。任何existing wrong type、staging/index/marker/proof漂移或不同SHA都fail closed。

~~~text
原子记录 state=evidence_index_attempted，其他新状态字段仍为null
用private `ls-tree -r -z <headSha>`读取并验证完整CandidateHead tree，取得fresh CandidateTreeManifestProof
git read-tree <headSha>
按path bytes排序逐项no-follow读取planned bytes，git hash-object -w --stdin
逐项git update-index --add --cacheinfo 100644,<recomputedBlobOid>,<repo-relative-path>
仅从CandidateTreeManifestProof与5个recomputed blob OID派生ExpectedIndexManifest；验证NUL diff恰好5个路径且完整stage-0 manifest精确
用StagedOnly scanner验证该exact index，扫描前后index raw SHA/stage manifest不变
git write-tree
原子记录 evidenceTreeSha 与 state=evidence_tree_written
原子记录固定 commit inputs 与 state=evidence_commit_attempted
git commit-tree <tree> -p <headSha>，stdin为commitInputs.message exact bytes
原子记录 evidenceCommitSha 与 state=evidence_push_attempted
git push --no-verify <canonicalHttpsRepositoryUrl> <evidenceCommitSha>:refs/tags/downany-evidence/v<desktopVersion>
~~~

第一次进入时只允许candidate index与exact`.lock` companion都不存在；从`review_pending`进入commit-evidence时必须先原子写/回读`state=evidence_index_attempted`，其余tree/commit/conflict/publish字段仍保持该态要求的null，再由runner创建已验证父目录，再把不存在的固定index路径交给owned Git adapter执行`read-tree <headSha>`，不能先创建空index。本Step initial evidence mutation adapter中每条使用`GIT_INDEX_FILE`的Git mutation都要求：phase marker已是对应attempted态、native owner的`operationKind=git`且`sourceMarkerSha256`等于publication raw SHA、target已在ProcessHost整树内resume。只有三个exact非initial-mutation分支：①同一index已按planned manifest完整写入、仍处于`state=evidence_index_attempted`时执行StagedOnly秘密扫描，必须走`Invoke-ReleaseSecretScannerOwned`，native owner固定`operationKind=scanner/sourceMarkerSha256=<current publication raw SHA>/scannerGitEnvironmentPolicySha256=<nonnull>`，只允许前文exact只读argv，index raw SHA/stage manifest前后相等；②`Ensure-ReleaseEvidenceObjectsOwned`在`evidence_tree_written/evidence_commit_attempted/evidence_push_attempted`只为读取exact index并按前文content-addressed规则ensure ODB object，native owner固定`operationKind=git/sourceMarkerSha256=<current publication raw SHA>`，index raw SHA/stage manifest前后逐字不变，严禁read-tree/update-index/ref mutation；③`evidence_tree_written/evidence_commit_attempted/evidence_push_attempted/evidence_committed/evidence_ref_conflict/release_publish_attempted/published_verified`的fresh later-state index preflight，native owner固定`operationKind=git/sourceMarkerSha256=<current publication raw SHA>`，只允许前文exact private `ls-tree -r -z <CandidateHead>`与携带fresh ExpectedIndexManifest的`ls-files --stage -z`，index/ODB/ref mutation为零且index raw SHA前后相等。所有命令settle后都先确认整树为空，再检查`.lock`已消失；scanner、ensure与later-state preflight都绝不提升publication状态，只有initial evidence mutation命令才在对应真值确认后推进状态。

marker存在后的index恢复必须按state分支，不能把已完成tree的后续态退回或重写。`evidence_prepared/review_pending`要求candidate index与lock仍都不存在。`evidence_index_attempted`先持runner lease、收敛旧native tree并确认整树为空，再验证index与lock位于marker派生的同一regular non-link目录：index可缺失或为该scratch owner的regular non-link，lock可缺失或为exact`<index>.lock`；此态只在raw publication owner仍匹配时guarded删除exact lock与可能的partial index，随后从不存在的固定path重新执行owned `read-tree <headSha>`、按sorted 5项重跑exact hash-object/cacheinfo、完整stage验证、StagedOnly scan与write-tree，最后才原子写`evidenceTreeSha/state=evidence_tree_written`。`evidence_tree_written/evidence_commit_attempted/evidence_push_attempted/evidence_committed/evidence_ref_conflict/release_publish_attempted/published_verified`严禁再执行read-tree/update-index或改变index：它们要求lock不存在、index为regular non-link且完整stage-0 manifest仍精确等于已验证tree；前三态仅在index/staging/marker全匹配且expected ODB object确实missing时可走`Ensure-ReleaseEvidenceObjectsOwned`重建同SHA的content-addressed blob/tree/commit，`evidence_push_attempted`还必须先持fresh remote-missing proof。`evidence_committed`及以后只按remote truth验证且不再本地重建；index缺失、内容漂移、lock出现、existing wrong type/SHA或remote歧义均fail closed，不以重建掩盖外部变化。`abort_requested/cleanup_pending`只走后文guarded cleanup，不运行Git mutation。所有分支都拒绝额外sibling、link/reparse、越界、live旧tree或identity不符；只有`evidence_index_attempted`允许上述scratch index/lock的guarded删除与确定性重建，其他state零删除直到显式cleanup。

上句`evidence_index_attempted`的首次进入与每次恢复都必须在candidate index仍不存在、任何`read-tree/update-index`之前，通过fresh evidence GitSession重新调用`Read-ReleaseCandidateTreeManifestOwned`并持有fresh `CandidateTreeManifestProof`直到完整stage验证结束；恢复不得复用强杀前proof、当前workspace tree、partial index或marker中没有记录的推断值。fixture至少覆盖workspace处于v2而CandidateHead为ancestor v1、五个planned path分别在HEAD中存在与不存在、marker `originalBlobOid`正确40位OID/null及错OID/错null、`ls-tree` NUL输出的duplicate/truncated/错mode/错type/非法path、proof跨session/marker交换、取得proof后candidate tree OID不变但workspace HEAD切换，以及每个hash/cacheinfo边界强杀；所有错proof/错tree必须在index mutation、scanner、write-tree、commit与remote push均为零时fail closed。

从`evidence_tree_written`至尚未写入有效receipt的`published_verified`，每次新invocation都必须在任何Ensure、remote query/PATCH或receipt提交动作前，以current raw publication marker建立fresh evidence session，重新取得fresh CandidateTree proof、派生fresh ExpectedIndexManifest并通过private `ls-files --stage -z`逐项验证已有index；index只可读且raw SHA前后不变。有效receipt落盘后的cleanup明确不属于本分支，只走Step 9 receipt owner。fixture对上述每个pre-receipt state分别覆盖父runner强杀后旧proof消失、fresh proof成功恢复、candidate index单项foreign OID/mode/path/额外entry、正常prune掉blob/tree/commit，以及workspace已前进但CandidateHead不变；任何pre-receipt later-state index/proof不符都要求Ensure/GitHub query/tag或evidence ref mutation/PATCH/receipt为零并保留marker供审计。

`git write-tree`成功返回且整树空后才能持久化tree SHA；随后先写exact commitInputs/evidence_commit_attempted，再调用owned`commit-tree`，固定inputs使响应丢失重算同SHA。push同样先写evidence_push_attempted与native intent，不使用force；旧tree收敛后才经authenticated GitHub refs API读真相：ref不存在时必须取得绑定本次publication raw SHA/evidenceRef的fresh EvidenceRemoteMissingProof，以fresh evidence session执行`Ensure-ReleaseEvidenceObjectsOwned`确认或重建相同blob/tree/commit后才可重试同一push；同commit成功，其他对象记录evidence_ref_conflict并只走显式abort/tombstone。远端候选commit只有headSha一个parent，tree diff及5 path/blob hash与marker完全相等后才升级evidence_committed。默认分支前进不影响不变`refs/tags/downany-evidence/v<desktopVersion>`。

commit-tree response loss只留下不可达orphan并可按固定inputs重算；强杀后正常maintenance/prune清掉任一dangling blob/tree/commit时只经上述ensure重建同SHA；push response loss且远端相同视为成功。parent/tree/blob任一不符都不得清marker。canonical live asset set精确等于input.assets四项，元素字段顺序固定为`role/releaseAssetId/fileName/size/sha256`、数组按role排序；`assetSetSha256`是其compact UTF-8 JSON bytes的SHA256。

`publish`每次进入或恢复都必须重做完整pre-PATCH gate，不能信任旧成功位：先从已认证GitHub repository/default-branch API读取唯一40位`currentDefaultHeadSha`，再调用`Assert-ReleaseRepositoryBaseline -ExpectedWorkspaceHead currentDefaultHeadSha -RequireNeutralIndexFlags true`并把proof的`workspaceHeadSha`固定为本次`currentHeadSha`；要求`marker.headSha`是其ancestor，baseline API前不得另发Git命令读取HEAD。再验证marker=evidence_committed、live draft identity、remote canonical tag object SHA/payload/direct target/peel全量身份、evidence ref/commit/tree/blob，所有候选真值仍绑定marker.headSha而非currentHeadSha；分页读取releaseId live assets，要求exact四项且每项ID/name/size/state=uploaded与input一致；再按每个releaseAssetId下载到随机containment，逐字节验证size/SHA并fail-closed清理。canonical hash必须等于input asset set hash；PATCH前再次要求authenticated remote default仍等于同一currentHeadSha，并以非null `ExpectedWorkspaceHead=currentHeadSha`重跑current baseline，随后原子记录`prePublishAssetSetSha256`与state=release_publish_attempted，才立即PATCH。pre-PATCH任一同名同大小不同bytes、默认分支漂移或下载失败时PATCH调用数必须为零。

PATCH response loss只以live Release判断：draft则可重试；一旦public，重新分页并按同一四个asset ID重新下载，重复exact set/size/SHA验证。post hash必须同时等于pre hash与input hash，才能记录`postPublishAssetSetSha256/releasePublishedAt`并进入published_verified。PATCH后若任何byte不符，先写abort_requested，立即PATCH回draft并验证，再走显式publication abort，绝不能输出完成。不得只依赖name/size、GitHub可选digest或验收期旧下载。

published_verified marker不再修改，且在Step 9永久receipt落盘前始终保留作为恢复锚点。Step 9最后写入的永久ignored receipt `.build/telegram-publication-receipts/v<desktopVersion>-<headSha>.json`把该marker的raw SHA作为source绑定，strict DTO为：

~~~json
{
  "schemaVersion": 1,
  "state": "published_verified",
  "repository": "owner/repo",
  "tag": "v1.2.3",
  "tagObjectSha": "40-lowercase-hex",
  "tagDirectTargetSha": "40-lowercase-hex",
  "tagPeeledCommitSha": "40-lowercase-hex",
  "headSha": "40-lowercase-hex",
  "toolchainSha256": "64-lowercase-hex",
  "desktopVersion": "1.2.3",
  "runId": "decimal-string",
  "runAttempt": 1,
  "releaseId": "decimal-string",
  "bindingSha256": "64-lowercase-hex",
  "inputManifestSha256": "64-lowercase-hex",
  "acceptanceStateSha256": "64-lowercase-hex",
  "automationReceiptSha256": "64-lowercase-hex",
  "secretAuditReceiptSha256": "64-lowercase-hex",
  "evidenceRef": "refs/tags/downany-evidence/v1.2.3",
  "evidenceCommitSha": "40-lowercase-hex",
  "evidenceIndexRelativePath": ".build/telegram-evidence-index/v1.2.3/40-lowercase-head-sha.index",
  "evidenceIndexSha256": "64-lowercase-hex",
  "prePublishAssetSetSha256": "64-lowercase-hex",
  "postPublishAssetSetSha256": "64-lowercase-hex",
  "releasePublishedAt": "2026-08-11T12:00:00Z",
  "sourcePublicationMarkerSha256": "64-lowercase-hex"
}
~~~

Step 8至此只把publication marker稳定在published_verified，不写永久receipt，也不删除staging、临时index、marker或验收输入；任意强杀都从该marker进入Step 9。receipt的`toolchainSha256`逐字复制marker/binding，`tagObjectSha`逐字复制publication marker/binding；Step 9写receipt前必须重新调用`Assert-CanonicalTagIdentityOwned`，并把已验证且都等于`headSha`的direct target与recursive peel分别写入`tagDirectTargetSha/tagPeeledCommitSha`。receipt不进入evidence commit，因此无commit-hash自引用。任一步未验证不得声称发布完成。

Step 9写receipt前还必须在上述fresh CandidateTree/ExpectedIndex proof已通过且candidate index无lock时，以no-follow handle读取index，固定其stable ID/size/raw SHA256，前后回读不变后把raw hash写入`evidenceIndexSha256`；receipt其余字段、远端真相与publication raw SHA也必须在同一runner lease内再次重验。该hash只用于receipt提交点后的本地owner guard，不改变Git object或远端evidence身份。

- [ ] **Step 9: 复核 tag 前自动化凭证，发布后不再补跑首轮门禁**

完整Python、Electron、extension、packaging与runner fake-adapter回归只能由tag前`automation`阶段运行，并由automation receipt绑定frozen HEAD；`secret-audit`随后生成第二份receipt，`formal-run`必须重验两者才可创建tag。发布后本步骤不再运行“首次决定是否可发布”的测试；它先从published_verified marker、formal binding与两份preflight raw bytes重验SHA/identity，再重验remote evidence ref commit、live public Release与四资产bytes，全部通过后才以同目录随机临时文件、flush、原子rename写入上述publication receipt并回读strict schema/raw SHA。receipt中的`acceptanceStateSha256`必须逐字复制最终ledger raw SHA，`evidenceIndexRelativePath`必须逐字复制marker并重新通过候选identity派生检查。receipt落盘是Step 9的唯一持久提交点：落盘前强杀必须保留marker与全部输入后重做复核；落盘后强杀由recover重验receipt与remote truth，再逐项幂等清理。

recover一旦发现该候选有效receipt，必须先以strict parser、remote tag/evidence/public Release/assets、`sourcePublicationMarkerSha256`（marker存在时）及receipt自身raw bytes重验它，再直接建立receipt-owned cleanup context；不得因为source publication marker尚存在而退回pre-receipt `published_verified`分支。marker或任一待清文件缺失均表示对应delete已完成；存在则只能按receipt中的独立raw-owner字段清理，任一hash/identity不符只跳过该对象并保留receipt，不得改写陌生候选。

永久receipt可以跨后续版本长期存在，因此每个删除都有独立raw-owner guard，不能把固定中央路径当作当前候选：只有当前`.build/telegram-publication.json` raw SHA精确等于receipt的`sourcePublicationMarkerSha256`才删除；central binding/input/ledger分别只有raw SHA精确等于receipt的`bindingSha256`/`inputManifestSha256`/`acceptanceStateSha256`才删除。任何固定路径缺失视为已完成，存在但hash不同则属于另一候选并跳过。candidate staging、preflight与canonical records只从receipt的desktopVersion/headSha推导contained目录；删除前拒绝symlink/reparse并验证identity/manifest。

receipt-owned candidate index同样是独立对象：路径必须逐字等于receipt `evidenceIndexRelativePath`重新派生的contained canonical path，且exact`.lock`必须不存在；lock存在即foreign ownership，全部receipt cleanup mutation为零并保留receipt。index缺失视为已完成，存在时必须是regular non-link，且以no-follow读取的stable ID/size/raw SHA在删除前后置检查之间不变并逐字等于`evidenceIndexSha256`，否则零删除并保留receipt。publication marker、candidate index、staging与中央输入的清理顺序不得互相作为成功前提，因此任一合法delete边界强杀后都能只凭receipt逐项继续。

处理每份receipt前，在持runner lease且native owner已收敛后调用`Assert-ReleaseRepositoryBaseline -ExpectedWorkspaceHead null -RequireNeutralIndexFlags false`，只从其内存proof取得`currentHeadSha=workspaceHeadSha`；不得在该API前另发`git rev-parse`。随后用非null `ExpectedWorkspaceHead=currentHeadSha`的real mode owned read-only Git adapter固定记录真实index raw SHA256、`git ls-files --stage/-v/-t/-f -z`四份raw SHA与local/worktree config raw SHA。父环境全部 `GIT_*` 已先删除，除baseline函数自己的固定临时index外绝不设置`GIT_INDEX_FILE`。receipt.headSha只用于验证旧版本remote evidence/tag与派生自身candidate路径，绝不作为当前worktree baseline。

临时index只按receipt的`evidenceIndexRelativePath`定位：先收敛同candidate native owner并确认整树空；exact`<index>.lock`必须不存在，任何同名lock（无论regular、link或内容）都视为receipt落盘后的foreign对象并使本次全部cleanup mutation为零，绝不删除。lock不存在时，index缺失视为已完成；index存在则只允许在no-follow读取与删除前复核都命中receipt `evidenceIndexSha256`及同一stable ID后删除对应regular non-link index，然后删空父目录。identity/hash不符、额外sibling、link/reparse、越界或live tree时fail closed且零删除。全部guarded cleanup后再次调用 `Verify-RepositoryBaseline(currentHeadSha,false)`，并要求HEAD、真实index raw SHA、四份stage/flag raw SHA及local/worktree config raw SHA都逐字等于入口值。receipt/permanent watch永不删除。测试长期保留v1 receipt，把repo切到已提交clean v2 HEAD，并分别放v2 awaiting/ready/publication central bytes/marker/index；重放v1 cleanup时当前HEAD/real index/worktree及全部flags前后相等、v2 bytes零改写、v1缺失项幂等。另覆盖receipt落盘后`index已删/marker尚在`、`marker已删/index尚在`、foreign exact index.lock、同路径foreign index bytes、foreign sibling、live旧git tree，以及receipt/index/read-tree/write-tree/commit-tree/push和每个合法delete边界hard kill；receipt后exact lock存在时所有delete调用数必须为零。每个合法窗口都必须只凭receipt继续，绝不回到CandidateTree proof分支。此后验收者立即吊销真实Token。额外自动化断言：无凭据阶段在NonInteractive下不调用Read-Host；需要凭据阶段误带NonInteractive在mutation前返回INTERACTIVE_REQUIRED；credential provider各失败/成功都清环境与临时内存；generate不碰中央ledger、ingest冲突fail closed；任何输出、marker、report、Git blob不含真实值/编码值/PID/chat ID/本地绝对路径。

fake-adapter还必须覆盖：binding/input缺/额外字段、重复/乱序/未知role、错fileName、跨run artifact ID、跨release asset ID均零mutation；acceptance final写后、publication写后、predecessor删后逐点强杀都以raw hash只留下successor；commitInputs写后推进fake clock并丢commit-tree response仍重算同SHA；abandoned/watch的evidence ref/commit nullness与conflict互斥；foreign ref冲突显式abort成功且foreign mutation为零、Task17R可用更高版本；五evidence拒绝commit/tree SHA，主JSON与永久receipt都必须含exact `tagObjectSha/tagDirectTargetSha/tagPeeledCommitSha`且逐字段匹配binding与live canonical tag identity，缺失、额外、同HEAD异tag object、错误direct target或错误peel均失败；receipt外部绑定commit且publish重跑幂等；pre-PATCH同名同大小异bytes时PATCH=0，post-PATCH bytes变化时恢复draft且不完成；prepare_tag/tag_object_written abort零abandoned/watch可复用版本且本地tag ref/lock永远为零，tag_push_attempted后必须abandoned/升版并永久保留canonical tag；platform report拒绝旧secretAudit字符串、跨artifact receipt和不完整树。formal/acceptance/publication三种abort、mktag/push/PATCH/evidence ref每个response-loss与hard-kill边界均可恢复；object/push child已退出而父runner尚未读真值时强杀，下一invocation必须使用fresh proof/session/credential lease。fixture必须把matching run卡在workflow已通过canonical tag验证、`gh release create`尚未发出时触发formal abort，断言cancel与terminal确认先完成，随后tag/ref mutation仍为零且run不能在cleanup制造missing-tag重建；另覆盖push response loss下watch的`tagObserved=false + missing`、late canonical出现后单向升级true、true后missing、lightweight、同HEAD异annotated object与任意foreign SHA，后三类均保留raw owner并fail closed。Release fixture必须把draft在最终GET后切换为public、替换release ID、创建第二个matching Release并注入所有tag/ref/Release/asset DELETE与覆盖端点；post-push runner在任何路径都必须保持这些调用计数为零，formal/acceptance abort只接受保留canonical tag与零项或唯一draft，publication只允许按既有授权PATCH回draft后保留，watch对null→唯一releaseId与false→true tagObserved分别只单向绑定一次，严格更高版本仍可freeze。

publication receipt strict fixture还必须单独覆盖`evidenceIndexSha256`缺失、额外、非64位小写hex、与落盘index raw bytes不符，以及receipt落盘后marker/index按两种相反顺序逐项删除并在每个边界强杀；错误hash或receipt后出现exact lock时candidate index、publication marker及其他cleanup对象都零删除，正确hash且lock不存在时任一已缺失对象均幂等跳过并最终只保留永久receipt/watch。

再用真实临时仓库与父进程污染环境逐项注入替代 `GIT_INDEX_FILE`、foreign `GIT_DIR/GIT_WORK_TREE`、外部 object/alternate、`GIT_CONFIG_COUNT/KEY_0/VALUE_0`、replace ref、trace/exec/askpass/SSH override；real mode 的 HEAD/真实index/fresh-baseline结果必须仍来自canonical workspace，evidence mode只能触碰marker派生index，push仍只作用于已认证的canonical repository URL。foreign repo/index/object与sentinel必须零读取后的mutation、零删除；任一变量在child环境残留或首次identity不符都须在任何read-tree/write-tree/commit-tree/push/API mutation前失败。

同一fixture还要分别把system/global/local/worktree config写入任一allowlist外键，包括`remote.origin.pushurl`、长短前缀`url.*.insteadOf/pushInsteadOf`、include、hooksPath+可执行pre-push sentinel、`core.ignoreStat/fsmonitor/askPass/alternateRefsCommand/excludesFile/sparseCheckout*`、`push.gpgSign/gpg.*`执行型 sentinel、credential helper，以及 `http.*` header/cookie/TLS 配置与proxy/protocol/filter/driver；system/global必须因隔离完全不可见，本地/worktree未知键必须被拒绝，所有 sentinel为0。再分别把真实index条目标成assume-unchanged、skip-worktree、fsmonitor-valid并修改tracked runner/scanner/build源码；`Verify-RepositoryBaseline(...,true)`必须失败且tag/Release/evidence/delete mutation全为0。正常路径断言push argv只有`--no-verify`、canonical HTTPS URL与exact refspec，child Git config只含adapter白名单；每个GitHub child的argv/env/API base/repository metadata都精确命中`github.com`与marker repository，candidate empty `GH_CONFIG_DIR`外无配置读取。GitHub credential lease在成功、认证失败、API redirect、foreign metadata、push response loss、hard-kill六路都清零且日志/owner-state零secret。

最终复核恢复测试逐点覆盖publication receipt原子rename前/后强杀，以及按上述owner guard删除staging、candidate-specific index、marker、central binding/input/ledger、canonical records和preflight目录每一边界；receipt前必须重做全量复核，receipt后只幂等继续清理且永不删除receipt/watch。index path在marker/receipt round-trip后相同。所有index边界同时覆盖不存在、仅index、index+exact lock、index+foreign sibling：pre-receipt exact lock只有current publication marker/raw native owner匹配且旧native tree确认为空时可guarded删除；receipt落盘时必须无lock，之后出现exact lock一律foreign并使全部cleanup零mutation。真实临时Git在read-tree、每个sorted evidence file的hash-object/cacheinfo、StagedOnly scanner、write-tree、commit-tree与push target运行时分别强杀父runner并立即recover；另逐项注入staging link/swap、wrong raw SHA/blob OID/mode/path/order、filter/attributes与额外index entry，并在evidence_tree_written/evidence_commit_attempted/evidence_push_attempted后分别prune一个blob、tree或commit，要求fresh ensure只重建同SHA且index/ref/marker零改写，必须先令旧bridge/guardian/target/member PID exact set归零，再按所属pre-receipt owner处理lock或读remote truth；树归零前late sentinel与第二次Git mutation均为零。

- [ ] **Step 10: 最终验证，不在本任务提交工作树文件**

Task 17B 不执行 `git add`、`git commit` 或默认分支 push。五份证据的权威载体是已验证的 `refs/tags/downany-evidence/v<desktopVersion>`；Step 9成功后上述恢复流已用publication receipt作为提交点幂等清理central binding/input/ledger、candidate canonical records与preflight目录，并再次重验receipt与remote truth。publish成功后本地index/worktree仍等于invocation当前clean HEAD；`.build`只保留永久零字节`telegram-release-runner.lock`、当前平台private `telegram-release-toolchain/<platform>.json`、permanent watch、publication receipt与审计所需非秘密记录，native operation owner/generated bridge/candidate index与lock/staging/central输入/credential environment全部不存在。toolchain lock永不由candidate cleanup删除；只有操作者通过`Initialize-ReleaseToolchain`取得同一永久runner lease、先收敛native owner/旧树并在锁内重验无active marker后才可显式重新初始化，版本/路径变更会产生新hash并只能用于下一次freeze。若要把相同bytes合入默认分支，另开普通PR并逐hash证明与evidence ref相同；该PR不属于发布事务，也不得改变已发布evidence ref。

上句“审计所需非秘密记录”明确包括永久`telegram-release-tooling-commit-receipts/`与`telegram-release-version-preparation-receipts/`；Task17B只读验证，不删除、改写或把它们混作候选publication receipt。

最终主evidence JSON必须用exact字段`tagObjectSha/tagDirectTargetSha/tagPeeledCommitSha`记录同一run的4个客户资产、4个audit report、三个acceptance report、live public release ID、canonical tag object、其direct/peeled target commit与evidence ref名称，但不记录其所在commit SHA；`tagObjectSha`必须等于binding/publication receipt，后两个字段必须等于`headSha`与receipt同名字段。runner在evidence tree外从publication receipt读取commit SHA，重新解析remote ref并要求完全相等，再下载/读取四资产逐字节复核，才输出固定`TELEGRAM_RELEASE_ACCEPTANCE_COMPLETE`；不打印路径或秘密。

---

### Task 17R: 放弃候选后的版本恢复

**Files（仅在存在 canonical abandoned marker 时执行）:**
- Modify: `desktop/package.json`
- Modify: `desktop/package-lock.json`
- Modify: `browser-extension/manifest.json`
- Read only: `scripts/run_telegram_release_bootstrap.ps1`
- Read only: `scripts/run_telegram_release_acceptance.ps1`
- Read only: `scripts/prepare_telegram_release_versions.mjs`
- Read only: `scripts/tests/telegramReleaseVersions.test.mjs`
- Read only: `.build/telegram-release-abandoned.json`

- [ ] **Step 1: 先确认 abandoned/watch 恢复合同**

先运行`-Step recover`，要求canonical abandoned strict schema有效、active marker为零、matching tag/run均按watch收敛，Release集合只能为零项或watch记录的唯一`draft=true` quarantine draft；`tagObserved=false`只接受remote missing或在本次recover先单向升级为true的完整canonical tag，`tagObserved=true`则必须仍为同一canonical object。保留canonical tag与该draft都是已收敛的隔离证据，不得手工DELETE伪装候选从未存在。若abandoned的evidenceRef/evidenceCommitSha非null，只允许remote ref等于该commit并永久保留；若evidenceRefConflictSha256非null，只验证对应foreign-ref tombstone raw hash/linkage，绝不查询后要求foreign ref不变，更不得操作它。其他身份歧义停止。不得删除/覆盖旧tag或复用旧版本。

- [ ] **Step 2: 用单一 fail-fast block 收敛、准备、测试并提交两个独立新版本**

~~~powershell
param(
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedBootstrapSha256,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedRunnerSha256,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedPrivateLockSha256,
    [Parameter(Mandatory)][string]$ExpectedWorkspaceRoot
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$PlatformName = if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) { 'windows-x64' } else { 'macos-arm64' }
$CanonicalWorkspaceRoot = [IO.Path]::GetFullPath($ExpectedWorkspaceRoot)
$BootstrapPath = [IO.Path]::GetFullPath([IO.Path]::Combine($CanonicalWorkspaceRoot, 'scripts', 'run_telegram_release_bootstrap.ps1'))
$BootstrapBytes = [IO.File]::ReadAllBytes($BootstrapPath)
$Hasher = [Security.Cryptography.SHA256]::Create()
try { $BootstrapActualSha256 = ([BitConverter]::ToString($Hasher.ComputeHash($BootstrapBytes))).Replace('-', '').ToLowerInvariant() } finally { $Hasher.Dispose() }
if ($BootstrapActualSha256 -cne $ExpectedBootstrapSha256) { throw 'RELEASE_BOOTSTRAP_IDENTITY_MISMATCH' }
if (($BootstrapBytes.Length -ge 3 -and $BootstrapBytes[0] -eq 0xEF -and $BootstrapBytes[1] -eq 0xBB -and $BootstrapBytes[2] -eq 0xBF) -or ($BootstrapBytes -contains [byte]0)) { throw 'RELEASE_BOOTSTRAP_ENCODING_INVALID' }
$StrictUtf8 = New-Object Text.UTF8Encoding($false, $true)
$BootstrapScriptBlock = [ScriptBlock]::Create($StrictUtf8.GetString($BootstrapBytes))
. $BootstrapScriptBlock
$BootstrapProof = Open-ApprovedReleaseBootstrap -ExpectedWorkspaceRoot $CanonicalWorkspaceRoot -PlatformName $PlatformName -BootstrapSha256 $BootstrapActualSha256 -ExpectedRunnerSha256 $ExpectedRunnerSha256 -ExpectedPrivateLockSha256 $ExpectedPrivateLockSha256
. $BootstrapProof.RunnerScriptBlock -BootstrapProof $BootstrapProof
Invoke-WithReleaseToolingLease -BootstrapProof $BootstrapProof -ExpectedHostMode Interactive -Callback {
param($Toolchain)
$WorkspaceManifestProof = $null

function Invoke-CheckedNative {
    param([string]$LogicalName, [string[]]$ArgumentList)
    if ($LogicalName -eq 'git' -or $LogicalName -eq 'git-remote-https') { throw 'Git requires an owned Git session' }
    if ($null -eq $WorkspaceManifestProof) {
        $Result = Invoke-CheckedNativeOwned -Toolchain $Toolchain -LogicalName $LogicalName -ArgumentList $ArgumentList
    } else {
        $Result = Invoke-CheckedNativeOwned -Toolchain $Toolchain -LogicalName $LogicalName -ArgumentList $ArgumentList -WorkspaceManifestProof $WorkspaceManifestProof
    }
    if ($Result.ExitCode -ne 0) { throw "$LogicalName failed with exit code $($Result.ExitCode)" }
}
function Get-CheckedNativeLines {
    param([string]$LogicalName, [string[]]$ArgumentList)
    if ($LogicalName -eq 'git' -or $LogicalName -eq 'git-remote-https') { throw 'Git requires an owned Git session' }
    if ($null -eq $WorkspaceManifestProof) {
        $Result = Invoke-CheckedNativeOwned -Toolchain $Toolchain -LogicalName $LogicalName -ArgumentList $ArgumentList -CaptureOutput
    } else {
        $Result = Invoke-CheckedNativeOwned -Toolchain $Toolchain -LogicalName $LogicalName -ArgumentList $ArgumentList -WorkspaceManifestProof $WorkspaceManifestProof -CaptureOutput
    }
    if ($Result.ExitCode -ne 0) { throw "$LogicalName failed with exit code $($Result.ExitCode)" }
    return @($Result.StdoutLines)
}
function Assert-ExactPathSet {
    param([string[]]$Actual, [string[]]$Expected)
    $ActualText = (@($Actual | Sort-Object -CaseSensitive) -join "`n")
    $ExpectedText = (@($Expected | Sort-Object -CaseSensitive) -join "`n")
    if ($ActualText -cne $ExpectedText) { throw 'exact path set mismatch' }
}

$StrictSemVer = '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
$NewDesktopVersion = ([string](Read-Host 'New desktop version after the abandoned candidate (MAJOR.MINOR.PATCH, without v)')).Trim()
$NewExtensionVersion = ([string](Read-Host 'New extension version after the abandoned candidate (MAJOR.MINOR.PATCH)')).Trim()
if ($NewDesktopVersion -notmatch $StrictSemVer -or $NewExtensionVersion -notmatch $StrictSemVer) {
    throw 'Both recovery versions must be strict MAJOR.MINOR.PATCH semver'
}

$ExpectedStaged = @('browser-extension/manifest.json', 'desktop/package-lock.json', 'desktop/package.json')
function Invoke-CheckedGit {
    param([string[]]$ArgumentList, $ExpectedCommitManifest = $null)
    if ($null -ne $ExpectedCommitManifest) {
        $Result = Invoke-CheckedGitOwned -GitSession $GitSession -ArgumentList $ArgumentList -ExpectedCommitManifest $ExpectedCommitManifest
    } else {
        $Result = Invoke-CheckedGitOwned -GitSession $GitSession -ArgumentList $ArgumentList
    }
    if ($Result.ExitCode -ne 0) { throw "git failed with exit code $($Result.ExitCode)" }
}
function Get-CheckedGitLines {
    param([string[]]$ArgumentList)
    $Result = Invoke-CheckedGitOwned -GitSession $GitSession -ArgumentList $ArgumentList -CaptureOutput
    if ($Result.ExitCode -ne 0) { throw "git failed with exit code $($Result.ExitCode)" }
    return @($Result.StdoutLines)
}

$PreparationArgs = @{
    Toolchain = $Toolchain
    Mode = 'Abandoned'
    DesktopVersion = [string]$NewDesktopVersion
    ExtensionVersion = [string]$NewExtensionVersion
    AbandonedMarkerRelativePath = '.build/telegram-release-abandoned.json'
}
$Preparation = $null
$GitSession = $null
try {
    $Preparation = Invoke-ReleaseVersionPreparationOwned @PreparationArgs
    if ($Preparation.State -ceq 'commit_observed') { return }
    if ($Preparation.State -cne 'workspace_ready') { throw 'version preparation state is invalid' }
    Assert-ExactPathSet @($Preparation.ExpectedPaths) $ExpectedStaged
    $WorkspaceManifestProof = $Preparation.WorkspaceManifestProof
    $GitSession = Open-ReleaseGitSession -Toolchain $Toolchain -WorkspaceManifestProof $WorkspaceManifestProof -VersionPreparationProof $Preparation.PreparationProof -CandidateHead $null -PermittedMutationPaths $ExpectedStaged -CommitMessage 'chore: prepare next telegram release candidate'
    $ActualChanged = @(Get-CheckedGitLines @('diff', '--name-only'))
    Assert-ExactPathSet $ActualChanged $ExpectedStaged
    Invoke-CheckedNative 'node' @('--test', 'scripts/tests/telegramReleaseVersions.test.mjs')
    $DesktopTest = Invoke-WorkspaceNodeToolOwned -Toolchain $Toolchain -LogicalName 'vitest' -ArgumentList @('run', '--config', 'vitest.config.ts') -WorkspaceManifestProof $WorkspaceManifestProof
    if ($DesktopTest.ExitCode -ne 0) { throw "vitest failed with exit code $($DesktopTest.ExitCode)" }
    $DesktopTypes = Invoke-WorkspaceNodeToolOwned -Toolchain $Toolchain -LogicalName 'typescript' -ArgumentList @('-p', 'tsconfig.node.json', '--noEmit') -WorkspaceManifestProof $WorkspaceManifestProof
    if ($DesktopTypes.ExitCode -ne 0) { throw "typescript failed with exit code $($DesktopTypes.ExitCode)" }
    $DesktopBuild = Invoke-WorkspaceNodeToolOwned -Toolchain $Toolchain -LogicalName 'vite' -ArgumentList @('build') -WorkspaceManifestProof $WorkspaceManifestProof
    if ($DesktopBuild.ExitCode -ne 0) { throw "vite failed with exit code $($DesktopBuild.ExitCode)" }
    Invoke-CheckedNative 'node' @('browser-extension/shared.test.js')
    Invoke-CheckedGit (@('add', '--') + $ExpectedStaged)
    $ActualStaged = @(Get-CheckedGitLines @('diff', '--cached', '--name-only'))
    Assert-ExactPathSet $ActualStaged $ExpectedStaged
    Invoke-CheckedGit @('diff', '--cached', '--check')
    Invoke-CheckedGit @('commit', '--no-verify', '--no-gpg-sign', '--cleanup=verbatim', '-m', 'chore: prepare next telegram release candidate') -ExpectedCommitManifest $WorkspaceManifestProof
} catch {
    $Failure = $_
    if ($null -ne $GitSession) {
        Close-ReleaseGitSession -GitSession $GitSession
        $GitSession = $null
    }
    if ($null -ne $Preparation -and $Preparation.State -ceq 'workspace_ready') {
        $AbortArgs = $PreparationArgs.Clone()
        $AbortArgs['Abort'] = $true
        $AbortResult = Invoke-ReleaseVersionPreparationOwned @AbortArgs
        if ($AbortResult.State -ceq 'commit_observed') { return }
        if ($AbortResult.State -cne 'aborted') { throw 'version preparation abort did not settle' }
    }
    throw $Failure
}
}
~~~

desktop 与 extension 必须分别严格大于 abandoned值，不要求相等；package-lock 顶层和 `packages[""]` 都等于 desktop。helper 执行后 `git diff --name-only` exact set只能是上述三个版本文件，任一额外修改失败。Task17P/17R在版本事务返回`workspace_ready`后的任一普通异常都必须先完成同参Abort；只有Abort确认`aborted`后才把原异常交给操作者修代码或选择新版本，若确认`commit_observed`则直接视为本次提交成功。强杀不执行catch，由下次同参调用按marker恢复。

- [ ] **Step 3: 合入默认分支后重新 freeze**

使用 `superpowers:finishing-a-development-branch` 合入并推送 authenticated default branch；随后从 Task 17B 的 recover→freeze重新开始。新 formal marker必须包含并回读 `supersedesAbandonedSha256` 后才删除 canonical abandoned；永久 watch tombstone继续保留。版本恢复任务不创建 tag、workflow run、Release或 evidence ref。

---

## Spec Coverage Audit

| 批准规格 | 实施任务 | 证据 |
|---|---|---|
| 专用 Bot、用户只输 Token、单默认目标 | 6、10、12 | vault/controller/UI 测试与真实绑定 |
| 私聊/群组/超级群组/频道发现 | 10、12、17B | getUpdates 去重测试与四类目标 smoke |
| 启用后新下载、旧历史不补发 | 1–4、17B | enabled_at 边界与 recovery 测试 |
| 最终后处理之后才发送 | 2、3、17B | output_state 顺序与崩溃中断测试 |
| MP4/MP3/M4A/document 与 fallback | 8、9、17B | client/worker matrix 与真实媒体 |
| 2000 MB 上限只通知 | 9、17B | oversize 单测与真实边界 |
| 下载和发送状态解耦 | 1–4、11、17B | Sidecar e2e 与 UI badge |
| 持久队列、租约、重试、uncertain | 1、4、9、17B | SQLite concurrency 与 crash tests |
| safeStorage 与秘密不泄漏 | 5、6、10、17B | 越权测试、vault、五层审计 |
| 官方本地服务、随机 loopback | 7、8、13–15、17B | supervisor 与安装包运行证据 |
| macOS + Windows 打包 | 13–16、17A–17B | DMG/NSIS 资源与真实安装 smoke |
| 用户界面和可操作错误 | 11、12、17B | Testing Library、截图和人工流程 |

## Plan Self-Review Checklist

- [ ] 所有批准的产品决策都能映射到上表至少一个自动化测试和一个真实验收项。
- [ ] 所有新增协议方法在 Python enum、handler、Electron gateway 和测试中使用完全相同的 camelCase 字符串。
- [ ] 所有 delivery 状态只来自同一个 9 值 union；Python、TypeScript、UI 文案和 SQL CHECK 一致。
- [ ] 所有 Renderer DTO 和事件都不含 `filePath`、`leaseId`、token、api ID/hash；只有 Main claim DTO 含绝对路径与 lease。
- [ ] 所有用户可见 error 都由稳定 code 映射，raw Telegram description 只可在脱敏且限长的诊断日志中出现。
- [ ] 用下面命令扫描计划本身，除接口协议中的合法语法外不得出现未完成占位：

```powershell
$Terms = @('TO' + 'DO', 'TB' + 'D', 'FIX' + 'ME', '待' + '定', '待' + '补', 'implement ' + 'later', 'similar ' + 'to', 'appro' + 'priate')
rg -n ($Terms -join '|') docs/superpowers/plans/2026-08-10-telegram-auto-delivery.md
```

- [ ] 用下面命令检查命名一致性和文件存在性：

```powershell
rg -n "telegramDelivery\.(configure|getConfig|list|claimNext|renewLease|releaseClaim|markSending|markSent|markRetry|markRetryNotSubmitted|markFailed|markTargetFailed|markUncertain|markSkippedOversize|getTargetBlock|clearTargetBlock|retry|cancelPending)" src desktop tests
rg -n "pending|preparing|sending|retry_wait|sent|failed|uncertain|cancelled|skipped_oversize" src desktop tests
rg -n 'version="2026\.7\.4"|bundled version 精确为 `2026\.7\.4`|runtime `2026\.7\.4`' docs/superpowers/plans/2026-08-10-telegram-auto-delivery.md
git status --short
```

第三条 Expected: 无结果；`2026.7.4` 只允许出现在 requirement/pip metadata 的规范化 distribution version 语义，所有 `yt_dlp.version.__version__` 与 health/package-smoke 运行时断言必须为 `2026.07.04`。

- [ ] 每个任务的 commit 只含该任务 file list；每次 commit 前运行 `git diff --cached --name-only` 对照。
- [ ] 最终没有提交 `desktop/release/`、`desktop/resources/telegram-bot-api` 构建产物、`app-credentials.json`、Bot 授权工作目录、下载成品或任何真实 token。
