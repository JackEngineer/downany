# Downany · 百纳 Telegram 自动发送设计

- 日期：2026-08-10
- 状态：用户已通过规格
- 产品范围：Electron 桌面端 + Python Sidecar，macOS 与 Windows
- 目标分支：在 `feat/m0-windows-foundation` 双平台基线上实施

## 1. 背景

Downany 已能把下载任务持久化到 SQLite，并由 Electron 主进程接收 Sidecar 的任务事件。用户希望只配置一个 Telegram Bot Token，之后每次下载完成都自动把最终文件发送到一个默认 Telegram 私聊、群组或频道。

常见文件为 50 MB 至 2 GB。Telegram 云端 Bot API 的上传上限不能覆盖该范围，因此本功能采用 Telegram 官方本地 Bot API 服务，并随 Downany 的 macOS、Windows 安装包分发和监护。下载成功与 Telegram 发送是两个独立结果；发送失败不得把已完成下载改成失败，也不得删除本地文件。

## 2. 已确认的产品决策

1. 使用 Telegram Bot，不接入个人 Telegram 账号。
2. 用户只输入 Bot Token；Telegram `api_id` 与 `api_hash` 由 Downany 构建流程提供。
3. 一个 Downany 实例只绑定一个专用 Bot，并选择一个默认接收位置。
4. 接收位置支持私聊、群组、超级群组和频道。
5. 开启自动发送后，仅处理此后完成的下载；不自动补发旧历史。
6. MP4 优先作为视频发送，MP3/M4A 优先作为音频发送，其余格式作为原文件发送；媒体发送不兼容时自动降级为原文件。
7. 文件大于本地 Bot API 的 2000 MB 上限时保留本地文件，只向 Telegram 发送“文件过大”通知；不切片、不压缩。
8. Telegram 失败不改变下载成功状态；失败发送有独立状态、重试和人工重试入口。
9. macOS 与 Windows 使用同一套产品流程和协议，平台差异只留在凭据保护、二进制路径和打包层。

## 3. 目标与非目标

### 3.1 目标

- 在设置中完成 Bot 连接、接收位置发现、测试和自动发送开关。
- 下载及自定义后处理结束后，把最终本地文件可靠地加入发送队列。
- 支持应用退出、网络中断、Telegram 限流及本地服务重启后的恢复。
- Bot Token 只以系统加密形式落盘，不进入 Sidecar、普通设置、SQLite、日志或渲染进程快照。
- DMG 与 NSIS 安装包都包含可运行的官方本地 Bot API 服务。
- 给每次发送保留可解释、可重试、可审计的状态。

### 3.2 非目标

- 不支持个人账号登录、多个 Bot、多接收位置路由或按平台分流。
- 不做远程 Downany 控制、Telegram 命令下载、云端中转或跨设备文件同步。
- 不为超过 2000 MB 的文件切片、压缩或重新编码。
- 不把应用签名、公证能力扩展为本功能的一部分；发布物继续遵循仓库当前签名基线。
- 不承诺 Bot 断开后立刻能被其他云端服务复用；Telegram 服务迁移可能存在等待时间。

## 4. 方案选择

### 4.1 方案 A：直接调用云端 Bot API

优点是依赖少、实现简单。缺点是上传上限无法覆盖用户的主要文件范围，因此不采用。

### 4.2 方案 B：随应用运行官方本地 Bot API 服务

本地服务允许上传最高 2000 MB 的文件，并能直接读取本机绝对路径，避免 Electron 把大文件读入内存或复制到缓存。代价是安装包更大，构建、启动监护和双平台依赖更复杂。

本设计采用方案 B。

### 4.3 方案 C：直接实现 MTProto 客户端

虽然能获得更低层控制，但账号会话、安全边界、协议维护与产品复杂度显著增加，也偏离“只输入 Bot Token”的要求，因此不采用。

## 5. 总体架构

