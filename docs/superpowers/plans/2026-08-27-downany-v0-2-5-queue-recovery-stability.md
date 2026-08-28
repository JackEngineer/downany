# Downany v0.2.5 队列与恢复稳定性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Implementation stays sequential. The mandatory requesting-code-review skill may use one independent read-only reviewer; do not delegate implementation without explicit user authorization.

**Goal:** 让长时间队列在暂停、退出、Sidecar 异常、Electron 重启或系统重启后保持任务、分组、顺序与成品一致，并确保 Telegram 发送失败不改变下载完成结果。

**Architecture:** 在六种公共任务状态之外持久化内部运行意图，所有单项和批量动作先由纯状态机决策，再通过单事务队列 API 提交。Sidecar 批量持久化最新进度，Electron 将高频单项事件合并成 Renderer patch；恢复、排序和发送解耦都由确定性场景验证。

**Tech Stack:** Python 3.11、SQLite WAL、pytest、Electron 33、TypeScript 5、React 18、Zustand 5、Vitest 2、yt-dlp、ffmpeg/ffprobe

**Spec:** `docs/superpowers/specs/2026-08-26-downany-v0-3-staged-upgrade-design.md`

## Global Constraints

- **用户范围调整（2026-08-27）：** 先读 `docs/superpowers/specs/2026-08-27-downany-windows-execution-scope.md`。本任务只负责 Windows 与扩展；不执行或等待 Mac 构建/验收，保留现有 Mac 实现和历史资产。

- 计划日期：2026-08-27。
- 代码审计基线是 v0.2.4 候选工作树 `c7709bc`。按用户最新要求，不等手动验收：使用该 HEAD 加已核对候选差异创建独立本地基线，记录源码校验并重新跑完整自动化；不得把此基线写成已提交或已集成。

### 执行修订与证据索引（2026-08-27）

- 任务 1–12 的本地实现、审查与自动化门槛均已完成；逐项 RED/GREEN 原始记录位于隔离工作树 `.build/v025-execution/progress.md`，可共享的验证结果位于 `docs/acceptance/v0.2.5-queue-recovery-stability.md`。下面设计期命令与可选提交/人工步骤保留作参考，不表示这些未授权动作已执行。
- 当前依赖通过已核对 junction 复用。构建不用会运行 `npm ci` 或清理旧 release 目录的整套脚本；直接运行等价的 PyInstaller、生产构建和 electron-builder 步骤，并禁用依赖重建与发布。媒体工具复用已验证文件，复制前后核对 SHA-256。
- 第一轮包已完成真实旧版迁移和 5 轮包级恢复，但随后审查发现边界问题，因此保留为 R1 历史记录，不再作为最终候选。修订包写入独立 `desktop/release-v0.2.5-queue-recovery-reviewed/`；源码/资源清单与哈希写入 `.build/v025-execution/r2/`，不覆盖第一轮证据。
- 优先级切换也执行组连续归一化；受影响的外组顺序与组优先级在同一事务中写入或回滚。
- 重排响应仅合并现存任务的排序字段，不以旧全量快照覆盖生命周期。组/全部操作刷新保留请求期间收到的完成、移除、新任务、进度与设置变化；请求记录有界且在成功或失败后释放。
- 包级 Electron smoke 强制设置仅测试使用的 `DOWNANY_SKIP_PROTOCOL_REGISTRATION=1`，避免即使用临时数据目录仍改写系统 `downany://` 关联；正常用户启动行为不变。
- 独立只读审查发现的两个 Important 均已复现、修复并通过复核；修订后 758 项 Python、410 项桌面测试、Windows 包级迁移/恢复/媒体/启动门槛均已实际通过。审查不代替测试，也不产生提交/发布授权。
- 本版本形成可追溯的本地候选后即可推进后续阶段，不等待人工安装、Mac 或未经授权的提交/合并。

### 进入条件与授权边界

- [ ] 从可追溯的 v0.2.4 候选源码快照开始；不得直接在旧路线图分支或当前脏的 v0.2.4 候选工作树上叠加。不再等待人工验收或把未经授权的合并当作开发前置步骤。
- [ ] 重新读取当前 `AGENTS.md`、`docs/RELEASE.md`、最新发布说明和 `.github/workflows/ci.yml`，记录与本计划不同的代码事实。
- [ ] 记录 `git status --short --branch`、`git rev-parse HEAD`、`git worktree list --porcelain`；若用户已有改动与本计划文件重叠，先停在只读诊断边界。
- [ ] 创建短分支 `fix/v0.2.5-queue-recovery-stability` 并核对继承的 v0.2.4 差异，不创建长寿命 v0.3.0 分支。
- [ ] 在第一次 RED 前跑完 Python、Electron、扩展和生产构建基线；基线本身失败时先定位原因，不把既有失败混进 v0.2.5。
- [ ] 安装 Windows NSIS 属于操作时确认动作；真正启动安装器前只做一次明确的当次确认，不在规划、测试和静态核对阶段反复询问。
- [ ] 未经单独明确授权，不提交、不合并、不推送、不打 tag、不触发远程 CI、不上传产物、不创建或发布 GitHub Release，也不删除分支/工作树。

### 提交模式

每个任务末尾都给出一个逻辑提交检查点，以便审查和回退：

- 若用户在实施开始前明确授权“v0.2.5 可按任务创建本地提交”，执行这些检查点。
- 若只授权最终一个本地候选提交，跳过中间提交命令，仅记录每个 GREEN 的测试证据，最后执行任务 12。
- 若没有本地提交授权，所有 `git commit` 命令均不得执行；这不影响继续完成安全、可逆的本地实现与验证。
- 任何本地提交授权都不自动包含 merge、push、tag、CI、上传或发布授权。

## 1. 冻结合同

### 1.1 公共状态与内部运行意图

公共状态保持六种，不新增 UI 状态：

```python
class TaskStatus(Enum):
    PENDING = "pending"
    DOWNLOADING = "downloading"
    PAUSED = "paused"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class TaskRunIntent(str, Enum):
    RUN = "run"
    PAUSE = "pause"
```

`TaskRunIntent` 定义在 `src/core/download_task.py`，避免 `download_task.py` 与新状态机模块互相导入。它只持久化，不进入 `TaskSnapshot`。

### 1.2 操作状态机

| 当前状态 | 操作 | 持久化结果 | 结果 |
| --- | --- | --- | --- |
| `pending` | pause | `paused + pause` | applied |
| `downloading` | pause | `paused + pause`，旧 worker 排空 | applied |
| `paused + run`（等待旧 worker 结束后继续） | pause | `paused + pause`，撤回待继续意图 | applied |
| `paused` 且无旧 worker | resume | `pending + run` | applied |
| `paused` 且旧 worker 仍在 | resume | 暂存 `paused + run`，旧 worker 退出后转 `pending` | deferred |
| `failed` / `cancelled` 且无旧 worker | retry | `pending + run`，清理瞬态失败/进度字段 | applied |
| `failed` / `cancelled` 且旧 worker 仍在 | retry | `paused + run`，清理瞬态字段，旧 worker 退出后转 pending | deferred |
| `pending` / `downloading` / `paused` | cancel | `cancelled + pause` | applied |
| 不兼容状态 | 任意操作 | 不变 | skipped / `incompatible_status` |
| 不存在的 ID | 任意操作 | 不变 | skipped / `task_not_found` |

重试时只从当前设置刷新：

```python
task.options.proxy = current.proxy
task.options.cookies_from_browser = current.cookies_from_browser
task.options.speed_limit = current.speed_limit
task.options.concurrent_fragments = current.concurrent_fragments
```

必须保留任务自己的 `output_path`、`quality`、`format_id`、`audio_only`、后处理、`http_headers` 和 `cookiefile`；其中后两项可能来自该任务的网页识别上下文，不能被全局设置抹掉。

### 1.3 恢复归一化

| 数据库状态 / 意图 | 新进程中的状态 |
| --- | --- |
| `downloading + run` | `pending + run` |
| `downloading + pause` | `paused + pause` |
| `paused + run` | `pending + run` |
| `paused + pause` | `paused + pause` |
| `pending + pause` | `paused + pause` |
| `completed` / `failed` / `cancelled` | 状态不变 |

