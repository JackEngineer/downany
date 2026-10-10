# Downany v0.3.0 旧资料升级与迁移合同 Implementation Plan

> **For Codex:** Use `superpowers:executing-plans` to implement this plan task-by-task. Use `superpowers:test-driven-development` for every behavior change and `superpowers:verification-before-completion` before reporting the branch complete.

**Goal:** 证明并补齐 `v0.2.1 → v0.3.0` 与最近一个已验收 `v0.2.x → v0.3.0` 的升级合同，使设置、队列、下载历史、Telegram 路由/发送状态和同一系统用户下的加密凭据在 Windows 上可解释地保留。

**Architecture:** 不新增全局“版本迁移中心”。历史资料由只含虚构数据的 SQL/JSON 夹具重建，按真实启动顺序经过 `JsonConfig → HistoryDB → QueueStore → TelegramDeliveryStore → DownloadManager.restore_tasks()`。现有存储组件继续负责幂等默认值和列迁移；测试若发现破坏性差异，只修改拥有该数据的组件。打包 Sidecar 使用同一 JSONL 协议验证器，Electron 凭据使用 fake `CredentialBackend` 验证路径和字节保持。

**Tech Stack:** Python 3.11、pytest、SQLite、JSON Lines、TypeScript、Vitest、Electron `safeStorage` 抽象、GitHub Actions、NSIS。

**Spec:** `docs/superpowers/specs/2026-08-26-downany-v0-3-staged-upgrade-design.md` 第 4.5、5.2、5.3、6 节。

## Global Constraints

- **用户范围调整（2026-08-27）：** 先读 `docs/superpowers/specs/2026-08-27-downany-windows-execution-scope.md`。本任务只负责 Windows 与扩展；不执行或等待 Mac 构建/验收，保留现有 Mac 实现和历史资产。

- 从已经集成且全绿的 `v0.2.5` 基线创建 `fix/v0-3-profile-upgrade`；不得直接以当前独立 `v0.2.4` 工作树或未集成计划分支为基线。
- `v0.2.1` 夹具必须来自 annotated tag `v0.2.1` 指向的提交 `0dbaeb7fb0394887be51f6dea773aaa79ae38546` 的真实字段，不得用当前模型反向生成后冒充历史格式。
- 最近 `v0.2.x` 夹具来自执行时已验收的 `v0.2.5` 集成提交，并在 `profile.json` 中记录完整 40 位 SHA。
- 夹具只使用 `example.test` URL、虚构标题、虚构聊天 ID、固定小字节文件和测试凭据字节；不得复制真实用户资料、Token、Cookie、代理认证或本机绝对路径。
- 支持的凭据升级路径是 `telegram/bot-token.v1`。`v0.2.1` 已使用该路径；旧于公开基线的 `bot-token.bin` 不在本计划承诺中，也不能在没有真实需求证据时自动搬运。
- 恢复语义以 `v0.2.5` 已确认状态机为准：用户希望继续的中断任务恢复为 pending，用户明确暂停的任务保持 paused，failed/cancelled 不自动重试，completed 和成品字节不变。
- 任何迁移都必须可重入；第二次启动不能新增重复任务、重复历史、重复 Telegram delivery，不能改写已完成文件。
- 自动化隔离使用 `DOWNANY_DATA_DIR`。真实默认资料目录只在干净测试用户/VM 中验收，不拿当前用户真实数据做实验。
- 本计划不授权安装器启动、卸载、merge、push、tag、CI dispatch 或 Release 操作。

## 任务 1：冻结两代历史资料夹具与可审计来源

**文件**

- 新建：`scripts/__init__.py`
- 新建：`scripts/profile_upgrade_contract.py`
- 新建：`tests/upgrade/__init__.py`
- 新建：`tests/upgrade/test_profile_upgrade_contract.py`
- 新建：`tests/fixtures/profiles/v0.2.1/profile.json`
- 新建：`tests/fixtures/profiles/v0.2.1/history.sql`
- 新建：`tests/fixtures/profiles/v0.2.1/expected.json`
- 新建：`tests/fixtures/profiles/v0.2.5/profile.json`
- 新建：`tests/fixtures/profiles/v0.2.5/history.sql`
- 新建：`tests/fixtures/profiles/v0.2.5/expected.json`