```text
React 设置与发送状态
        │ 窄化 preload IPC
        ▼
Electron Main
  ├─ TelegramCredentialVault   系统加密保存 Bot Token
  ├─ TelegramBotApiSupervisor  启停并监护本地官方服务
  ├─ TelegramBotApiClient      绑定、发现会话、发送文件
  └─ TelegramDeliveryWorker    串行领取并执行发送任务
        │ JSON Lines 请求/事件；不传 Token
        ▼
Python Sidecar
  ├─ DownloadManager           下载与最终后处理
  ├─ TelegramDeliveryStore     SQLite 发送队列与租约
  └─ TelegramDeliveryService   入队、恢复、状态转换
        │ 本地绝对文件路径
        ▼
127.0.0.1 随机端口上的 telegram-bot-api --local
        │
        ▼
Telegram
```

边界原则：

- Renderer 只通过明确命名的 preload 方法操作 Telegram，不获得文件系统、进程或通用 Sidecar 调用能力。
- Electron Main 是唯一接触 Bot Token 的 Downany 进程；官方本地服务会在处理 Bot API 请求时接触 Token，但 Renderer 与 Python Sidecar 永远不会接触。
- Python Sidecar 是下载状态与发送队列的事实来源，但只保存非秘密的 Bot 账号 ID、目标会话和发送元数据。
- 本地 Bot API 服务只监听 `127.0.0.1` 的随机可用端口；不得监听局域网或公网地址。
- 大文件通过本地模式的绝对路径交给服务，不在 Renderer、Electron Main 或 Sidecar 中整文件缓冲，也不复制到第二份缓存。

## 6. 组件职责

### 6.1 TelegramCredentialVault

- 使用 Electron `safeStorage`：macOS 由 Keychain 保护，Windows 由 DPAPI 保护。
- 加密结果保存到 Downany 应用数据目录下的版本化凭据文件；文件只包含 schema 版本、密文和非秘密时间戳。
- `safeStorage` 不可用或返回明文后端时拒绝绑定，并显示可操作错误；没有明文降级路径。
- 读取后只在 Electron Main 内存中短暂存在。断开连接时删除凭据文件、清空内存引用并禁用自动发送。
- 日志、异常、分析事件和 IPC 响应统一经过 Token/URL 脱敏器。

### 6.2 TelegramBotApiSupervisor

- 从打包资源或开发环境覆盖路径解析当前平台的 `telegram-bot-api` 可执行文件。
- 以非 shell 子进程启动，传入 `--local`、回环监听地址、随机端口及独立工作/临时目录。
- `api_id` 与 `api_hash` 从构建生成资源或开发环境变量读取，再通过官方支持的 `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` 子进程环境变量注入，避免出现在命令行；发布构建缺失时直接失败，不在仓库中硬编码。
- 通过受控探测确认端口已就绪；异常退出时按有限退避重启，并把健康状态提供给绑定和发送工作器。
- 应用退出时先停止领取新任务，再给正在请求中的任务记录确定状态，最后终止本地服务。

### 6.3 TelegramBotApiClient

- 提供 `getMe`、`deleteWebhook`、`logOut`、`getUpdates`、`sendMessage`、`sendVideo`、`sendAudio` 和 `sendDocument` 的最小封装。
- Bot API 端点本身必须含 Token；URL 只允许在 Client 内部构造和使用，任何返回值、异常、诊断或日志中的 URL 都必须先移除 Token。
- 文件参数只接受已规范化、存在且位于本地文件系统的绝对路径。
- Windows 路径需覆盖空格、中文、长路径与盘符；macOS 路径需覆盖空格、中文和应用数据目录。

### 6.4 TelegramDeliveryWorker

- 单实例串行执行，避免多个大文件争抢磁盘与网络，也简化崩溃判定。
- 从 Sidecar 原子领取一条到期任务，准备文件和媒体类型后，在发起 Telegram 请求前标记为 `sending`。
- 请求成功后记录 Telegram `message_id`；收到明确失败则按错误分类进入重试或永久失败。
- 应用重启时恢复到期任务；已发送任务永不自动重发。

### 6.5 TelegramDeliveryStore / Service