旧行的 `run_intent` 为空：旧 `paused` 派生为 `pause`，其余状态派生为 `run`。未知值同样按这个保守规则处理，不能阻断整个队列加载。

### 1.4 顺序、分组和优先级

- 可调度状态集合固定为 `pending/downloading/paused`；`failed/cancelled/completed` 不出现在重排 payload 中。
- 调度和 Renderer 的活动队列统一使用 `priority DESC, queue_order ASC, created_at ASC, id ASC`。
- 一个播放列表/合集是一个顶层队列单元；payload 中该组所有可调度子任务必须连续，并严格按 `playlist_index ASC, created_at ASC, id ASC` 展开。
- 重排 payload 必须恰好包含当前每个可调度任务 ID 一次。未知、重复、缺失、组拆分、组内乱序或优先级带倒置均整批拒绝。
- “上移/下移/移到本优先级顶部”只在同一优先级带内移动；跨优先级由“设为高优先级/取消高优先级”完成。
- 修改组内任一任务的优先级时，对该组所有未完成任务（含可重试的 `failed/cancelled`）原子更新，防止重试后组被拆开；`completed` 保持历史事实不变。
- 恢复旧队列时，若同一组未完成成员优先级不一致，采用其中最高优先级；已完成记录不参与归一化。恢复、添加组成员和重试入组都保持组连续及集数顺序，必要的顺序修正与本次更改在同一事务中提交。

### 1.5 原子操作报告

新增向后兼容方法：

```text
download.applyGroupAction
{ "groupId": "playlist-acceptance-01", "action": "pause|resume|cancel|retry" }
```

单项、整组和全部任务操作都使用同一报告结构：

```typescript
interface TaskActionEntry {
  taskId: string;
  status: string;
  reason?: "incompatible_status" | "task_not_found";
}

interface TaskActionReport {
  action: "pause" | "resume" | "cancel" | "retry";
  applied: TaskActionEntry[];
  deferred: TaskActionEntry[];
  skipped: TaskActionEntry[];
}
```

现有 `download.pause/resume/cancel/retry/pauseAll/resumeAll` 保留。单项方法遇到不存在或不兼容状态时返回稳定协议错误；批量方法返回报告，Renderer 依据真实计数显示成功、部分完成或无可操作项，不能吞错后显示成功。

### 1.6 进度批次

Sidecar 对外仍发送兼容的单项 `task.progress`。Electron 不再先广播原事件，而是在 100 ms 窗口内按任务保留最新 patch，再向 Renderer 发送内部事件：

```typescript
interface TaskProgressPatch {
  taskId: string;
  progress: {
    progress?: number;
    downloaded_bytes?: number;
    total_bytes?: number;
    _speed_str?: string;
    _eta_str?: string;
  };
}

{
  event: "task.progressBatch",
  payload: { updates: TaskProgressPatch[] }
}
```

终态事件广播前先丢弃该任务尚未发送的 patch。Renderer 继续兼容单项 `task.progress`，但批次路径只扫描任务数组一次，且不允许批次修改 `completed/failed/cancelled`。

## 2. 文件落点

- 新建 `src/core/task_actions.py`：纯操作/恢复决策与稳定结果类型。
- 新建 `src/core/progress_buffer.py`：按任务覆盖的有界进度缓冲，不创建逐任务 timer。
- 修改 `src/core/download_task.py`、`src/core/download_manager.py`：运行意图、原子操作、恢复、排序和进度持久化。
- 修改 `src/data/queue_store.py`：迁移字段、ON CONFLICT upsert、批量事务 API。
- 修改 `src/sidecar/protocol.py`、`src/sidecar/handlers.py`、`src/sidecar/server.py`：新方法、真实报告、节流状态回收。
- 修改 `desktop/electron/protocol.ts` 及测试：补齐 `download.applyGroupAction` allowlist/type。
- 新建 `desktop/electron/taskProgressRelay.ts` 及测试；修改 `main.ts`、`taskTracker.ts`。
- 新建 `desktop/renderer/lib/queueOrdering.ts`、`components/QueueOrderControls.tsx` 及测试；修改 `TaskList.tsx`、`PlaylistGroupCard.tsx`、`MediaTaskBanner.tsx`、`ActionBar.tsx` 和任务命令/菜单。
- 修改 `desktop/renderer/lib/types.ts`、`store/appStore.ts` 及测试：批次 patch。
- 新建固定恢复、规模和资源矩阵测试；补齐 Telegram 解耦特征测试。
- 最后修改版本源、路线图、发布说明和验收记录。

### 设计范围覆盖

| v0.2.5 设计范围 | 实施任务 | 证据门槛 |
| --- | --- | --- |
| 队列重排、分组、优先级持久化 | 2、5 | 重启 round-trip、非法 payload 全回滚、Windows 20 项可见队列 |
| 暂停、继续、取消、失败重试、整组操作 | 1、3、4 | 状态表参数测试、barrier 并发测试、真实 mixed-state 组 |
| Sidecar/Electron/系统重启恢复 | 3、8 | 固定恢复场景 20 轮、每个平台可见 5 轮与一次 OS 重启 |
| 分片并发、任务并发、限速 | 8 | 24 组参数矩阵与Windows 真实资源观察 |
| Renderer、SQLite、日志体积 | 6、7、8 | 最新值批次、1,000 行、节流回收与无无界日志 |
| Telegram 与下载结果解耦 | 9 | Python 跨服务测试、Electron delivery E2E、真实发送失败 |

---

## 任务 1：用纯函数锁定状态机

**文件**

- 新建：`src/core/task_actions.py`
- 新建：`tests/core/test_task_actions.py`
- 修改：`src/core/download_task.py`
- 修改：`tests/core/test_task_snapshot.py`

**Interfaces:** consumes `TaskStatus` and `DownloadTask`; produces `TaskRunIntent`, `TaskAction`, `TaskActionOutcome`, `decide_task_action(...)`, and `normalize_restored_task(...)` as side-effect-free contracts used by persistence and the manager.

- [ ] **Step 1: 先写参数化失败测试**

测试直接覆盖 1.2 和 1.3 的每一行，并额外覆盖：

```python
@pytest.mark.parametrize(
    ("status", "intent", "action", "worker_active", "outcome", "next_status", "next_intent"),
    [
        (TaskStatus.PENDING, TaskRunIntent.RUN, TaskAction.PAUSE, False,
         TaskActionOutcome.APPLIED, TaskStatus.PAUSED, TaskRunIntent.PAUSE),
        (TaskStatus.PAUSED, TaskRunIntent.PAUSE, TaskAction.RESUME, True,
         TaskActionOutcome.DEFERRED, TaskStatus.PAUSED, TaskRunIntent.RUN),
        (TaskStatus.CANCELLED, TaskRunIntent.PAUSE, TaskAction.RETRY, False,
         TaskActionOutcome.APPLIED, TaskStatus.PENDING, TaskRunIntent.RUN),
    ],
)
def test_decide_task_action(
    status,
    intent,
    action,
    worker_active,
    outcome,
    next_status,
    next_intent,
):
    decision = decide_task_action(
        status,
        intent,
        action,
        worker_active=worker_active,
    )
    assert decision.outcome is outcome
    assert decision.next_status is next_status
    assert decision.next_intent is next_intent
```

- 证明 `completed + retry` 为 `skipped/incompatible_status`。
- 证明空/未知意图：`paused` 派生 `pause`，其余派生 `run`。
- 证明 `DownloadTask.to_snapshot()` 不包含 `run_intent`，公共状态仍只有六种。

- [ ] **Step 2: 运行并确认 RED**

```powershell
python -m pytest tests/core/test_task_actions.py tests/core/test_task_snapshot.py -q
```

预期失败原因必须是模块/字段/决策函数尚不存在，不接受无关环境错误作为 RED。

- [ ] **Step 3: 实现最小状态机**