**Interfaces:** consumes immutable historical schema facts and fixture directories; produces `ProfileFixture`, `load_profile_fixture(path)`, `materialize_profile(fixture, data_dir)`, `logical_profile_snapshot(data_dir)`, and `assert_profile_matches(snapshot, expected)` for source and packaged verification.

- [ ] **Step 1: 写夹具格式和来源校验的失败测试**

`tests/upgrade/test_profile_upgrade_contract.py` 至少覆盖：

```python
def test_v021_fixture_has_exact_release_provenance():
    fixture = load_profile_fixture(PROFILES / "v0.2.1")
    assert fixture.source_version == "0.2.1"
    assert fixture.source_commit == "0dbaeb7fb0394887be51f6dea773aaa79ae38546"
    assert fixture.credential_relative_path == "telegram/bot-token.v1"


def test_materialized_fixture_contains_no_real_secret_or_machine_path(tmp_path):
    fixture = load_profile_fixture(PROFILES / "v0.2.1")
    data_dir = materialize_profile(fixture, tmp_path / "profile")
    serialized = (data_dir / "config.json").read_text(encoding="utf-8")
    assert "example.test" in serialized
    assert "Cookie" not in serialized
    assert "token=" not in serialized.lower()
    assert "C:\\Users\\" not in serialized
    assert "/Users/" not in serialized
```

校验器拒绝：未知 `schemaVersion`、非 40 位小写 SHA、绝对相对路径、`..`、符号链接、SQL 中 `ATTACH`/`PRAGMA writable_schema`、以及超出夹具目录的输出。

- [ ] **Step 2: 运行并确认 RED**

```powershell
python -m pytest tests/upgrade/test_profile_upgrade_contract.py -q
```

预期：模块和夹具不存在，测试失败。

- [ ] **Step 3: 实现最小夹具模型和安全物化**

`ProfileFixture` 使用 frozen dataclass，`materialize_profile` 只执行已校验的 `history.sql`，原子写 `config.json`，并生成固定测试文件：

```python
TEST_CREDENTIAL_BYTES = b"DOWNANY_TEST_ENCRYPTED_TOKEN_V1"
TEST_COMPLETED_BYTES = b"DOWNANY_TEST_COMPLETED_MEDIA_V1"


@dataclass(frozen=True)
class ProfileFixture:
    root: Path
    source_version: str
    source_commit: str
    credential_relative_path: str
    expected: dict[str, object]


def materialize_profile(fixture: ProfileFixture, data_dir: Path) -> Path:
    data_dir.mkdir(parents=True, exist_ok=False)
    config_source = fixture.root / "config.json"
    config_target = data_dir / "config.json"
    config_target.write_bytes(config_source.read_bytes())
    with sqlite3.connect(data_dir / "history.db") as connection:
        connection.executescript((fixture.root / "history.sql").read_text(encoding="utf-8"))
    credential = data_dir / fixture.credential_relative_path
    credential.parent.mkdir(parents=True, exist_ok=True)
    credential.write_bytes(TEST_CREDENTIAL_BYTES)
    output = data_dir / "fixture-output" / "completed.mp4"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(TEST_COMPLETED_BYTES)
    return data_dir
```

`history.sql` 必须直接写出该版本的历史列、`task_queue` 列和 Telegram 表列，并插入固定 ID：`history-completed`、`queue-running`、`queue-paused`、`queue-failed`、`queue-completed`、`delivery-pending`。运行时路径由物化器把 `${FIXTURE_DATA_DIR}` 和 `${FIXTURE_OUTPUT_FILE}` 安全替换为临时绝对路径，SQL 文件本身不含本机路径。

`expected.json` 明确列出：需保留的设置键和值、恢复后的任务 ID/状态/组/顺序/运行意图、历史 ID/状态、Telegram 路由字段、delivery ID/状态、成品 SHA256 和凭据 SHA256。

- [ ] **Step 4: 从历史提交核对字段而非复制当前模型**

```powershell
git show v0.2.1:src/data/queue_store.py
git show v0.2.1:src/data/database.py
git show v0.2.1:src/data/json_config.py
git show v0.2.1:src/data/telegram_delivery_store.py
git show v0.2.1:desktop/electron/telegram/controller.ts
git show v0.2.1:desktop/electron/telegram/paths.ts
```