- 在现有 `history.db` 中创建独立表，不把发送状态塞进普通下载状态字段。
- DownloadManager 在最终后处理结束后调用 Sidecar 注入的通用 output-ready hook；该 hook 在一个 SQLite 事务中标记输出就绪，并按当时的账号与目标创建发送记录。Core 不导入 Telegram 模块。
- 提供原子领取、续租、完成、重试、取消、人工重试和分页查询。
- 启动时回收过期租约，并对输出就绪但没有发送记录的任务执行幂等补偿。
- output-ready hook 在 DownloadManager 启动前注入；Telegram 协调器先完成恢复和订阅，再允许下载调度启动，避免启动窗口丢失就绪信号。

## 7. 绑定与接收位置流程

### 7.1 连接 Bot

1. 用户在“设置 → 发送”输入 Bot Token，勾选“此机器人专用于百纳”，点击“连接 Telegram”。
2. Electron Main 启动并确认本地服务健康，再通过 Telegram 云端 `getMe` 校验 Token 和 Bot 身份。
3. 客户端以 `drop_pending_updates=false` 删除旧 webhook，并在云端调用 `logOut`，把该 Bot 迁移到本地服务。
4. 客户端通过本地服务再次调用 `getMe`。只有本地验证成功后才加密保存 Token，并把非秘密账号 ID、用户名写入 Sidecar 设置。
5. 若迁移后本地验证失败，界面保留可恢复错误并允许重试；不得假装连接成功。Token 不写入普通设置或 SQLite。
6. 连接成功后立即清空输入框；后续读取设置只返回“已连接”和 Bot 显示信息，不返回 Token 或掩码 Token。

专用 Bot 是明确前置条件，因为迁移会使同一个 Bot 暂时不能同时由其他云端 Bot API 服务使用。

### 7.2 发现接收位置

- 私聊：用户在 Telegram 中打开该 Bot 并发送 `/start`。
- 群组/超级群组：用户把 Bot 加入群组并发送一条消息，或触发成员状态更新。
- 频道：用户把 Bot 设为可发消息的管理员；成员状态或频道消息用于发现频道。
- 用户回到 Downany 点击“刷新接收位置”。客户端从本地服务的 `getUpdates` 汇总 `message.chat`、`channel_post.chat` 和 `my_chat_member.chat`。
- 会话 ID 端到端使用字符串，避免 JavaScript 数字精度问题；列表按类型、标题和最近发现时间去重。
- 支持的类型为 `private`、`group`、`supergroup`、`channel`。其他类型不出现在可选列表。
- 每个 Bot 账号单独保存非秘密的 `next_update_offset` 和已发现会话缓存；该值就是下一次 `getUpdates` 要传入的十进制 offset。只有成功处理并持久化整批更新后，才把它推进到 `max(update_id) + 1`；切换 Bot 时清空旧缓存，重复刷新不会丢失之前发现的会话。

### 7.3 验证与启用

1. 用户选择一个接收位置，点击“发送测试消息”。
2. 只有测试消息成功后，才允许开启“下载完成后自动发送”。
3. 开启时保存 `enabled_at`、Bot 账号 ID 和默认目标快照；旧于 `enabled_at` 的下载不入队。
4. 改变默认目标只影响之后新建的发送记录，已排队记录继续使用创建时捕获的目标。
5. 更换 Token 后若 `getMe` 得到同一 Bot 账号 ID，则视为凭据更新并恢复该账号保留的队列；若账号 ID 不同，必须确认后取消旧账号尚未开始的记录，不能把旧记录静默改投给新 Bot。
6. 断开连接会关闭自动发送，并以 `drop_pending_updates=false` 删除本地 webhook、调用本地 `logOut`、停止本地服务、清理该 Bot 的本地授权工作目录，随后删除加密 Token；尚未开始的记录取消，`sending` 记录按崩溃安全规则收敛。已发送记录和下载文件保留。
7. 即使本地 `logOut` 失败，用户仍可完成 Downany 本地断开；界面需提示该 Bot 在其他服务重新可用前可能需要等待。Telegram 明确规定，从云端成功 `logOut` 后 10 分钟内不能重新登录云端。

## 8. 从下载完成到发送的流程