```python
class TaskAction(str, Enum):
    PAUSE = "pause"
    RESUME = "resume"
    CANCEL = "cancel"
    RETRY = "retry"


class TaskActionOutcome(str, Enum):
    APPLIED = "applied"
    DEFERRED = "deferred"
    SKIPPED = "skipped"


@dataclass(frozen=True)
class TaskActionDecision:
    outcome: TaskActionOutcome
    next_status: TaskStatus
    next_intent: TaskRunIntent
    reset_for_retry: bool = False
    reason: str = ""


```

目标函数签名：

- `decide_task_action(status: TaskStatus, intent: TaskRunIntent, action: TaskAction, *, worker_active: bool) -> TaskActionDecision`
- `parse_stored_run_intent(status: TaskStatus, raw: object) -> TaskRunIntent`
- `normalize_restored_state(status: TaskStatus, intent: TaskRunIntent) -> tuple[TaskStatus, TaskRunIntent]`

在 `DownloadTask` 上新增 `run_intent: TaskRunIntent = TaskRunIntent.RUN`；不修改 `TaskSnapshot` 字段。

- [ ] **Step 4: 确认 GREEN**

```powershell
python -m pytest tests/core/test_task_actions.py tests/core/test_task_snapshot.py -q
```

- [ ] **Step 5: 逻辑提交检查点**

仅在“按任务本地提交”已明确授权时执行：

```powershell
git add src/core/download_task.py src/core/task_actions.py tests/core/test_task_actions.py tests/core/test_task_snapshot.py
git commit -m "test(queue): lock task transition contract"
```

---

## 任务 2：让队列字段和批量写入可恢复、可回滚

**文件**

- 修改：`src/data/queue_store.py`
- 修改：`tests/data/test_queue_store.py`
- 修改：`tests/core/test_queue_restore.py`

**Interfaces:** consumes the task model and action-decision fields from task 1; produces idempotent column migration plus `upsert_tasks(...)`, `apply_task_actions(...)`, and rollback-safe queue reads on one SQLite transaction.

- [ ] **Step 1: 先写迁移和事务失败测试**

新增列：

```sql
run_intent TEXT NOT NULL DEFAULT ''
started_at TEXT NULL
completed_at TEXT NULL
```

测试必须覆盖：

- 新任务完整 round-trip：意图、`started_at`、`completed_at`、优先级、顺序和组字段均相同。
- 手工创建旧 `task_queue` 表后初始化 `QueueStore`，旧暂停行保持暂停，旧下载中行可安全派生为 run。
- 在第二条 upsert/delete/order/progress 写入上由 SQLite trigger 执行 `RAISE(ABORT, 'injected batch failure')`，确认第一条也回滚。
- `rewrite_queue_order` 在重复、未知、缺失 ID 时第一条 UPDATE 都不执行。
- `update_progress_many` 只改四个进度字段和 `updated_at`，不改状态、意图、错误或完成时间。

- [ ] **Step 2: 运行并确认 RED**

```powershell
python -m pytest tests/data/test_queue_store.py tests/core/test_queue_restore.py -q
```

- [ ] **Step 3: 实现单连接单事务 API**

目标 API：

- `upsert_tasks(self, tasks: Sequence[DownloadTask]) -> None`
- `remove_tasks(self, task_ids: Sequence[str]) -> None`
- `rewrite_queue_order(self, ordered_ids: Sequence[str]) -> None`
- `update_progress_many(self, rows: Sequence[tuple[str, float, int, int]]) -> None`

实现约束：

- 提取一个 `_serialize_task(task)`，让单项 `upsert_task` 调用 `upsert_tasks([task])`，避免两套字段列表漂移。
- 用 `INSERT ... ON CONFLICT(id) DO UPDATE SET ...` 替代 `INSERT OR REPLACE`。
- 每个批量方法只调用一次 `_get_connection()`，在进入第一条写操作前验证空 ID、重复 ID、数据库缺失 ID和重排集合。
- `rewrite_queue_order` 只比较数据库中 `pending/downloading/paused` 行；payload 与该集合必须严格相等，然后按 payload 下标更新。
- `_row_to_task` 使用 `parse_stored_run_intent`，并安全解析两个可空 ISO 时间。

- [ ] **Step 4: 确认 GREEN**

```powershell
python -m pytest tests/data/test_queue_store.py tests/core/test_queue_restore.py -q
```

- [ ] **Step 5: 逻辑提交检查点**

```powershell
git add src/data/queue_store.py tests/data/test_queue_store.py tests/core/test_queue_restore.py
git commit -m "feat(queue): persist recovery intent transactionally"
```

只在中间提交已授权时执行。

---

## 任务 3：在 DownloadManager 中落实暂停、继续、取消、重试和崩溃恢复

**文件**

- 修改：`src/core/download_manager.py`
- 修改：`tests/core/test_download_manager.py`
- 修改：`tests/core/test_queue_restore.py`

**Interfaces:** consumes the pure decisions from task 1 and transactional store operations from task 2; produces one `apply_task_action(...)` manager entry point, durable restore normalization, and the single-active-worker invariant.

- [ ] **Step 1: 写失败的并发与恢复测试**

- pending 任务在调度器选中前暂停，连续等待两个调度周期也不能启动。
- 使用 `threading.Event` 控制旧 worker：下载中暂停后立即继续，持久化为 `paused + run`；旧 worker 退出前 active worker 始终只有一个，退出后才转 pending。
- 数据库预置 `downloading + run` 模拟进程死亡，新 manager 恢复为 pending；`paused + pause` 恢复后保持暂停。
- `stop()` 将正在运行但用户仍希望运行的任务保存为 `paused + run`，新 manager 恢复为 pending。
- failed 不自动重试；cancelled 只有显式 retry 才回 pending。
- retry 清空 `error_message/error_code/completion_note/progress/downloaded_bytes/total_bytes/started_at/completed_at`，保留 ID、组、顺序、输出/格式选项。
- 对已完成文件做 SHA-256，两次 restore 后字节和状态均不变。
- 注入 `QueueStore.upsert_tasks` 失败，证明原 `DownloadTask` 对象本身的字段全部恢复，worker 持有的对象引用没有被替换。

- [ ] **Step 2: 运行并确认 RED**

```powershell
python -m pytest tests/core/test_download_manager.py tests/core/test_queue_restore.py -q
```

- [ ] **Step 3: 实现统一入口**

```python
@dataclass(frozen=True)
class TaskActionResult:
    task_id: str
    action: TaskAction
    outcome: TaskActionOutcome
    status: TaskStatus | None
    reason: str = ""
```

统一入口签名为 `apply_task_action(self, task_id: str, action: TaskAction) -> TaskActionResult`。

实现顺序：

1. 在 `self._lock` 内查任务和 `worker_active = task_id in self.active_tasks`。
2. 调用纯决策函数；skipped 不写库。
3. 对原对象所有 dataclass 字段做深拷贝 checkpoint，再原位应用决策，不能用新对象替换 `self.tasks[task_id]`。
4. 对 retry 执行 1.2 中明确的四项设置刷新与瞬态字段清理。
5. 调用会抛错的 `_persist_tasks_or_raise`；失败时在锁内把 checkpoint 逐字段恢复到同一对象，然后抛 `QueueMutationError`。
6. 提交成功并释放锁后才发送 `task_paused/task_cancelled/task_updated` 等事件。

删除 `_resume_requested`。worker `finally` 只在同一对象为 `paused + run` 时改为 pending 并持久化；`cancelled`、`failed`、`paused + pause` 都不得重新入队。

`restore_tasks()` 先加载全部行，在锁内统一归一化，再用一次 `upsert_tasks` 保存确实变化的行。`stop()` 对所有 active task 保留 run intent、改为 paused，并在一次批量持久化后等待线程退出。

- [ ] **Step 4: 确认 GREEN 和核心回归**

```powershell
python -m pytest tests/core/test_download_manager.py tests/core/test_queue_restore.py -q
python -m pytest tests/core -q
```

- [ ] **Step 5: 逻辑提交检查点**

```powershell
git add src/core/download_manager.py tests/core/test_download_manager.py tests/core/test_queue_restore.py
git commit -m "fix(queue): make pause and recovery durable"
```

只在中间提交已授权时执行。

---

## 任务 4：让单项、整组和全部操作一次提交并如实反馈

**文件**