把核对结果写入 `profile.json.source`；最近版本夹具的 `sourceCommit` 使用执行时的 `git rev-parse HEAD`，并断言桌面端与 Sidecar 均为 `0.2.5` 后才生成。

- [ ] **Step 5: 确认 GREEN**

```powershell
python -m pytest tests/upgrade/test_profile_upgrade_contract.py -q
```

- [ ] **Step 6: 本地提交检查点（仅在已授权时）**

```powershell
git add scripts/__init__.py scripts/profile_upgrade_contract.py tests/upgrade tests/fixtures/profiles
git commit -m "test(upgrade): freeze supported profile fixtures"
```

## 任务 2：证明源码启动顺序可幂等升级设置、数据库与队列

**文件**

- 新建：`tests/upgrade/test_profile_upgrade.py`
- 修改：`tests/conftest.py`（仅在需要共享固定 fake downloader/output sink 时）
- 修改：`tests/core/test_queue_restore.py`

**Interfaces:** consumes both materialized fixture generations and the accepted v0.2.5 restore contract; produces a source-level `open_profile_as_current(data_dir)` harness and assertions for settings, queue, history, Telegram state, file hashes, and second-open idempotence.

- [ ] **Step 1: 写两代资料升级的失败测试**

参数化测试对 `v0.2.1` 和 `v0.2.5` 各执行两次打开：

```python
@pytest.mark.parametrize("fixture_name", ["v0.2.1", "v0.2.5"])
def test_supported_profile_upgrades_idempotently(tmp_path, fixture_name):
    fixture = load_profile_fixture(PROFILES / fixture_name)
    data_dir = materialize_profile(fixture, tmp_path / fixture_name)
    before_credential = sha256_file(data_dir / "telegram" / "bot-token.v1")
    before_output = sha256_file(data_dir / "fixture-output" / "completed.mp4")

    first = open_profile_as_current(data_dir)
    assert_profile_matches(first, fixture.expected)
    first_disk = logical_profile_snapshot(data_dir)

    second = open_profile_as_current(data_dir)
    assert_profile_matches(second, fixture.expected)
    assert logical_profile_snapshot(data_dir) == first_disk
    assert sha256_file(data_dir / "telegram" / "bot-token.v1") == before_credential
    assert sha256_file(data_dir / "fixture-output" / "completed.mp4") == before_output
```

断言还必须覆盖：

- v0.2.1 已有设置值保留，新设置获得当前默认值，未知非敏感键不被静默删除。
- `queue-running` 按 v0.2.5 合同恢复为 pending/run；`queue-paused` 保持 paused/pause；failed 不自动重试；completed 保持 100% 和原文件。
- 任务 ID、`group_id`、`playlist_index`、优先级、队列顺序、输出选项保持；新增列得到稳定默认值。
- download history 行数和 ID 不变，新增输出字段不会把已完成记录降级。
- Telegram 配置和 delivery 行保持，恢复 lease 只执行既有、可解释的过期处理，不产生第二条 delivery。
- `config.json`、`history.db` 和成品文件第二次打开后的逻辑快照完全一致。

- [ ] **Step 2: 运行并确认真实结果**

```powershell
python -m pytest tests/upgrade/test_profile_upgrade.py tests/core/test_queue_restore.py -q
```

如果首轮全部 GREEN，记录“现有存储级迁移满足合同”，不要为了制造变更新增 `profile_upgrade.py`。若 RED，保留完整失败断言进入任务 3。

- [ ] **Step 3: 加入中断与并发打开特征测试**

用 monkeypatch 在一个待新增列执行后抛出异常，重新打开时应完成其余列；另用两个线程同时构造 `QueueStore`/`TelegramDeliveryStore`，断言没有 `duplicate column`、`database is locked` 遗留或部分表。测试结束运行 `PRAGMA integrity_check`，结果必须精确为 `ok`。

- [ ] **Step 4: 确认源码升级门槛**

```powershell
python -m pytest tests/upgrade tests/data/test_database.py tests/data/test_json_config.py tests/data/test_queue_store.py tests/data/test_telegram_delivery_store.py tests/core/test_queue_restore.py -q
```

## 任务 3：只修复夹具证明的存储兼容缺口

**文件（按失败归属选择，禁止全改）**