1. yt-dlp 返回最终文件路径，DownloadManager 继续维持现有“下载完成”语义和事件。
2. 若配置了自定义后处理脚本，先等待该次脚本执行返回；脚本失败仍遵循现有规则，不把下载改成失败。
3. Sidecar 的 output-ready hook 检查最终路径是否存在，并记录通用的 `output_ready_at`。若启用了 Telegram 且任务完成时间不早于 `enabled_at`，在同一数据库事务中按当时账号与目标创建发送记录。
4. Sidecar 发出 `telegramDelivery.queued` 事件唤醒 Electron 工作器；事件丢失也不影响恢复，因为数据库记录是事实来源。
5. 工作器领取记录，重新读取文件大小和扩展名并确定发送方式。
6. 文件大于 `2_000_000_000` 字节时不上传，改发一条包含标题、实际大小和“文件已保留在电脑”的通知，记录状态为 `skipped_oversize`。
7. 不超限文件按以下顺序发送：
   - `.mp4` → `sendVideo`
   - `.mp3`、`.m4a` → `sendAudio`
   - 其他扩展名 → `sendDocument`
8. `sendVideo` 或 `sendAudio` 收到明确的媒体不兼容错误时，在同一发送记录内仅降级一次到 `sendDocument`。
9. Caption 包含标题、来源 URL 和可读文件大小；按 Telegram 的 1024 字符上限安全截断，并优先保留来源 URL。不得包含本地绝对路径。
10. 成功后保存 `message_id`、发送方式和完成时间；下载状态保持 `completed`。

如果应用在自定义后处理过程中异常退出，启动恢复不会猜测脚本是否完整执行：该任务显示“后处理被中断，等待人工重试发送”，防止自动发送可能被改坏的文件。没有自定义脚本的已完成任务可在文件存在且稳定后自动补记 `output_ready_at`。

## 9. 数据模型

### 9.1 非秘密设置

普通设置可以保存：

- `telegram_auto_send_enabled`
- `telegram_enabled_at`
- `telegram_account_id`
- `telegram_account_username`
- `telegram_target_chat_id`
- `telegram_target_chat_type`
- `telegram_target_chat_title`
- `telegram_next_update_offset`
- `telegram_discovered_targets`

这些字段不包含 Token。连接状态由“加密凭据存在 + 本地验证成功”实时计算，不能只相信普通设置布尔值。

Telegram 新增时间字段统一写为带时区的 UTC ISO 8601。读取现有下载历史的无时区 `completed_at` 时，先按其产生机器的本地时区解析并规范化到 UTC；资格判断不得依赖字符串字典序比较。

### 9.2 下载输出就绪标记

`download_history` 增加可空的 `output_ready_at`。下载状态完成与输出可发送是两个时点：前者保持现有产品语义，后者在自定义后处理尝试返回后写入。

### 9.3 发送队列表

```sql
CREATE TABLE telegram_delivery_queue (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    target_chat_id TEXT NOT NULL,
    target_chat_type TEXT NOT NULL,
    target_chat_title TEXT NOT NULL DEFAULT '',
    source_url TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    file_path TEXT NOT NULL DEFAULT '',
    file_size INTEGER NOT NULL DEFAULT 0,
    file_mtime_ns TEXT NOT NULL DEFAULT '0',
    media_kind TEXT NOT NULL DEFAULT 'document',
    status TEXT NOT NULL CHECK(status IN (
        'pending', 'preparing', 'sending', 'retry_wait',
        'sent', 'failed', 'uncertain', 'cancelled', 'skipped_oversize'
    )),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    fallback_used INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    lease_id TEXT,
    lease_expires_at TEXT,
    request_started_at TEXT,
    last_error_code TEXT NOT NULL DEFAULT '',
    last_error_message TEXT NOT NULL DEFAULT '',
    telegram_message_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    sent_at TEXT,
    UNIQUE(task_id, account_id, target_chat_id)
);

CREATE INDEX idx_telegram_delivery_due
ON telegram_delivery_queue(status, next_attempt_at, created_at);
```

发送记录不外键关联 `task_queue`。即使用户移除下载任务，发送审计仍应保留；真正发送前仍需检查本地文件是否存在。

## 10. 状态机、租约与崩溃恢复