- 修改：`src/core/download_manager.py`
- 修改：`src/sidecar/protocol.py`
- 修改：`src/sidecar/handlers.py`
- 修改：`tests/core/test_download_manager.py`
- 修改：`tests/sidecar/test_protocol.py`
- 修改：`tests/sidecar/test_handlers.py`
- 修改：`desktop/electron/protocol.ts`
- 修改：`desktop/electron/protocol.test.ts`
- 修改：`desktop/renderer/components/PlaylistGroupCard.tsx`
- 新建：`desktop/renderer/components/PlaylistGroupCard.test.tsx`
- 修改：`desktop/renderer/components/shell/ActionBar.tsx`
- 修改：`desktop/renderer/components/shell/ActionBar.test.tsx`

**Interfaces:** consumes the manager's single-task action entry point; produces atomic manager batch APIs, JSONL batch request/response types, and a per-item `TaskActionReport` rendered identically by group and global actions.

- [ ] **Step 1: 先写协议、原子性和 UI 失败测试**

- Python 与 Electron 协议表都包含且只包含一次 `download.applyGroupAction`。
- 单项缺失 ID 返回“任务不存在”；状态不兼容返回“当前状态不能执行此操作”，不再返回 `{ok:true}`。
- 混合状态组一次请求后，报告精确列出 applied/deferred/skipped。
- pauseAll 同时处理 pending 和 downloading；resumeAll 处理 paused；scheduler 不能在批次迭代间启动 pending。
- 第二条数据库写入故障时，组内每个原对象与数据库全部回滚。
- PlaylistGroupCard 只发送一次新方法、只刷新一次；请求失败时显示错误且不显示成功。
- ActionBar 依据报告显示“已暂停 N 项”“没有可暂停的任务”或“已暂停 N 项，M 项未更改”。

- [ ] **Step 2: 运行并确认 RED**

```powershell
python -m pytest tests/core/test_download_manager.py tests/sidecar/test_protocol.py tests/sidecar/test_handlers.py -q
Push-Location desktop
npm.cmd test -- electron/protocol.test.ts renderer/components/PlaylistGroupCard.test.tsx renderer/components/shell/ActionBar.test.tsx
Pop-Location
```

- [ ] **Step 3: 实现 manager 原生批次**

```python
@dataclass(frozen=True)
class TaskActionBatchResult:
    action: TaskAction
    applied: tuple[TaskActionResult, ...]
    deferred: tuple[TaskActionResult, ...]
    skipped: tuple[TaskActionResult, ...]
```

目标 manager API：

- `apply_task_actions(self, task_ids: Sequence[str], action: TaskAction) -> TaskActionBatchResult`
- `apply_group_action(self, group_id: str, action: TaskAction) -> TaskActionBatchResult`
- `apply_all_action(self, action: TaskAction) -> TaskActionBatchResult`

`apply_task_actions` 在同一个 manager lock 中固定 ID、决策、checkpoint、修改和一次 `upsert_tasks`。数据库成功后才释放锁和发事件。

同时把 `remove_group` 改为：

1. 锁内固定组任务和文件路径；
2. 一次 `remove_tasks` 成功后从内存移除；
3. 锁外逐个删除用户明确要求删除的文件；
4. 返回 `removed` 和不含绝对路径的 `fileDeleteFailures`；数据库失败时任务和文件都不动。

- [ ] **Step 4: 实现 handler 与产品文案**

- `_pause/_resume/_cancel/_retry` 调用统一入口，并把 skipped 精确映射为 `HandlerError(INVALID_PARAMS, "任务不存在")` 或 `HandlerError(INVALID_PARAMS, "当前状态不能执行此操作")`。
- `_pause_all/_resume_all` 不再遍历调用单项方法，直接返回 `TaskActionReport`。
- 新增 `_apply_group_action`；严格验证 `groupId` 与 action union。
- `PlaylistGroupCard` 删除 `runForGroup` 和 `Promise.all(...catch)`。
- UI 只展示对象、动作和结果，例如“已恢复 4 项”；不出现“事务”“Sidecar”“协议”等内部词。

- [ ] **Step 5: 确认 GREEN**

```powershell
python -m pytest tests/core/test_download_manager.py tests/sidecar/test_protocol.py tests/sidecar/test_handlers.py -q
Push-Location desktop
npm.cmd test -- electron/protocol.test.ts renderer/components/PlaylistGroupCard.test.tsx renderer/components/shell/ActionBar.test.tsx
Pop-Location
```

- [ ] **Step 6: 逻辑提交检查点**

```powershell
git add src/core/download_manager.py src/sidecar/protocol.py src/sidecar/handlers.py tests/core/test_download_manager.py tests/sidecar/test_protocol.py tests/sidecar/test_handlers.py desktop/electron/protocol.ts desktop/electron/protocol.test.ts desktop/renderer/components/PlaylistGroupCard.tsx desktop/renderer/components/PlaylistGroupCard.test.tsx desktop/renderer/components/shell/ActionBar.tsx desktop/renderer/components/shell/ActionBar.test.tsx
git commit -m "fix(queue): make batch actions atomic and truthful"
```

只在中间提交已授权时执行。

---

## 任务 5：统一调度顺序、可见顺序、分组和优先级

**文件**

- 修改：`src/core/download_manager.py`
- 修改：`src/data/queue_store.py`
- 修改：`src/sidecar/handlers.py`
- 修改：`tests/core/test_download_manager.py`
- 修改：`tests/data/test_queue_store.py`
- 修改：`tests/sidecar/test_handlers.py`
- 新建：`desktop/renderer/lib/queueOrdering.ts`
- 新建：`desktop/renderer/lib/queueOrdering.test.ts`
- 新建：`desktop/renderer/components/QueueOrderControls.tsx`
- 新建：`desktop/renderer/components/QueueOrderControls.test.tsx`
- 修改：`desktop/renderer/components/TaskList.tsx`
- 修改：`desktop/renderer/components/TaskList.test.tsx`
- 修改：`desktop/renderer/components/PlaylistGroupCard.tsx`
- 修改：`desktop/renderer/components/task/MediaTaskBanner.tsx`
- 修改：`desktop/renderer/components/task/TaskActionsMenu.tsx`

**Interfaces:** consumes persisted priority, queue order, group identity, and current task state; produces the canonical scheduler key, strict reorder validation, normalized persisted order, and the equivalent TypeScript comparator and accessible reorder controls.
- 新建：`desktop/renderer/components/task/TaskActionsMenu.test.tsx`
- 修改：`desktop/renderer/components/task/useTaskCommands.ts`

- [ ] **Step 1: 写当前实现必然失败的排序测试**

- 两个不同 `queue_order` 的 pending 任务，高优先级任务必须先被 scheduler 选中；当前 `(queue_order, -priority, created_at)` 会失败。
- 混合独立任务和两个组，合法 payload 写库后重新创建 manager，得到完全相同的顶层顺序和组内顺序。
- 重复、未知、缺失、组不连续、组内 `playlist_index` 乱序、低优先级带排到高优先级带前面都整批失败，内存和 SQLite 不变。
- 修改组内任一未完成子任务优先级，所有未完成同组任务一次更新；注入写入失败时全部回滚。
- 纯 TS 测试覆盖建组、同优先级上移/下移/置顶、边界禁用、flatten payload 和 1,000 个任务。
- Renderer 控件点击一次只调用一次 `download.reorder`，使用所有任务构造 payload，不受当前筛选/搜索结果截断，并 hydrate 服务端返回的权威快照。

- [ ] **Step 2: 运行并确认 RED**

```powershell
python -m pytest tests/core/test_download_manager.py tests/data/test_queue_store.py tests/sidecar/test_handlers.py -q
Push-Location desktop
npm.cmd test -- renderer/lib/queueOrdering.test.ts renderer/components/QueueOrderControls.test.tsx renderer/components/TaskList.test.tsx renderer/components/task/TaskActionsMenu.test.tsx
Pop-Location
```

- [ ] **Step 3: 实现后端不变量**

调度 key 固定为：

```python
def _scheduler_key(task: DownloadTask) -> tuple[int, int, datetime, str]:
    return (-task.priority, task.queue_order, task.created_at, task.id)
```