- 可能修改：`src/data/json_config.py`
- 可能修改：`src/data/database.py`
- 可能修改：`src/data/queue_store.py`
- 可能修改：`src/data/telegram_delivery_store.py`
- 可能修改：`src/core/download_manager.py`
- 对应修改：`tests/data/test_json_config.py`
- 对应修改：`tests/data/test_database.py`
- 对应修改：`tests/data/test_queue_store.py`
- 对应修改：`tests/data/test_telegram_delivery_store.py`
- 对应修改：`tests/core/test_queue_restore.py`

**Interfaces:** consumes only concrete RED assertions from task 2; produces minimal idempotent defaults/column migrations or restore normalization in the component that owns the failing data, without creating a second database, duplicate profile, or global migration subsystem.

- [ ] **Step 1: 为每个 RED 定位最小拥有者**

分类规则：

- JSON 缺省/保留失败归 `JsonConfig`。
- 历史列和输出状态归 `HistoryDB`。
- 队列列、排序、运行意图归 `QueueStore` 与恢复纯函数。
- Telegram delivery/target block 归 `TelegramDeliveryStore`。
- 只有“持久行正确但恢复状态错误”才归 `DownloadManager.restore_tasks()`。

不得用捕获所有异常后清空资料、重建数据库、删除坏行或复制到新目录来让测试通过。

- [ ] **Step 2: 实现幂等最小修复**

列迁移使用 `PRAGMA table_info` 后在 `BEGIN IMMEDIATE` 内执行；重复运行不抛错。JSON 只合并缺失默认值并原子替换；现有非敏感未知键继续保留。队列行解析为旧缺失字段提供明确默认值，非法状态必须记录并隔离，不能静默变成 completed。

- [ ] **Step 3: 运行最窄 GREEN 与全存储回归**

```powershell
python -m pytest tests/upgrade tests/data tests/core/test_queue_restore.py -q
```

- [ ] **Step 4: 本地提交检查点（仅在确有修复且已授权时）**

只暂存与 RED 对应的拥有者文件和测试：

```powershell
git diff --check
git status --short
git commit -m "fix(upgrade): preserve supported profiles"
```

若任务 2 原本全绿，本任务明确记为“不需要产品代码变更”，不创建空提交。

## 任务 4：锁定 Telegram 凭据路径与同用户解密合同

**文件**

- 修改：`desktop/electron/telegram/credentialVault.test.ts`
- 修改：`desktop/electron/telegram/paths.test.ts`
- 新建：`desktop/electron/telegram/profileUpgrade.test.ts`

**Interfaces:** consumes `resolveTelegramBotApiPaths(...)`, `TelegramCredentialVault`, and a fake `CredentialBackend`; produces cross-platform path invariants and proof that the supported `bot-token.v1` bytes remain readable and unchanged across an in-place application upgrade.

- [ ] **Step 1: 写支持基线的失败测试**

```ts
it.each(["darwin", "win32"] as const)("keeps the v0.2.1 token path on %s", (platform) => {
  const dataDir = platform === "win32" ? "D:\\Profile\\Downany" : "/Users/test/Library/Application Support/Downany";
  const paths = resolveTelegramBotApiPaths({
    platform,
    isPackaged: true,
    resourcesPath: platform === "win32" ? "D:\\App\\resources" : "/Applications/Downany.app/Contents/Resources",
    downanyDataDir: dataDir,
    env: {},
  });
  expect(paths.credentialFile).toBe(
    platform === "win32"
      ? "D:\\Profile\\Downany\\telegram\\bot-token.v1"
      : "/Users/test/Library/Application Support/Downany/telegram/bot-token.v1",
  );
});
```

临时目录测试先写 `encrypted:42:test-token`，用 fake backend 创建指向完整 `bot-token.v1` 路径的 vault，调用 `hasToken()`、`read()` 两次，断言返回虚构 token 且文件 SHA256、mtime、同目录文件集合不变。再构造 controller，证明默认 vault 指向同一文件而非 `bot-token.bin`。

- [ ] **Step 2: 运行测试并只修复真实 RED**

```powershell
Push-Location desktop
npm.cmd test -- electron/telegram/credentialVault.test.ts electron/telegram/paths.test.ts electron/telegram/profileUpgrade.test.ts
Pop-Location
```