```text
pending ──领取──> preparing ──请求即将发出──> sending ──成功──> sent
   ▲                    │                         ├─可重试──> retry_wait ──到期──┘
   │                    ├─文件过大通知成功──────> skipped_oversize
   │                    └─明确永久错误──────────> failed
   │
   └──────── 人工重试：failed / uncertain

sending ──进程失联且结果未知──> uncertain
pending / retry_wait ──断开连接──> cancelled
```

- 领取使用 `BEGIN IMMEDIATE`，原子写入 `preparing`、随机 `lease_id` 和租约到期时间。
- `preparing` 租约过期表示请求尚未开始，可安全回到 `pending`。
- 在调用 Telegram 前先持久化 `sending` 与 `request_started_at`。
- `sending` 后进程崩溃无法可靠判断 Telegram 是否已收件，因此恢复为 `uncertain`，不自动重发。
- 用户从 `uncertain` 人工重试前必须确认“Telegram 可能已收到，重试可能产生重复消息”。
- `sent` 与 `skipped_oversize` 都是终态，绝不自动重复发送。
- Sidecar 启动时回收租约、恢复到期 `retry_wait`，并补偿 `output_ready_at IS NOT NULL`、`completed_at >= enabled_at` 且不存在队列记录的任务。

## 11. 错误分类与重试

### 11.1 自动重试

- 能证明请求尚未提交的网络不可达/连接失败，以及 Telegram 明确返回的 5xx：按 10 秒、30 秒、2 分钟、10 分钟、1 小时退避；之后保持每小时重试，直到用户取消或连接配置改变。若请求已进入 `sending` 后发生连接重置、超时、非法响应或本地服务崩溃，结果无法证明时进入 `uncertain`，不自动重发。
- HTTP 429：严格使用 Telegram 返回的 `retry_after`，并加入小幅随机抖动，避免同一时刻再次拥塞。
- 本地服务异常退出：Supervisor 先恢复服务；尚未进入 `sending` 或可证明未提交的记录保持 `retry_wait`，不消耗一次媒体发送重试；已经进入 `sending` 的请求若没有明确响应，必须按上条进入 `uncertain`。

### 11.2 明确失败

- Token 失效：暂停整个发送工作器，连接状态变为“需要重新连接”，保留队列。
- Bot 被移出目标、频道无发言权限或会话不存在：该记录进入 `failed`，自动发送开关保持但阻止继续向同一无效目标发送，并提示重新选择接收位置。
- 文件不存在、不可读或大小在准备阶段变化：记录进入 `failed`，下载历史不变。
- 媒体不兼容：先降级为 `sendDocument`；降级仍失败后按最终错误分类。
- 本地服务迁移失败：绑定不完成，不创建新的发送记录。

所有对用户展示的错误都使用产品语言，保留“重试、重新连接、重新选择位置、打开文件所在位置”等可执行动作；底层错误码只进入经过脱敏的诊断信息。

## 12. Sidecar 协议与 Renderer IPC

### 12.1 Sidecar 方法

- `telegramDelivery.configure`：写入非秘密账号/目标/启用设置。
- `telegramDelivery.list`：分页读取发送记录。
- `telegramDelivery.claimNext`：原子领取一条到期记录。
- `telegramDelivery.markSending`：在网络请求前写入不可安全重试边界。
- `telegramDelivery.markSent`：记录成功结果。
- `telegramDelivery.markRetry`：记录下一次尝试时间与脱敏错误。
- `telegramDelivery.markFailed`：记录明确永久失败。
- `telegramDelivery.markUncertain`：记录结果未知。
- `telegramDelivery.retry`：人工重试失败或不确定记录。
- `telegramDelivery.cancelPending`：断开连接时取消未开始记录。

所有方法沿用 JSON Lines 包络、结构化错误和 correlation ID。Sidecar 的 stdout 只输出协议行，诊断继续走 stderr。

### 12.2 Sidecar 事件

- `telegramDelivery.queued`
- `telegramDelivery.updated`
- `telegramDelivery.sent`
- `telegramDelivery.failed`
- `telegramDelivery.uncertain`

事件只携带记录 ID 和非秘密状态摘要。完整列表通过分页方法读取，避免把文件路径或大量历史广播到 Renderer。