`DownloadManager.reorder_tasks(ordered_ids)`：

1. 锁内取当前可调度任务；
2. 验证集合完全相等、优先级带不倒置、每个组连续且组内稳定排序；
3. 计算 `task_id -> queue_order`；
4. 先在一次事务中 `rewrite_queue_order`；
5. 成功后更新内存；失败时内存不变；
6. 返回按新 scheduler key 排序的完整快照。

`update_task(priority=...)` 对有 `group_id` 的任务改用一次批量 upsert，并在兼容的 `task` 字段之外增加 `tasks` 列表；Renderer 仍统一重新拉快照。

- [ ] **Step 4: 实现可访问的 Renderer 操作**

```typescript
type QueueUnit =
  | { kind: "task"; key: `task:${string}`; taskIds: [string]; priority: number }
  | { kind: "group"; key: `group:${string}`; taskIds: string[]; priority: number };

interface QueueOrderingContract {
  buildQueueUnits(tasks: TaskSnapshot[]): QueueUnit[];
  moveQueueUnit(
    units: readonly QueueUnit[],
    key: QueueUnit["key"],
    move: "up" | "down" | "top",
  ): string[];
}
```

- 实际模块导出同名函数 `buildQueueUnits` 与 `moveQueueUnit`，签名与上面的 contract 一致。
- `TaskList` 从 store 的完整任务数组生成顶层单元，并把控制器只传给顶层 `MediaTaskBanner` / `PlaylistGroupCard`；组内卡片不重复显示重排按钮。
- 按钮文案使用“上移”“下移”“移到同优先级顶部”，带可读 `aria-label`；边界位置禁用。
- 指针拖拽可以后加，但键盘可达按钮是 v0.2.5 必须验收路径。
- failed/cancelled/completed 继续按现有结果区语义显示，不参与可调度队列 payload。

- [ ] **Step 5: 确认 GREEN**

重复步骤 2 的两条命令；随后运行：

```powershell
python -m pytest tests/core/test_download_manager.py tests/data/test_queue_store.py tests/sidecar/test_handlers.py -q
Push-Location desktop
npm.cmd test -- renderer/lib/queueOrdering.test.ts renderer/components/QueueOrderControls.test.tsx renderer/components/TaskList.test.tsx renderer/components/task/TaskActionsMenu.test.tsx
Pop-Location
```

- [ ] **Step 6: 逻辑提交检查点**

```powershell
git add src/core/download_manager.py src/data/queue_store.py src/sidecar/handlers.py tests/core/test_download_manager.py tests/data/test_queue_store.py tests/sidecar/test_handlers.py desktop/renderer/lib/queueOrdering.ts desktop/renderer/lib/queueOrdering.test.ts desktop/renderer/components/QueueOrderControls.tsx desktop/renderer/components/QueueOrderControls.test.tsx desktop/renderer/components/TaskList.tsx desktop/renderer/components/TaskList.test.tsx desktop/renderer/components/PlaylistGroupCard.tsx desktop/renderer/components/task/MediaTaskBanner.tsx desktop/renderer/components/task/TaskActionsMenu.tsx desktop/renderer/components/task/TaskActionsMenu.test.tsx desktop/renderer/components/task/useTaskCommands.ts
git commit -m "fix(queue): align visible order with scheduling"
```

只在中间提交已授权时执行。

---

## 任务 6：批量持久化进度并回收节流状态

**文件**

- 新建：`src/core/progress_buffer.py`
- 新建：`tests/core/test_progress_buffer.py`
- 新建：`tests/core/test_progress_persistence.py`
- 修改：`src/core/download_manager.py`
- 修改：`src/data/queue_store.py`
- 修改：`src/sidecar/server.py`
- 修改：`tests/core/test_download_manager.py`
- 修改：`tests/data/test_queue_store.py`
- 修改：`tests/sidecar/test_server.py`

**Interfaces:** consumes `QueueStore.update_progress_many(...)` and manager progress callbacks; produces `ProgressUpdate`, `ProgressBuffer`, deterministic `flush()`/`close()` behavior, batched SQLite writes, and bounded Sidecar throttle bookkeeping.

- [ ] **Step 1: 先写确定性时钟测试**

```python
@dataclass(frozen=True)
class ProgressUpdate:
    task_id: str
    progress: float
    downloaded_bytes: int
    total_bytes: int
```

`ProgressBuffer` 的目标方法签名：

- `put(self, update: ProgressUpdate) -> None`
- `drain_due(self, *, force: bool = False) -> tuple[ProgressUpdate, ...]`
- `requeue(self, updates: Sequence[ProgressUpdate]) -> None`
- `discard(self, task_id: str) -> None`
- `clear(self) -> None`

测试覆盖：

- 注入 monotonic clock，10 个任务各 100 次 callback，在 2 秒前无写入，到点只生成一次含 10 个最新值的事务。
- batch 写入失败后 requeue；失败期间来了更新值时，新值覆盖旧值。
- full/terminal persist 与 progress flush 共用持久化锁：无论哪方先取得锁，最终数据库都是 completed + 100%，不会被 99% 回写。
- stop 后 buffer 为空且没有遗留 timer/thread。
- Sidecar 的 `_last_progress_emit` 在 pause、cancel、complete、fail 和 `task.removed` 时删除对应 key。

- [ ] **Step 2: 运行并确认 RED**

```powershell
python -m pytest tests/core/test_progress_buffer.py tests/core/test_download_manager.py tests/data/test_queue_store.py tests/sidecar/test_server.py -q
```

- [ ] **Step 3: 实现无逐任务 timer 的缓冲**

- `ProgressBuffer` 内部用一个 lock、一个 `dict[task_id, ProgressUpdate]` 和单个 `next_flush_at`。
- `drain_due` 原子取走当前最新值；`requeue` 只在该 ID 没有更晚值时放回，并把下次尝试推迟一个 interval，避免 0.3 秒 scheduler 循环持续打库。
- manager 新增 `_persistence_lock`，所有路径统一先取 manager lock、再取 persistence lock，避免锁顺序反转。`_flush_progress_due` 在两把锁内 drain + `update_progress_many`；full `_persist` 在同一临界区 upsert 成功后 discard，保证终态写最后生效，同时保留失败/回滚操作的待保存进度。
- scheduler 每轮最多调用一次 `_flush_progress_due`；progress callback 只更新内存、put 最新值、发事件，不直接开 SQLite 连接。
- `stop()` 在持久化锁内一次保存所有需保存的任务并清空 buffer。
- 进度热路径不写 INFO；异常只写有界 ERROR/WARNING，不记录 URL、Cookie 或响应正文。
- `SidecarServer._write_event` 负责清理 handler 发出的 `task.removed`；`_on_manager_event` 清理其余离开进度态的事件。

- [ ] **Step 4: 确认 GREEN**

```powershell
python -m pytest tests/core/test_progress_buffer.py tests/core/test_download_manager.py tests/data/test_queue_store.py tests/sidecar/test_server.py -q
```

- [ ] **Step 5: 逻辑提交检查点**

```powershell
git add src/core/progress_buffer.py src/core/download_manager.py src/data/queue_store.py src/sidecar/server.py tests/core/test_progress_buffer.py tests/core/test_download_manager.py tests/data/test_queue_store.py tests/sidecar/test_server.py
git commit -m "perf(queue): batch durable progress writes"
```

只在中间提交已授权时执行。

---

## 任务 7：合并 Electron 到 Renderer 的高频进度更新

**文件**

- 新建：`desktop/electron/taskProgressRelay.ts`
- 新建：`desktop/electron/taskProgressRelay.test.ts`
- 修改：`desktop/electron/main.ts`
- 修改：`desktop/electron/taskTracker.ts`
- 修改：`desktop/electron/taskTracker.test.ts`
- 修改：`desktop/renderer/lib/types.ts`
- 修改：`desktop/renderer/store/appStore.ts`
- 修改：`desktop/renderer/store/appStore.test.ts`

**Interfaces:** consumes Sidecar `task.progress` events and task terminal/drop notifications; produces `TaskProgressRelay.enqueue(...)`, one batched Electron payload, and `applyTaskProgressBatch(...)` for one-pass Renderer state updates.