当前 v0.2.1 与 v0.2.4 路径审计预期这些合同无需产品代码改动；若测试 RED，只修正路径组装或构造调用，不复制/解密/重加密真实凭据。

- [ ] **Step 3: 明确跨机器边界**

在测试名和验收文档中写清：`safeStorage` 凭据只承诺同一 OS 用户原地升级，复制到另一台机器或另一用户不保证可解密；这不是资料丢失，也不能通过提交明文 Token 规避。

## 任务 5：用同一验证器覆盖源码和打包 Sidecar

**文件**

- 新建：`scripts/verify_profile_upgrade.py`
- 新建：`tests/sidecar/test_profile_upgrade_verifier.py`
- 修改：`.github/workflows/ci.yml`
- 修改：`docs/RELEASE.md`

**Interfaces:** consumes a fixture directory and either current Python module mode or an absolute packaged Sidecar executable; produces JSONL handshake/request assertions for `app.getSnapshot`, `history.list`, `telegram.getConfig`, `telegram.listDeliveries`, clean shutdown, disk integrity, and a machine-readable success summary.

- [ ] **Step 1: 写验证器协议客户端的失败测试**

测试 fake child process：启动后必须先收到 Sidecar hello，再发送 peer hello；每个 request 使用唯一 `id`，响应按 `correlationId` 匹配；stderr 不按 JSONL 解析；超时或进程提前退出返回非零；finally 必须终止子进程。

命令行合同：

```text
python scripts/verify_profile_upgrade.py --fixture tests/fixtures/profiles/v0.2.1
python scripts/verify_profile_upgrade.py --fixture tests/fixtures/profiles/v0.2.1 --sidecar-executable D:\candidate\DownanySidecar.exe
```

不传 `--sidecar-executable` 时执行当前解释器的 `-m src.sidecar`；传入时要求绝对、存在、普通文件。

- [ ] **Step 2: 实现请求与断言**

验证器向隔离临时资料发送：

```python
REQUESTS = (
    ("snapshot", "app.getSnapshot", {}),
    ("history", "history.list", {"offset": 0, "limit": 200}),
    ("telegram-config", "telegram.getConfig", {}),
    ("telegram-deliveries", "telegram.listDeliveries", {"offset": 0, "limit": 200}),
)
```

关闭前发送 `app.shutdown`。成功后重新启动同一资料再跑一次，并调用 `logical_profile_snapshot` 比较两轮；输出只包含 fixture 名、应用版本、任务/历史/delivery 数量、逻辑快照 SHA256 和 `ok: true`，不输出 URL、标题、聊天 ID、路径或数据库内容。

- [ ] **Step 3: 运行源码验证**

```powershell
python -m pytest tests/sidecar/test_profile_upgrade_verifier.py -q
python scripts/verify_profile_upgrade.py --fixture tests/fixtures/profiles/v0.2.1
python scripts/verify_profile_upgrade.py --fixture tests/fixtures/profiles/v0.2.5
```

- [ ] **Step 4: 把升级合同加入 Windows CI 和包内门槛**

`python-tests` 的 pytest 路径加入 `tests/upgrade`。Windows 的 `native-resources` 在找到 packaged Sidecar 后，对两个夹具各执行一次验证器，路径使用 `$sidecar.FullName`。不修改或等待现有 Mac job。

```yaml
- name: Verify packaged profile upgrade
  run: >-
    python scripts/verify_profile_upgrade.py
    --fixture tests/fixtures/profiles/v0.2.1
    --sidecar-executable "${{ env.DOWNANY_PACKAGED_SIDECAR }}"
```

Windows 步骤先设置 `DOWNANY_PACKAGED_SIDECAR`；不得把该路径写入已有 Mac job。

- [ ] **Step 5: 验证 workflow 语法和本地门槛**

```powershell
python -m pytest tests/upgrade tests/sidecar/test_profile_upgrade_verifier.py -q
git diff --check
```

## 任务 6：执行 Windows 的真实原地升级验收

**文件**

- 新建：`docs/acceptance/v0.3-upgrade-migration.md`
- 修改：`docs/RELEASE.md`

**Interfaces:** consumes the public v0.2.1 Windows installer, the accepted latest v0.2.x Windows installer, and one v0.3.0 Windows candidate; produces visible install-over-install evidence for settings, queue, history, Telegram configuration, credential availability, and output bytes.