### 12.3 Preload 方法

- `getTelegramStatus()`
- `bindTelegramToken(token)`
- `disconnectTelegram()`
- `discoverTelegramTargets()`
- `selectTelegramTarget(target)`
- `sendTelegramTest(targetId)`
- `setTelegramAutoSend(enabled)`
- `listTelegramDeliveries(query)`
- `retryTelegramDelivery(deliveryId)`
- `onTelegramDelivery(listener)`

Preload 对参数、返回值和事件做显式 schema 校验，不暴露任意 IPC channel。Token 只在用户点击连接时从输入框发往 Main 一次；输入框随后清空。

## 13. 界面与产品文案

设置新增“发送”页签，核心文案为：

- 标题：`发送到 Telegram`
- 未连接按钮：`连接 Telegram`
- Token 标签：`Bot Token`
- 前置确认：`此机器人将专用于百纳`
- 目标标签：`接收位置`
- 刷新动作：`刷新接收位置`
- 验证动作：`发送测试消息`
- 开关：`下载完成后自动发送`
- 断开动作：`断开连接`

连接状态使用 `未连接`、`正在连接`、`已连接`、`需要重新连接`。接收位置列表显示 Telegram 中的真实标题与类型，不显示内部 chat type 名称。

发送状态在任务详情和“最近发送”列表中统一映射为：

- `pending` / `preparing`：等待发送
- `sending`：正在发送
- `retry_wait`：稍后重试
- `sent`：已发送
- `skipped_oversize`：文件过大，已通知
- `failed`：发送失败
- `uncertain`：请确认是否已收到
- `cancelled`：已取消

自动发送开关只有在 Bot 已连接、接收位置已选择且测试消息成功时可用。空状态会指导用户在 Telegram 中启动 Bot 或把 Bot 加入群组/频道，而不暴露本地服务、API 迁移或进程术语。

## 14. 安全与隐私

- Bot Token 不进入 JsonConfig、SQLite、Sidecar、崩溃报告、日志、开发者工具持久化或 UI 快照。
- Telegram `api_id`/`api_hash` 是 Downany 的应用凭据，不是用户秘密；仍通过 CI/本地构建注入、禁止打印并从仓库排除。桌面二进制中的应用凭据可被逆向获取，因此不得赋予超出本地 Bot API 所需的权限或当作高强度服务端秘密。
- 官方本地服务的每 Bot 授权数据库属于敏感状态：只放在 Downany Telegram 专用工作目录，限制为当前系统用户访问，不纳入备份或日志；断开后在服务停止并校验目标目录位于 Downany 数据目录内，再删除对应账号工作目录。
- 本地服务只绑定回环地址，端口随机，不开放 CORS 给任意来源，不接受 Renderer 直接访问。
- 子进程使用固定参数数组启动，不使用 shell；路径与标题从不拼接为命令。
- Bot API 请求日志以方法名、状态码、记录 ID 为主，任何包含 Token 的 URL 都在写日志前移除。
- 发送前仅访问队列捕获的绝对文件路径；不接受 Renderer 任意指定文件路径。
- 断开连接不删除下载成品或已发送历史。

## 15. macOS 与 Windows 分发

### 15.1 二进制布局

- macOS：`resources/telegram-bot-api/telegram-bot-api`
- Windows：`resources/telegram-bot-api/telegram-bot-api.exe`；第三方依赖静态链接，仅使用系统 DLL，不随包复制 OpenSSL/zlib/VC Runtime DLL
- 开发覆盖：`DOWNANY_TELEGRAM_BOT_API_BIN`

Electron `paths` 模块负责平台可执行文件后缀与打包/开发路径，Supervisor 不自行拼接平台分支。

### 15.2 构建