- [ ] **Step 1: 先写 relay 和单次扫描测试**

- 注入 fake scheduler；同一任务多次 enqueue 只留下最新 patch，不同任务共享一个 flush。
- flush 输出 `payload.updates`，不输出整份 `TaskSnapshot[]`。
- terminal/drop 后旧 patch 不再发送；dispose 取消回调并释放 Map。
- TaskTracker 一次应用 100 条 patch，只更新存在的任务。
- Zustand 预置 1,000 个任务，一次应用 100 条 patch；结果正确、terminal 对象不变、未命中 ID 被忽略、只调用一次 `set`。
- 保留一个兼容测试，单项 `task.progress` 仍能更新 store。

- [ ] **Step 2: 运行并确认 RED**

```powershell
Push-Location desktop
npm.cmd test -- electron/taskProgressRelay.test.ts electron/taskTracker.test.ts renderer/store/appStore.test.ts
Pop-Location
```

- [ ] **Step 3: 实现 relay**

```typescript
export class TaskProgressRelay {
  constructor(
    private readonly onFlush: (updates: TaskProgressPatch[]) => void,
    private readonly schedule: (callback: () => void, delayMs: number) => unknown,
    private readonly cancel: (handle: unknown) => void,
    private readonly delayMs = 100,
  ) {}
}
```

该类公开 `enqueue(event: ProtocolEvent): void`、`drop(taskId: string): void`、`flush(): void` 和 `dispose(): void`。

在 `main.ts` 中必须先判断 `task.progress`，交给 relay 后立即 return，不能像当前实现一样先 `broadcastAll` 原事件。relay flush 时按顺序：

1. `taskTracker.applyProgressBatch(updates)`；
2. `broadcastAll("sidecar:event", {event:"task.progressBatch", payload:{updates}})`；
3. `updateDockUi(false)` 一次。

非进度事件仍立即广播；`task.completed/task.failed/task.removed` 在广播前先 `relay.drop(taskId)`。应用退出时 `dispose()`。

Renderer 提取纯函数：

Renderer 导出 `applyProgressBatch(tasks: readonly TaskSnapshot[], updates: readonly TaskProgressPatch[]) -> TaskSnapshot[]`。

实现为一个 ID→patch Map 加一次 `tasks.map`；只修改 pending/downloading/paused。

- [ ] **Step 4: 确认 GREEN 与 Electron 构建**

```powershell
Push-Location desktop
npm.cmd test -- electron/taskProgressRelay.test.ts electron/taskTracker.test.ts renderer/store/appStore.test.ts
npm.cmd run build
Pop-Location
```

- [ ] **Step 5: 逻辑提交检查点**

```powershell
git add desktop/electron/taskProgressRelay.ts desktop/electron/taskProgressRelay.test.ts desktop/electron/main.ts desktop/electron/taskTracker.ts desktop/electron/taskTracker.test.ts desktop/renderer/lib/types.ts desktop/renderer/store/appStore.ts desktop/renderer/store/appStore.test.ts
git commit -m "perf(desktop): coalesce progress rendering"
```

只在中间提交已授权时执行。

---

## 任务 8：建立可重复恢复、规模和资源组合门槛

**文件**

- 新建：`tests/core/test_queue_recovery_scenarios.py`
- 新建：`tests/core/test_queue_scale.py`
- 新建：`tests/core/test_resource_matrix.py`
- 修改：`tests/core/test_download_manager.py`
- 修改：`tests/core/test_output_contract.py`
- 修改：`tests/data/test_json_config.py`
- 修改：`src/data/json_config.py`

**Interfaces:** consumes the queue, recovery, batching, and configuration contracts from tasks 1–7; produces deterministic recovery/scale/resource test gates and clamped concurrency settings without adding a second runtime path.

- [ ] **Step 1: 固定恢复场景**

每一轮都使用新的 `tmp_path` 子目录和固定 ID：

1. 建立 4 个独立任务与两个三项组，设置明确的优先级/顺序。
2. 用 barrier 测试真实 manager 的 pending pause、active pause/resume 和单 worker 语义。
3. 在独立数据库中持久化精确的“进程突然消失”边界：`downloading+run`、`paused+pause`、failed、cancelled、completed 及真实成品 hash；不调用旧 manager 的 finally，不让旧 worker 与新 manager 同时存活。
4. 新建 manager，断言 ID、分组、优先级、顺序、归一化状态和 completed hash。
5. 显式 retry failed/cancelled，再用 fake downloader 完成队列。
6. 整个场景循环 20 次；每轮断言没有重复 ID、worker 或输出。

- [ ] **Step 2: 写规模和资源矩阵**

- 一次事务插入 1,000 行，重新加载、合法重排、再加载；断言连接/事务次数和精确结果，不使用脆弱的毫秒阈值。
- 参数矩阵为任务并发 `1/3/10` × 分片并发 `0/4/16/32` × 限速 `0/524288`，共 24 组。
- fake scheduler/downloader 断言 active worker 从不超过任务并发；`compile_output_plan` 对 0 省略 `concurrent_fragment_downloads/ratelimit`，对非零值精确透传。
- `JsonConfig` 对磁盘旧值、settings patch 和 `build_download_options` 都把 `concurrent_fragments` 限制到 `0..32`；任务并发继续限制 `1..10`。
- network error 经过 20 次重启仍保持 failed，除非显式 retry。
- retry 精确刷新 proxy、`cookies_from_browser`、speed limit 和 fragment concurrency，并保留 `http_headers/cookiefile` 与任务输出/格式选项。

- [ ] **Step 3: 运行并确认 RED**

```powershell
python -m pytest tests/core/test_queue_recovery_scenarios.py tests/core/test_queue_scale.py tests/core/test_resource_matrix.py tests/core/test_download_manager.py tests/core/test_output_contract.py tests/data/test_json_config.py -q
```

- [ ] **Step 4: 只修复场景暴露的缺口**

把 `JsonConfig` 的归一化改为：

```python
next_data["concurrent_fragments"] = min(
    32,
    max(0, int(next_data.get("concurrent_fragments", 4) or 0)),
)
```

其余修复必须对应一个先失败的断言；不在本任务引入新下载引擎、自动重试或额外公共状态。

- [ ] **Step 5: 确认 GREEN**

重复步骤 3 的完整命令，保存 20 轮和 24 组参数矩阵结果。

- [ ] **Step 6: 逻辑提交检查点**

```powershell
git add tests/core/test_queue_recovery_scenarios.py tests/core/test_queue_scale.py tests/core/test_resource_matrix.py tests/core/test_download_manager.py tests/core/test_output_contract.py tests/data/test_json_config.py src/data/json_config.py
git commit -m "test(queue): add repeated recovery and scale gates"
```

只在中间提交已授权时执行。

---

## 任务 9：证明 Telegram 结果与下载结果独立

**文件**

- 修改：`tests/core/test_download_manager.py`
- 修改：`tests/sidecar/test_telegram_delivery_service.py`
- 修改：`tests/data/test_telegram_delivery_store.py`
- 修改：`desktop/electron/telegram/controller.delivery.e2e.test.ts`

**Interfaces:** consumes existing download history, queue, Telegram delivery store, and Electron delivery controller interfaces; produces invariant tests proving that delivery retry/failure/uncertainty cannot mutate download completion, output bytes, or task identity.

这是现有架构的特征保护，首轮可以 GREEN；不得为了制造 RED 改写正常代码。

- [ ] **Step 1: 增加跨服务测试**

- 延续现有 `test_completed_download_is_enqueued_for_telegram_delivery`：下载完成并记录输出 hash 后，强制 Telegram 发送失败，断言 queue/history 仍为 completed、进度 100、文件 hash 不变。
- pending/failed/uncertain delivery 经重启恢复时，不得把任何下载任务改为 pending 或调用 `download.retry`。
- Telegram retry/cancel 不能修改下载进度、删除输出或创建第二个下载任务。
- Telegram store 故障只能使 delivery 更新失败/延后；不能让已验证下载回滚为 failed。

- [ ] **Step 2: 运行特征门槛**