- [ ] **Step 1: 冻结验收矩阵和隔离边界**

在 Windows 执行两条独立旅程：

1. `v0.2.1 → v0.3.0`。
2. `v0.2.5 → v0.3.0`。

每条旅程使用新的干净 OS 用户或可回滚 VM 快照。旧版先设置非默认下载目录/主题/并发，建立 pending、paused、failed、completed、分组任务与一条历史；Telegram 使用专门测试 Bot/测试聊天并在文档中只记录“已绑定/目标类型/自动发送开关”，不记录 Token、ID 或标题。记录 completed 文件升级前 SHA256。

- [ ] **Step 2: Windows 原地覆盖验收（动作时需确认）**

- 下载并核对公开 v0.2.1 NSIS 的来源、大小和 SHA256。
- 安装旧版，生成上述资料，完全退出 Electron/Sidecar。
- 运行 v0.3.0 NSIS 覆盖同一安装目录，不卸载旧版、不清空 `%LOCALAPPDATA%\Downany`。
- 启动后逐项可见核对设置、队列状态/顺序/分组、历史、完成文件打开、Telegram 绑定状态和诊断导出。
- 退出再启动一次，证明第二次启动无重复/降级；重新计算完成文件 SHA256。

安装器启动、SmartScreen 交互和卸载都属于动作时确认；未确认时此步骤保持 pending，不反复追问。

- **Step 3: macOS 原地覆盖验收（本任务不执行）**

用户已明确排除 Mac 工作。本任务不安装或覆盖 Mac 应用、不要求 Mac 主机；保留现有实现与历史记录，不声称 Mac 升级通过。

- [ ] **Step 4: 如实记录结果**

`docs/acceptance/v0.3-upgrade-migration.md` 每条旅程记录：旧/新版本、旧/新安装包 SHA256、OS/架构、资料对象计数、恢复状态、输出 SHA256、Telegram 合同、二次启动、失败和未测边界。不得附截图中的真实聊天信息或绝对用户路径。

## 任务 7：完整回归、审查边界和候选交接

**文件**

- 修改：`docs/acceptance/v0.3-upgrade-migration.md`
- 修改：`docs/superpowers/plans/2026-08-27-downany-v0-3-convergence-index.md`（只更新执行状态，不改门槛）

**Interfaces:** consumes all automated, packaged, and visible evidence from tasks 1–6; produces a reviewable local upgrade-compatibility candidate and an exact handoff into the product-consistency plan, without performing integration or remote actions.

- [ ] **Step 1: 运行全量源码回归**

```powershell
python -m pytest tests/core tests/data tests/sidecar tests/cli tests/upgrade -q

Push-Location desktop
$downanyHadNodeOptions = Test-Path Env:NODE_OPTIONS
$downanyPriorNodeOptions = $env:NODE_OPTIONS
try {
  $env:NODE_OPTIONS = "--no-experimental-webstorage"
  npm.cmd test
  npm.cmd run build
} finally {
  if ($downanyHadNodeOptions) { $env:NODE_OPTIONS = $downanyPriorNodeOptions } else { Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue }
  Pop-Location
}

node browser-extension/shared.test.js
node browser-extension/sniff-core.test.js
node browser-extension/bridge-timeout.test.js
git diff --check
```

- [ ] **Step 2: 审查敏感信息与范围**

```powershell
rg -n -i "bot[_-]?token|cookie:|authorization:|proxy.*@|C:\\Users\\|/Users/" tests/fixtures/profiles docs/acceptance/v0.3-upgrade-migration.md
git status --short
git diff --stat
```

只允许固定测试标识和明确的隐私边界文字；发现疑似真实值立即从夹具和 Git 历史候选中移除并重建测试数据。

- [ ] **Step 3: 使用 completion verification**

重新运行本计划列出的关键命令，核对 `docs/acceptance/v0.3-upgrade-migration.md` 的每个“通过”都有当前输出。若 Windows 可见升级未执行，状态只能是“源码/包内升级合同候选”，不能写成升级完成。

- [ ] **Step 4: 本地提交或交接（仅按已有授权）**

若已明确授权本地提交，按逻辑拆分夹具合同、真实兼容修复、CI/文档三类提交；未授权则保留工作树并报告精确 diff。不得自行 merge 或 push。