- 固定 Telegram 官方 `tdlib/telegram-bot-api` 的版本或提交，并记录来源、许可证与校验值。
- macOS runner 构建与 DMG 架构一致的原生二进制；Windows x64 runner 以 static triplet 构建 `.exe` 并验证只依赖 Microsoft System32 DLL。不得把 macOS 二进制交叉放入 Windows 包或反之。
- `electron-builder.yml` 通过 `extraResources` 收入平台目录；打包前脚本检查文件存在、架构正确且可执行。
- 发布构建通过 CI secret 生成仅供构建使用的 Telegram 应用凭据资源；缺少 `api_id` 或 `api_hash` 时发布任务失败。
- 本地开发可用 `DOWNANY_TELEGRAM_API_ID` 与 `DOWNANY_TELEGRAM_API_HASH`，但测试日志不得输出值。
- `desktop/release/`、构建出的 Telegram 二进制和用户凭据均不提交仓库。

### 15.3 运行时路径

- macOS 数据继续位于 `~/Library/Application Support/Downany/`。
- Windows 数据继续位于 `%LOCALAPPDATA%\Downany\`。
- 本地服务数据库、临时目录与加密凭据放在上述应用数据目录的 Telegram 子目录；下载文件仍使用用户选择的下载目录。

## 16. 测试与验证矩阵

### 16.1 Python 单元与协议测试

- 数据库建表、旧库迁移、唯一约束和分页。
- 开启时间边界：旧历史不补发，新完成任务入队。
- 目标快照：切换默认目标不改变已有记录。
- 原子领取、租约回收、串行语义和各状态合法转换。
- postprocess 返回后才写 `output_ready_at`；中断脚本不自动发送。
- 超过 `2_000_000_000` 字节、文件缺失、文件变化和媒体分类。
- JSON Lines 方法、事件、结构化错误及 stdout 纯净性。

### 16.2 Electron Main 与 preload 测试

- macOS Keychain/Windows DPAPI 路径，`safeStorage` 不可用时拒绝明文保存。
- Token 不出现在设置、SQLite、日志、异常、IPC 响应或快照中。
- Supervisor 的随机回环端口、健康检查、异常重启、正常关闭和路径解析。
- Token 绑定迁移顺序、失败回滚状态、目标发现去重和权限验证。
- 429 `retry_after`、5xx/离线退避、认证失败、目标权限失败。
- `sendVideo`/`sendAudio` 降级为 `sendDocument`，成功结果写回 Sidecar。
- 崩溃发生在 `preparing` 与 `sending` 两侧时分别得到安全重试和 `uncertain`。
- preload 只暴露白名单方法并拒绝畸形参数。

### 16.3 React 测试

- 未连接、连接中、已连接、需要重新连接四种状态。
- 专用 Bot 确认、Token 清空且不回显。
- 私聊/群组/频道发现引导、测试消息门槛和自动发送开关。
- 最近发送列表、重试、结果未知警告、文件过大通知状态。
- 所有可见文案使用用户语言，不展示内部 Bot API 或进程错误。

### 16.4 双平台构建与冒烟

- `pytest tests/core tests/data tests/sidecar -q`
- `cd desktop && npm test && npm run build`
- `node browser-extension/shared.test.js`
- macOS 生成 DMG，确认本地服务二进制架构、权限、启动和退出。
- Windows 生成 NSIS，确认 `.exe` 架构、System32 DLL 策略、DPAPI、Unicode/空格路径、启动和卸载。
- 使用专用测试 Bot 分别在 macOS 与 Windows 完成：私聊测试消息、小视频、音频、普通文件、接近上限的大文件、超过上限通知、断网恢复和重启恢复。

真实 Bot 冒烟使用 CI/人工提供的短期测试 Token 与测试会话，不把凭据写入仓库或常规 CI 日志。没有真实凭据时，自动化集成测试使用本地假 Bot API 服务验证协议与状态机，但不能替代发布前双平台真实冒烟。

### 官方依据

- [Telegram Bot API：Using a Local Bot API Server](https://core.telegram.org/bots/api#using-a-local-bot-api-server)：本地模式可用本地路径上传，单文件最高 2000 MB。
- [tdlib/telegram-bot-api：Usage 与迁移说明](https://github.com/tdlib/telegram-bot-api#usage)：`api_id` / `api_hash`、`--local`、环境变量、工作目录和从云端迁移的官方说明。
- [Telegram Bot API：logOut](https://core.telegram.org/bots/api#logout)：迁移到本地服务前必须从云端注销，并注明云端重新登录的 10 分钟限制。

## 17. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 本地 Bot API 显著增加包体和构建复杂度 | 固定官方版本，平台独立构建，打包前校验架构、依赖和校验值 |
| Bot 从云端迁移后短时不可用 | 连接前明确专用 Bot，先启动本地服务再迁移，失败提供恢复状态 |
| 发送中崩溃造成重复 | 请求前持久化 `sending`；恢复为 `uncertain`，只允许带警告的人工重试 |
| 大文件占满内存或磁盘 | 只传本地路径，串行发送，不创建第二份缓存 |
| Token 泄漏 | `safeStorage`、窄 IPC、统一脱敏、无明文降级和泄漏测试 |
| 目标权限后来被撤销 | 测试消息验证；权限错误阻止继续发送并引导重新选择 |
| 后处理脚本被崩溃中断 | 不猜测产物完整性，阻止自动发送并要求人工确认 |
| Windows/macOS 行为漂移 | 同一协议与状态机，平台路径/凭据/打包测试矩阵分别覆盖 |

## 18. 验收标准

功能只有在以下证据全部成立时才算完成：

1. 新用户仅输入 Bot Token，即可完成专用 Bot 连接；Token 不会在重新打开设置时回显。
2. 私聊、群组/超级群组和频道都能被发现、测试并设为默认接收位置。
3. 开启后完成的新下载会在最终后处理返回后自动发送；开启前历史不会被批量补发。
4. MP4、MP3/M4A 和其他文件分别走视频、音频和原文件路径，媒体不兼容时可自动降级。
5. 大于 `2_000_000_000` 字节的文件保留本地且只发送通知，不产生上传尝试。
6. Telegram 失败不会改变下载的 `completed` 状态，也不会删除或移动下载成品。
7. 网络错误、5xx 和 429 能按规则恢复；权限、认证和文件错误能给出明确行动。
8. 应用重启后到期任务继续发送，`sent` 不重复，发送中崩溃只进入 `uncertain`。
9. 切换目标只影响未来记录；断开连接删除加密 Token、取消未开始记录并保留文件与历史。
10. 代码搜索、单元测试和运行时捕获共同证明 Token 不在 Sidecar、设置、SQLite、日志、快照和持久化 Renderer 状态中。
11. DMG 与 NSIS 均包含正确平台的官方本地服务，并分别通过启动、发送、退出和路径冒烟。
12. Python、Electron、React、浏览器扩展回归测试和两个桌面构建均通过。

## 19. 建议实施切片

1. Sidecar 数据模型、`output_ready_at`、状态机和协议，先以测试固定幂等与恢复语义。
2. Electron 凭据保管、本地服务路径与 Supervisor，先用假服务验证双平台进程生命周期。
3. Bot 绑定迁移、目标发现、测试消息和窄化 preload IPC。
4. 串行发送工作器、媒体分类、超限通知、错误分类和重试。
5. “发送”设置页、任务状态与最近发送交互。
6. 官方本地服务的 macOS/Windows 构建、资源装配、许可证和安装包校验。
7. 全量回归、双平台真实 Bot 冒烟与发布清单更新。

每个切片都必须保持下载主流程可用；Telegram 未连接或本地服务不可用时，下载、历史和浏览器扩展入队不受影响。

## 20. 决策记录

- 采用官方本地 Bot API 服务，不采用云端 50 MB 路径或 MTProto。
- 用户只配置 Bot Token；Downany 负责应用级 Telegram 构建凭据。
- 单 Bot、单默认目标、所有新完成下载自动发送。
- 支持私聊、群组、超级群组和频道。
- 自动按视频、音频、原文件分类；不兼容时降级原文件。
- 超过 2000 MB 不切片、不压缩，只通知并保留本地文件。
- 下载成功与发送成功解耦。
- Token 由 macOS Keychain / Windows DPAPI 支撑的 Electron `safeStorage` 保护。
- 双平台安装包随附并监护官方本地服务。
- 发现会话只持久化下一次请求要使用的 `telegram_next_update_offset`，不保存“最后 update ID”；这样字段名、写入值与 Telegram `getUpdates` 的 offset 语义保持一致。