```powershell
python -m pytest tests/core/test_download_manager.py tests/sidecar/test_telegram_delivery_service.py tests/data/test_telegram_delivery_store.py -q
Push-Location desktop
npm.cmd test -- electron/telegram/controller.delivery.e2e.test.ts
Pop-Location
```

若失败，先定位到具体耦合写入，再添加一个针对该耦合的 RED 测试和最小修复；若首轮 GREEN，仅保留测试。

- [ ] **Step 3: 逻辑提交检查点**

```powershell
git add tests/core/test_download_manager.py tests/sidecar/test_telegram_delivery_service.py tests/data/test_telegram_delivery_store.py desktop/electron/telegram/controller.delivery.e2e.test.ts
git commit -m "test(telegram): protect completed download state"
```

只在中间提交已授权时执行。

---

## 任务 10：升版并建立候选文档

**文件**

- 修改：`desktop/package.json`
- 修改：`desktop/package-lock.json`
- 修改：`src/sidecar/protocol.py`
- 修改：`tests/sidecar/test_protocol.py`
- 修改：`desktop/electron/sidecar.test.ts`
- 修改：`docs/roadmap.md`
- 新建：`docs/RELEASE-NOTES-0.2.5.md`
- 新建：`docs/acceptance/v0.2.5-queue-recovery-stability.md`

**Interfaces:** consumes the green v0.2.5 behavior and evidence from tasks 1–9; produces synchronized desktop/Sidecar version contracts, truthful roadmap/release notes, and an acceptance record that separates automated, packaged, and visible evidence.

- [ ] **Step 1: 先让版本合同 RED**

把 `tests/sidecar/test_protocol.py` 的一致性期望改为 `0.2.5`，并把 `desktop/electron/sidecar.test.ts` 的 hello fixture 改为 `0.2.5`：

```powershell
python -m pytest tests/sidecar/test_protocol.py -q
Push-Location desktop
npm.cmd test -- electron/sidecar.test.ts
Pop-Location
```

Python 版本合同应先因三个旧版本源仍为 0.2.4 而失败。

- [ ] **Step 2: 机械更新版本源**

```powershell
Push-Location desktop
npm.cmd version 0.2.5 --no-git-tag-version
Pop-Location
```

然后把 `src/sidecar/protocol.py::APP_VERSION` 改为 `0.2.5`。Electron peer hello 继续使用 `app.getVersion()`，不得重新写死版本。`browser-extension/manifest.json` 维持其独立扩展版本，除非本增量实际修改扩展代码。

- [ ] **Step 3: 写用户文档**

- 发布说明围绕长队列、可靠暂停/继续、重启恢复、真实组操作计数和高负载进度稳定性。
- 路线图只写已被源码/测试证明的事实，不提前写“双平台已验收”。
- 验收文档先记录源 SHA、分支、包模式、设备矩阵和所有门槛；每项初始状态必须为“未执行”，不得预填通过。
- 验收文档明确“本地候选不等于授权发布”。

- [ ] **Step 4: 确认版本 GREEN 和构建**

```powershell
python -m pytest tests/sidecar/test_protocol.py -q
Push-Location desktop
npm.cmd test -- electron/sidecar.test.ts
npm.cmd run build
Pop-Location
```

- [ ] **Step 5: 逻辑提交检查点**

```powershell
git add desktop/package.json desktop/package-lock.json src/sidecar/protocol.py tests/sidecar/test_protocol.py desktop/electron/sidecar.test.ts docs/roadmap.md docs/RELEASE-NOTES-0.2.5.md docs/acceptance/v0.2.5-queue-recovery-stability.md
git commit -m "chore(release): prepare v0.2.5 candidate"
```

只在中间提交已授权时执行。

---

## 任务 11：运行源码和 Windows 隔离包级自动化

**Interfaces:** consumes one reviewed v0.2.5 candidate source revision; produces source-test, package-smoke, and Windows-visible evidence with exact commands and artifact hashes; macOS is explicitly out of scope.

- [ ] **Step 1: 运行源码门槛**

在仓库根执行：

```powershell
python -m pytest tests/core tests/data tests/sidecar tests/cli -q

Push-Location desktop
$downanyHadNodeOptions = Test-Path Env:NODE_OPTIONS
$downanyPriorNodeOptions = $env:NODE_OPTIONS
try {
  $env:NODE_OPTIONS = "--no-experimental-webstorage"
  npm.cmd test
} finally {
  if ($downanyHadNodeOptions) {
    $env:NODE_OPTIONS = $downanyPriorNodeOptions
  } else {
    Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
  }
}
npm.cmd run build
Pop-Location

node browser-extension/shared.test.js
node browser-extension/sniff-core.test.js
node browser-extension/bridge-timeout.test.js
node --test scripts/test_packaged_media_tools.test.mjs scripts/package_smoke_helpers.test.mjs

$downanyHadBinDir = Test-Path Env:DOWNANY_BIN_DIR
$downanyPriorBinDir = $env:DOWNANY_BIN_DIR
$downanyHadMediaGate = Test-Path Env:DOWNANY_REQUIRE_MEDIA_INTEGRATION
$downanyPriorMediaGate = $env:DOWNANY_REQUIRE_MEDIA_INTEGRATION
try {
  $env:DOWNANY_BIN_DIR = (Resolve-Path "desktop\resources\bin").Path
  $env:DOWNANY_REQUIRE_MEDIA_INTEGRATION = "1"
  python -m pytest tests/core/test_media_pipeline_integration.py -q
} finally {
  if ($downanyHadBinDir) {
    $env:DOWNANY_BIN_DIR = $downanyPriorBinDir
  } else {
    Remove-Item Env:DOWNANY_BIN_DIR -ErrorAction SilentlyContinue
  }
  if ($downanyHadMediaGate) {
    $env:DOWNANY_REQUIRE_MEDIA_INTEGRATION = $downanyPriorMediaGate
  } else {
    Remove-Item Env:DOWNANY_REQUIRE_MEDIA_INTEGRATION -ErrorAction SilentlyContinue
  }
}

git diff --check
git status --short --branch
```

- [ ] 检查完整 diff：无无关 WIP、真实下载、数据库、日志、凭据、Cookie、Token、用户绝对路径和陈旧版本字面量。
- [ ] 记录每条命令、耗时、通过数和源码 SHA。

- [ ] **Step 2: 构建并验证 Windows x64 云端模式候选**

本地没有 Telegram 应用凭据时明确构建 cloud-only，不伪造 native：

```powershell
pwsh -NoProfile -Command {
  $env:BUILD_TELEGRAM_NATIVE = "0"
  $env:ALLOW_CLOUD_ONLY_PACKAGE = "1"
  $env:FETCH_BINS = "1"
  $env:BUILD_SIDECAR = "1"
  & .\scripts\build_windows_nsis.ps1
  exit $LASTEXITCODE
}

$winUnpacked = (Resolve-Path "desktop\release\win-unpacked").Path
$winData = Join-Path ([System.IO.Path]::GetTempPath()) ("downany-v025-sidecar-" + [guid]::NewGuid())
node scripts/test_packaged_media_tools.mjs --bin-dir="$winUnpacked\resources\bin"
node scripts/test_packaged_sidecar.mjs --executable="$winUnpacked\resources\sidecar\DownanySidecar\DownanySidecar.exe" --data-dir="$winData"
node scripts/test_packaged_electron.mjs --executable="$winUnpacked\Downany.exe"
Get-FileHash -Algorithm SHA256 -LiteralPath "desktop\release\Downany-0.2.5-win-x64.exe"
Get-AuthenticodeSignature -LiteralPath "desktop\release\Downany-0.2.5-win-x64.exe" | Format-List Status,StatusMessage,SignerCertificate
```

若已具备并明确选择 native，按 `docs/RELEASE.md` 先构建/验证 Bot API、ProcessHost 和凭据清单，再以 `ALLOW_CLOUD_ONLY_PACKAGE=0` 构建；验收记录不得混淆两种包模式。

- **Step 3: macOS 候选（本任务不执行）**

用户已明确排除 Mac 工作。不构建、不等待 DMG，不把此项计入未完成门槛；现有 Mac 脚本与实现保留。

- [ ] **Step 4: 构建并验证扩展 ZIP**

