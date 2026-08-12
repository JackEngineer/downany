# Telegram 云端大视频分段设计

## 背景与目标

Telegram 云端 Bot API 的单次文件上传上限为 50,000,000 bytes。当前百纳遇到更大的视频时只发送说明文字和来源链接；用户需要收到实际下载好的视频。

本设计保留两条发送路径：

1. 如果打包内的本地 Bot API 已取得用户自己的 `api_id`/`api_hash` 并成功启动，继续按现有路径发送单个、最大 2 GB 的文件。
2. 如果只能使用云端 Bot API，视频超过 50 MB 时自动切成若干个不超过 49,000,000 bytes 的可播放片段，逐段发送。

原始下载文件永不修改、移动或删除。只有整组片段全部被 Telegram 明确确认并且本地最终状态已提交后，才删除临时片段。

## 用户体验

- 小于等于云端上限：仍发送一个视频，行为不变。
- 大于云端上限的视频：聊天中收到 `第 1/N 段`、`第 2/N 段`……，每段均可独立播放。
- 大于云端上限的音频或普通文档：维持当前“保留本地文件并说明上限”的行为，本次不引入通用二进制切块。
- 分段失败：发送记录显示明确失败原因，不再用来源链接冒充已上传视频。
- 应用或电脑中断：已经明确成功的片段不会重复发送；结果不确定的当前片段进入“可能重复”状态，必须由用户确认后才重试。

## 分段策略

Electron Main 新增独立 `TelegramVideoSegmenter`：

- 只接受普通文件、`mediaKind=video`、绝对输入路径和受控的应用数据目录。
- 使用随包提供的 `ffmpeg`，先读取媒体时长，再按 `duration × 45,000,000 / sourceSize` 估算片段时长。
- 首轮使用 stream copy，避免无谓降画质；每轮都逐个 `stat` 并计算 SHA-256，任何片段达到 49,000,000 bytes 即缩短时长重试。
- 如果关键帧间隔导致多轮 stream copy 仍无法满足上限，最后改用 H.264/AAC 快速转码并强制片段边界。
- 最多执行有界次数；失败时清理本次未持久化的临时目录并返回稳定错误码。
- 临时根目录固定为 `<DOWNANY_DATA_DIR>/telegram/segments/<deliveryId>`；拒绝链接、重解析点、越界路径和非普通文件。

## 持久化与恢复

Sidecar SQLite 为每条 delivery 持久化：

- canonical segment manifest：源文件 size/mtime、片段相对文件名、size、SHA-256、总段数；
- `segment_next_index`：下一段索引；
- 已确认成功的 Telegram message ID 列表。

状态机保持已有 `preparing → sending` 语义，但以“每一段”为一次网络提交：

1. `preparing` 中生成并持久化 manifest；此时尚未向 Telegram 提交。
2. 每段发送前调用 `markSending`，进入 `sending`。
3. Telegram 明确返回 message ID 后调用 `markSegmentSent`：原子追加 message ID，并在尚有下一段时回到 `preparing`；最后一段则进入 `sent`。
4. 如果在段与段之间重启，过期的 `preparing` lease 会安全重领并从 `segment_next_index` 继续。
5. 如果在某段网络请求期间中断，`sending` 按现有恢复规则进入 `uncertain`；已提交的前序索引不回退。

这样可以避免“前 3 段已成功，重启后又从第 1 段开始”的重复发送。

## 安全与清理

- Token 仍只由 Electron Credential Vault 持有，分段器和 Sidecar 都不接触 Token。
- Renderer 不接收原始路径、临时路径或 manifest。
- ffmpeg 参数使用数组传递，不经 shell；进程隐藏窗口，并响应 Worker 的 AbortSignal。
- manifest 在写入数据库前校验字段集合、顺序、大小上限、SHA-256 和目录 containment。
- 已发送部分的临时文件缺失或哈希不匹配时 fail closed，不重新划分已有进度，避免片段索引漂移。
- 全部成功后清理临时目录；失败/不确定状态保留片段以支持恢复。启动时只清理没有数据库 owner 的孤儿目录。

## 验证标准

- 单元测试证明：49 MB 不分段；超过 50 MB 会分段；每个输出小于 49 MB；原文件未变化。
- 数据库测试证明：每段 message ID/next index 原子推进；段间强杀只续发下一段；发送中强杀进入 uncertain。
- Worker 测试证明：caption 顺序正确、已完成段不重复、非视频仍走说明消息。
- Windows 打包测试证明：打包应用能找到 ffmpeg，并能在 Unicode + 空格数据目录中生成和清理片段。
- 真机验收：用现有约 148.83 MB 视频，通过云端 Bot API 收到全部可播放片段；原视频仍在本地；不再出现来源链接代替文件。