从同一验收源码构建，文件名使用 `browser-extension/manifest.json` 的独立版本：

```bash
mkdir -p desktop/release
(cd browser-extension && zip -r ../desktop/release/Downany-chrome-extension-0.8.2.zip . \
  -x '*.test.js' -x '.*' -x '__MACOSX*' -x '*.DS_Store')
unzip -l desktop/release/Downany-chrome-extension-0.8.2.zip
shasum -a 256 desktop/release/Downany-chrome-extension-0.8.2.zip
```

若扩展版本已在集成基线变化，按 manifest 实际版本替换文件名；不得把桌面 `0.2.5` 强写成扩展版本。

- **Step 5: Windows 可见恢复矩阵（按用户要求不执行）**

用户已明确“继续往后面做，不用手动验收”。以下保留为可选人工检查参考，不作为本地版本推进或接受条件，不要求用户打开应用、安装候选或重启操作系统；对应恢复与数据保留合同由任务 1–9 的真实 SQLite、进程和组件自动化，以及本任务包级验证覆盖。以下未执行项不得标为通过。

在 Windows 的隔离验收数据目录先做全新安装，再覆盖安装上一已接受版本。用 `DOWNANY_DATA_DIR` 启动已安装的真实二进制：先让 v0.2.4 在该目录生成设置、队列、历史和 Telegram 路由数据，关闭后覆盖安装 v0.2.5，再用同一路径启动。不得把合成压力数据写入用户默认 Downany 数据目录。启动安装器前执行一次操作时确认；确认后同一安装会话中的启动、测试和卸载前只读核对不重复询问。

- [ ] 升级后设置、队列、分组、历史和 Telegram 配置仍在。
- [ ] 至少 20 个真实任务、两个组：重排独立项和组、切换高优先级、重启后顺序/优先级完全相同。
- [ ] 暂停一个等待项和一个下载项；只恢复下载项，重启后等待项仍暂停、恢复项只运行一个 worker。
- [ ] 活跃下载时强制结束 Sidecar；Electron 重连后同一 ID 恢复，不生成重复输出。
- [ ] 活跃任务中正常退出/重开一次，并真实重启操作系统一次；run intent 恢复，用户暂停项不启动。
- [ ] mixed-state 组分别执行暂停、继续、取消和重试；toast 数量与实际 applied/deferred/skipped 一致。
- [ ] 联合测试任务并发、HLS 分片并发和限速；进度单调、UI 可操作、CPU/内存/SQLite/日志无持续无界增长。
- [ ] 下载成功后强制 Telegram 发送失败；下载仍 completed，成品能打开且 hash 不变。
- [ ] 在隔离数据目录加载 1,000 个合成任务，检查滚动、批次进度、任务栏进度和重启恢复。
- [ ] 固定恢复场景在 Windows 可见重复 5 轮；每轮记录 OS build、源码 SHA、数据目录、任务 ID、成品 hash 和异常。

Windows 本地候选按自动化与包级结果判定，明确未做人工验收，不宣称实机可见验证通过。Mac 不在本任务范围，不阻塞继续。

---

## 任务 12：形成候选边界，不擅自发布

**Interfaces:** consumes all task 1–11 diffs and evidence; produces a clean local candidate and optional authorized local commit only, while leaving merge, push, tag, CI dispatch, upload, and public release outside implicit authority.

- [ ] **Step 1: 最终审查**

- [ ] `git status` 仅包含 v0.2.5 源码、测试、版本、发布说明和验收证据。
- [ ] `desktop/release/`、真实下载、测试数据库、临时数据目录、日志、诊断包、凭据均未暂存。
- [ ] 验收记录没有把“未执行/受阻”写成“通过”，并明确 Windows、包模式与签名状态；Mac 标为本任务不负责。
- [ ] 重跑任务 11 源码门槛和 `git diff --check`。

- [ ] **Step 2: 按已获授权选择一种本地提交方式**

若此前已授权并执行分任务提交，只为最后的发布说明/验收更新创建收尾提交：

```powershell
git add docs/RELEASE-NOTES-0.2.5.md docs/acceptance/v0.2.5-queue-recovery-stability.md docs/roadmap.md
git commit -m "docs(release): record v0.2.5 acceptance"
```

若只授权一个最终本地候选提交：

```powershell
git add -- src/core/download_task.py src/core/task_actions.py src/core/download_manager.py src/core/progress_buffer.py src/data/queue_store.py src/data/json_config.py src/sidecar/protocol.py src/sidecar/handlers.py src/sidecar/server.py tests/core/test_task_actions.py tests/core/test_task_snapshot.py tests/core/test_queue_restore.py tests/core/test_download_manager.py tests/core/test_progress_buffer.py tests/core/test_queue_recovery_scenarios.py tests/core/test_queue_scale.py tests/core/test_resource_matrix.py tests/core/test_output_contract.py tests/data/test_queue_store.py tests/data/test_json_config.py tests/data/test_telegram_delivery_store.py tests/sidecar/test_protocol.py tests/sidecar/test_handlers.py tests/sidecar/test_server.py tests/sidecar/test_telegram_delivery_service.py desktop/package.json desktop/package-lock.json desktop/electron/protocol.ts desktop/electron/protocol.test.ts desktop/electron/taskProgressRelay.ts desktop/electron/taskProgressRelay.test.ts desktop/electron/main.ts desktop/electron/taskTracker.ts desktop/electron/taskTracker.test.ts desktop/electron/sidecar.test.ts desktop/electron/telegram/controller.delivery.e2e.test.ts desktop/renderer/lib/queueOrdering.ts desktop/renderer/lib/queueOrdering.test.ts desktop/renderer/lib/types.ts desktop/renderer/components/QueueOrderControls.tsx desktop/renderer/components/QueueOrderControls.test.tsx desktop/renderer/components/TaskList.tsx desktop/renderer/components/TaskList.test.tsx desktop/renderer/components/PlaylistGroupCard.tsx desktop/renderer/components/PlaylistGroupCard.test.tsx desktop/renderer/components/task/MediaTaskBanner.tsx desktop/renderer/components/task/TaskActionsMenu.tsx desktop/renderer/components/task/TaskActionsMenu.test.tsx desktop/renderer/components/task/useTaskCommands.ts desktop/renderer/components/shell/ActionBar.tsx desktop/renderer/components/shell/ActionBar.test.tsx desktop/renderer/store/appStore.ts desktop/renderer/store/appStore.test.ts docs/roadmap.md docs/RELEASE-NOTES-0.2.5.md docs/acceptance/v0.2.5-queue-recovery-stability.md
git diff --cached --check
git diff --cached --stat
git commit -m "fix(queue): make recovery durable in v0.2.5"
```

若没有提交授权，不执行以上命令，保留已验证 diff 并报告边界。

- [ ] **Step 3: 停止在本地候选**

记录 `git rev-parse HEAD` 与 `git status --short --branch`。即使本地提交完成，也不得自动 merge、push、tag、触发 CI、上传 DMG/NSIS/ZIP 或发布 Release。

## 3. 完成定义

v0.2.5 只有在以下全部成立时才算完成：

- 用户暂停跨重启保持暂停；运行意图跨异常恢复后只恢复一次。
- 等待任务能在启动前暂停；failed/cancelled 不会自动重试。
- 单项、整组和全部操作按真实结果反馈，多任务写入失败时内存与 SQLite 一起回滚。
- 可见顺序、分组和优先级与 scheduler 顺序一致，重启后不漂移。
- 高频进度以有界批次写 SQLite 和 Renderer，终态不会被旧进度覆盖，节流字典可回收。
- 20 轮自动恢复、24 组资源矩阵、1,000 行规模门槛无重复 worker、ID、输出、删除或无限重试。
- Telegram 失败不能降级、重排或重试已完成下载。
- Windows x64 包内 smoke、隔离升级与重复恢复自动化均有证据；人工安装、窗口操作与系统重启按用户要求不执行。
- 验收记录包含源码 SHA、版本、命令、通过数、包模式、产物大小/SHA-256、签名状态、OS 证据和剩余限制。
- 所有远程发布动作仍等待独立明确授权。
