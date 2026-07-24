# Electron 迁移阶段 1：协议与进程外壳 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 冻结 JSON Lines 协议 schema，实现无 Qt 的 Python Sidecar 命令循环，并搭起 Electron Main/Preload 外壳，完成握手、快照、心跳与优雅关闭。

**Architecture:** Sidecar 是独立进程：stdin/stdout 跑协议，stderr 打日志；内部装配 `JsonConfig` + `HistoryDB` + `QueueStore` + `DownloadManager`。Electron Main 负责单实例锁、拉起/监护 Sidecar、请求关联与心跳；Preload 只暴露窄 API；Renderer 本阶段仅一页连接状态 + 任务快照只读展示（命令中心 UI 属阶段 2）。

**Tech Stack:** Python 3、pytest、subprocess JSON Lines；Electron + TypeScript + Vite；zod（TS）与手写校验（Python）做运行时校验。

**规格来源:** `docs/superpowers/specs/2026-07-19-electron-migration-design.md` §6–8、§11、§13 阶段 1。

## Global Constraints

- UI 文案中文，标识符英文；不使用内联 import。
- 发布产物与新建路径不得含 Trae 标识；Sidecar 默认数据目录为 `~/Library/Application Support/VideoDownloader/`。
- Renderer：`contextIsolation: true`，`nodeIntegration: false`；不开启本地 HTTP 端口。
- stdout 只允许协议行；诊断日志写 stderr 或日志文件。
- 现有仓库有未提交 UI 抛光改动；本计划每次提交只 `git add` 点名文件，不 stash/不提交无关 WIP。
- 测试：仓库根目录、`source venv/bin/activate` 后跑 pytest；Electron 侧在 `desktop/` 下 `npm test`。
- PyQt 应用继续可运行，不删除、不改其默认数据路径（仍用旧 QSettings）；Sidecar 走新路径。

---

## 文件结构总览

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/sidecar/protocol.py` | 新建 | 协议版本、消息类型、错误码、方法名常量 |
| `src/sidecar/codec.py` | 新建 | 编解码一行 JSON、结构校验 |
| `src/sidecar/paths.py` | 新建 | VideoDownloader 数据/日志路径 |
| `src/data/json_config.py` | 新建 | Qt 无关的 JSON 配置读写 |
| `src/sidecar/handlers.py` | 新建 | 各 method 的业务处理 |
| `src/sidecar/server.py` | 新建 | stdin 读循环、事件发射、心跳响应 |
| `src/sidecar/__main__.py` | 新建 | `python -m src.sidecar` 入口 |
| `src/data/database.py` | 修改 | 增加 `clear_download_history`、分页 list 友好接口 |
| `desktop/package.json` | 新建 | Electron + Vite + TS 工程 |
| `desktop/electron/protocol.ts` | 新建 | 与 Python 对齐的类型与 zod schema |
| `desktop/electron/sidecar.ts` | 新建 | 子进程生命周期、请求队列、心跳 |
| `desktop/electron/main.ts` | 新建 | 窗口、单实例、IPC 转发 |
| `desktop/electron/preload.ts` | 新建 | 白名单 `window.api` |
| `desktop/renderer/*` | 新建 | 最小状态页（连接/快照/退出） |
| `tests/sidecar/*` | 新建 | 协议与 Sidecar 集成测试 |
| `desktop/electron/*.test.ts` | 新建 | Main 侧协议客户端单测（可用假进程） |

---

### Task 0: 建立工作分支

- [ ] **Step 1: 创建分支**

```bash
git checkout main
git checkout -b electron-phase-1
```

未提交 WIP 保持原样；本计划提交只添加点名文件。

---

### Task 1: 协议常量与错误码

**Files:**
- Create: `src/sidecar/protocol.py`
- Create: `src/sidecar/__init__.py`
- Test: `tests/sidecar/test_protocol.py`

**Interfaces:**
- Produces: `PROTOCOL_VERSION = 1`；`ErrorCode` 枚举；`Method` 字符串常量；`EventName` 常量

- [ ] **Step 1: 写失败测试**

```python
"""协议常量冻结测试。"""
from src.sidecar.protocol import PROTOCOL_VERSION, ErrorCode, Method, EventName


def test_protocol_version_is_one():
    assert PROTOCOL_VERSION == 1


def test_required_methods_exist():
    required = {
        "app.getSnapshot",
        "app.ping",
        "app.shutdown",
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
        "download.clearFinished",
        "history.list",
        "history.delete",
        "history.clear",
        "settings.get",
        "settings.update",
        "updater.checkYtDlp",
        "updater.updateYtDlp",
    }
    assert {m.value for m in Method} == required


def test_error_codes_are_stable_strings():
    assert ErrorCode.INVALID_MESSAGE.value == "INVALID_MESSAGE"
    assert ErrorCode.PROTOCOL_MISMATCH.value == "PROTOCOL_MISMATCH"
    assert ErrorCode.METHOD_NOT_FOUND.value == "METHOD_NOT_FOUND"
    assert ErrorCode.NOT_IMPLEMENTED.value == "NOT_IMPLEMENTED"
    assert ErrorCode.INTERNAL.value == "INTERNAL"
```

- [ ] **Step 2: 运行确认失败**

Run: `pytest tests/sidecar/test_protocol.py -v`  
Expected: FAIL，`ModuleNotFoundError`

- [ ] **Step 3: 实现**

创建 `src/sidecar/__init__.py`（可空）与 `src/sidecar/protocol.py`：

```python
"""Sidecar ↔ Electron JSON Lines 协议常量（阶段 1 冻结）。"""
from __future__ import annotations

from enum import Enum

PROTOCOL_VERSION = 1
APP_NAME = "VideoDownloader"
APP_VERSION = "0.1.0-phase1"


class MessageType(str, Enum):
    REQUEST = "request"
    RESPONSE = "response"
    EVENT = "event"
    HELLO = "hello"


class Method(str, Enum):
    APP_GET_SNAPSHOT = "app.getSnapshot"
    APP_PING = "app.ping"
    APP_SHUTDOWN = "app.shutdown"
    DOWNLOAD_PARSE_URLS = "download.parseUrls"
    DOWNLOAD_CANCEL_PARSE = "download.cancelParse"
    DOWNLOAD_CREATE_TASKS = "download.createTasks"
    DOWNLOAD_PAUSE = "download.pause"
    DOWNLOAD_PAUSE_ALL = "download.pauseAll"
    DOWNLOAD_RESUME = "download.resume"
    DOWNLOAD_RESUME_ALL = "download.resumeAll"
    DOWNLOAD_CANCEL = "download.cancel"
    DOWNLOAD_RETRY = "download.retry"
    DOWNLOAD_REMOVE = "download.remove"
    DOWNLOAD_CLEAR_FINISHED = "download.clearFinished"
    HISTORY_LIST = "history.list"
    HISTORY_DELETE = "history.delete"
    HISTORY_CLEAR = "history.clear"
    SETTINGS_GET = "settings.get"
    SETTINGS_UPDATE = "settings.update"
    UPDATER_CHECK_YTDLP = "updater.checkYtDlp"
    UPDATER_UPDATE_YTDLP = "updater.updateYtDlp"


class EventName(str, Enum):
    TASK_ADDED = "task.added"
    TASK_UPDATED = "task.updated"
    TASK_PROGRESS = "task.progress"
    TASK_COMPLETED = "task.completed"
    TASK_FAILED = "task.failed"
    TASK_REMOVED = "task.removed"
    PARSE_RESULT = "download.parseResult"
    HISTORY_CHANGED = "history.changed"
    SETTINGS_CHANGED = "settings.changed"
    SIDECAR_HEALTH = "sidecar.health"


class ErrorCode(str, Enum):
    INVALID_MESSAGE = "INVALID_MESSAGE"
    PROTOCOL_MISMATCH = "PROTOCOL_MISMATCH"
    METHOD_NOT_FOUND = "METHOD_NOT_FOUND"
    NOT_IMPLEMENTED = "NOT_IMPLEMENTED"
    INVALID_PARAMS = "INVALID_PARAMS"
    INTERNAL = "INTERNAL"
```

- [ ] **Step 4: 运行确认通过**

Run: `pytest tests/sidecar/test_protocol.py -v`  
Expected: 全部 passed

- [ ] **Step 5: 提交**

```bash
git add src/sidecar/__init__.py src/sidecar/protocol.py tests/sidecar/test_protocol.py
git commit -m "feat(sidecar): freeze protocol version, methods, and error codes"
```

---

### Task 2: 编解码与结构校验

**Files:**
- Create: `src/sidecar/codec.py`
- Test: `tests/sidecar/test_codec.py`

**Interfaces:**
- Produces: `decode_line(line) -> dict`；`encode_message(msg) -> str`（含换行）；非法行抛 `ProtocolError`

- [ ] **Step 1: 写失败测试**

```python
"""codec 编解码测试。"""
import json
import pytest

from src.sidecar.codec import ProtocolError, decode_line, encode_message
from src.sidecar.protocol import PROTOCOL_VERSION, MessageType


def test_roundtrip_request():
    msg = {
        "protocolVersion": PROTOCOL_VERSION,
        "type": MessageType.REQUEST.value,
        "id": "r1",
        "method": "app.ping",
        "payload": {},
        "timestamp": "2026-07-21T12:00:00+00:00",
    }
    line = encode_message(msg)
    assert line.endswith("\n")
    assert decode_line(line) == msg


def test_reject_non_json():
    with pytest.raises(ProtocolError):
        decode_line("not-json\n")


def test_reject_missing_type():
    with pytest.raises(ProtocolError):
        decode_line(json.dumps({"protocolVersion": 1, "timestamp": "t"}) + "\n")


def test_stdout_line_is_single_object():
    line = encode_message(
        {
            "protocolVersion": 1,
            "type": "event",
            "event": "task.progress",
            "payload": {"task_id": "a"},
            "timestamp": "t",
        }
    )
    assert line.count("\n") == 1
```

- [ ] **Step 2: 运行确认失败**

Run: `pytest tests/sidecar/test_codec.py -v`  
Expected: FAIL，`ModuleNotFoundError`

- [ ] **Step 3: 实现**

```python
"""JSON Lines 编解码与最小结构校验。"""
from __future__ import annotations

import json
from typing import Any, Dict

from src.sidecar.protocol import MessageType


class ProtocolError(ValueError):
    """协议层错误（无效行或结构）。"""


_REQUIRED = {
    MessageType.REQUEST.value: {"protocolVersion", "type", "id", "method", "payload", "timestamp"},
    MessageType.RESPONSE.value: {"protocolVersion", "type", "correlationId", "timestamp"},
    MessageType.EVENT.value: {"protocolVersion", "type", "event", "payload", "timestamp"},
    MessageType.HELLO.value: {"protocolVersion", "type", "payload", "timestamp"},
}


def decode_line(line: str) -> Dict[str, Any]:
    text = line.strip()
    if not text:
        raise ProtocolError("空行")
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ProtocolError(f"非 JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise ProtocolError("消息必须是对象")
    msg_type = data.get("type")
    required = _REQUIRED.get(msg_type)
    if required is None:
        raise ProtocolError(f"未知 type: {msg_type}")
    missing = required - set(data)
    if missing:
        raise ProtocolError(f"缺少字段: {sorted(missing)}")
    if msg_type == MessageType.RESPONSE.value and "payload" not in data and "error" not in data:
        raise ProtocolError("response 需要 payload 或 error")
    return data


def encode_message(msg: Dict[str, Any]) -> str:
    return json.dumps(msg, ensure_ascii=False, separators=(",", ":")) + "\n"
```

- [ ] **Step 4: 运行确认通过并提交**

```bash
pytest tests/sidecar/test_codec.py -v
git add src/sidecar/codec.py tests/sidecar/test_codec.py
git commit -m "feat(sidecar): add JSON Lines codec with structural validation"
```

---

### Task 3: 应用路径与 JsonConfig

**Files:**
- Create: `src/sidecar/paths.py`
- Create: `src/data/json_config.py`
- Test: `tests/sidecar/test_paths.py`
- Test: `tests/data/test_json_config.py`

**Interfaces:**
- Produces: `AppPaths`（`data_dir` / `config_path` / `history_db_path` / `log_dir`）；`JsonConfig` 读写与 `DownloadConfig` 协议兼容（至少 `get_concurrent_downloads`）

- [ ] **Step 1: 写失败测试**（两文件）

`tests/sidecar/test_paths.py`：

```python
from src.sidecar.paths import AppPaths


def test_default_paths_use_videodownloader(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    paths = AppPaths.default()
    assert paths.data_dir.name == "VideoDownloader"
    assert paths.config_path.name == "config.json"
    assert paths.history_db_path.name == "history.db"
    assert "VideoDownloader" in str(paths.log_dir)
```

`tests/data/test_json_config.py`：

```python
from src.data.json_config import JsonConfig


def test_defaults_and_roundtrip(tmp_path):
    path = tmp_path / "config.json"
    cfg = JsonConfig(str(path))
    assert cfg.get_concurrent_downloads() == 3
    assert cfg.get_download_dir().endswith("Downloads")
    cfg.set_concurrent_downloads(5)
    cfg.set_theme_mode("dark")
    again = JsonConfig(str(path))
    assert again.get_concurrent_downloads() == 5
    assert again.get_theme_mode() == "dark"


def test_proxy_for_download_none_when_disabled(tmp_path):
    cfg = JsonConfig(str(tmp_path / "c.json"))
    cfg.set_proxy_enabled(False)
    cfg.set_proxy_url("http://127.0.0.1:7890")
    assert cfg.get_proxy_for_download() is None
```

- [ ] **Step 2: 运行确认失败 → 实现**

`paths.py`：在 macOS 使用 `~/Library/Application Support/VideoDownloader` 与 `~/Library/Logs/VideoDownloader`；允许构造注入 `data_dir` 便于测试。

`json_config.py`：纯 `json` 文件；字段与现有 `ConfigManager` 对齐（`download_dir`、`concurrent_downloads`、`speed_limit`、`proxy_enabled`、`proxy_url`、`default_quality`、`download_subtitles`、`theme_mode`）；默认下载目录 `~/Downloads`（规格 §9.1）；原子写（写临时文件再 replace）。

提供 `to_dict()` / `update_from_dict(partial)` 供 `settings.get` / `settings.update`。`update_from_dict` 校验：代理启用时地址非空；并发 1–10；主题 ∈ {system,light,dark}。

- [ ] **Step 3: 提交**

```bash
git add src/sidecar/paths.py src/data/json_config.py tests/sidecar/test_paths.py tests/data/test_json_config.py
git commit -m "feat(sidecar): add VideoDownloader paths and Qt-free JsonConfig"
```

---

### Task 4: HistoryDB 分页与清空

**Files:**
- Modify: `src/data/database.py`
- Test: `tests/data/test_database.py`（追加）

**Interfaces:**
- Produces: `list_download_records(offset, limit, status=None, query=None)`；`clear_download_history()`；`delete_download_records(ids: list[str])`

- [ ] **Step 1: 写失败测试并实现最小改动**

在 `tests/data/test_database.py` 追加覆盖：清空、按 offset/limit 列表、多删。保持现有 `get_all_download_records` 行为以免破坏 PyQt。

- [ ] **Step 2: 提交**

```bash
git add src/data/database.py tests/data/test_database.py
git commit -m "feat(data): add history list pagination and clear helpers for sidecar"
```

---

### Task 5: Sidecar handlers（核心方法）

**Files:**
- Create: `src/sidecar/handlers.py`
- Test: `tests/sidecar/test_handlers.py`

**Interfaces:**
- Consumes: `DownloadManager`、`JsonConfig`、`HistoryDB`、`QueueStore`、`ParseSession`
- Produces: `HandlerContext` + `dispatch(method, payload) -> dict`；异步/流式方法通过 `emit_event` 回调

本任务实现真实逻辑：

| method | 行为 |
|---|---|
| `app.ping` | `{"ok": true}` |
| `app.getSnapshot` | `{"tasks": [TaskSnapshot._asdict 风格], "settings": cfg.to_dict()}` |
| `app.shutdown` | 调 `manager.stop()`，返回 `{"ok": true}`，由 server 随后退出循环 |
| `settings.get` / `settings.update` | JsonConfig |
| `download.createTasks` | 支持仅 URL 占位标题入队 |
| `download.pause/resume/cancel/retry/remove` | 委托 manager |
| `download.pauseAll/resumeAll/clearFinished` | 遍历任务 |
| `download.parseUrls` | 后台线程逐条 `ParseSession`，发 `download.parseResult` 事件；返回 `{parseId}` |
| `download.cancelParse` | 取消指定 parseId |
| `history.list/delete/clear` | HistoryDB |
| `updater.*` | 返回 `NOT_IMPLEMENTED` 错误对象（阶段 3） |

- [ ] **Step 1: 写失败测试（至少覆盖 ping、snapshot、settings、createTasks、shutdown 标记）**

使用 `tmp_path` 装配真实 `JsonConfig`/`HistoryDB`/`QueueStore`/`DownloadManager`，不要启动真实 yt-dlp 下载（createTasks 后不 `start()`，或 mock Downloader）。

- [ ] **Step 2: 实现 `handlers.py`，测试通过后提交**

```bash
git commit -m "feat(sidecar): implement protocol method handlers on download core"
```

---

### Task 6: Sidecar 服务循环

**Files:**
- Create: `src/sidecar/server.py`
- Create: `src/sidecar/__main__.py`
- Test: `tests/sidecar/test_server.py`

**Interfaces:**
- Produces: `SidecarServer(stdin, stdout, stderr, paths).run()`；启动时先写一条 `hello`；读入对方 `hello` 校验 `protocolVersion`；之后处理 request；manager 事件转 protocol event（进度可节流 ≥200ms，终态立即发）

- [ ] **Step 1: 写集成测试用管道**

```python
"""SidecarServer 握手与 ping 集成测试。"""
import io
import json
import threading

from src.sidecar.paths import AppPaths
from src.sidecar.protocol import PROTOCOL_VERSION, APP_VERSION
from src.sidecar.server import SidecarServer


def _hello(direction="electron"):
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "type": "hello",
        "payload": {"app": direction, "appVersion": "test"},
        "timestamp": "t",
    }


def test_hello_then_ping(tmp_path):
    paths = AppPaths(data_dir=tmp_path / "data", log_dir=tmp_path / "logs")
    stdin_r, stdin_w = io.StringIO(), io.StringIO()
    # 使用队列式假流更清晰：自定义双端 TextIO
    ...
```

实现建议：测试里用 `threading` + `os.pipe` 或内存 `queue` 包装成 file-like；向 Sidecar 写入 electron `hello` + `app.ping` request，断言 stdout 先有 sidecar `hello`，再有 `response`。

协议不匹配：electron hello 的 `protocolVersion=999` → sidecar 回错误 hello/或写完错误后退出，测试断言。

- [ ] **Step 2: 实现 server 与 `__main__.py`**

```python
# __main__.py 概念
def main():
    logging 配到 stderr / log_dir
    paths = AppPaths.default()
    server = SidecarServer.from_paths(paths)
    server.run(sys.stdin, sys.stdout)
```

手动冒烟：

```bash
printf '%s\n' '{"protocolVersion":1,"type":"hello","payload":{"app":"electron","appVersion":"0"},"timestamp":"t"}' \
| python -m src.sidecar
```

Expected: stdout 一行 sidecar hello（勿打印日志到 stdout）。

- [ ] **Step 3: 提交**

```bash
git add src/sidecar/server.py src/sidecar/__main__.py tests/sidecar/test_server.py
git commit -m "feat(sidecar): add JSON Lines server loop with hello and request dispatch"
```

---

### Task 7: Electron 工程脚手架

**Files:**
- Create: `desktop/package.json`
- Create: `desktop/tsconfig.json`
- Create: `desktop/vite.config.ts`
- Create: `desktop/electron/tsconfig.json`
- Modify: 根 `package.json`（增加 `"desktop": "npm --prefix desktop start"`，保留原 `start` 给 PyQt）
- Modify: `.gitignore`（增加 `desktop/node_modules`、`desktop/dist`、`desktop/out`）

**Interfaces:**
- Produces: `cd desktop && npm install && npm run build` 可通过；开发脚本 `npm run dev` 起 Vite + Electron

- [ ] **Step 1: 初始化依赖**

`desktop/package.json` 关键字段：

- `name`: `video-downloader`
- `productName` 稍后打包用：`Video Downloader`
- dependencies: `electron`（钉版本）、`react`、`react-dom`、`zod`
- devDependencies: `typescript`、`vite`、`vite-plugin-electron` 或双进程手动 concurrently、`vitest`、`@types/node`、`@types/react`

**不要**在阶段 1 引入 electron-builder 签名流程。

- [ ] **Step 2: 最小 `main.ts` 能开空窗（暂时不接 Sidecar）→ 提交**

```bash
git add desktop package.json .gitignore
git commit -m "chore(desktop): scaffold Electron + Vite + TypeScript app shell"
```

---

### Task 8: Electron 协议客户端与 Sidecar 监护

**Files:**
- Create: `desktop/electron/protocol.ts`
- Create: `desktop/electron/sidecar.ts`
- Test: `desktop/electron/sidecar.test.ts`（vitest；用假可执行文件 `python -c` 打印固定 hello/response）

**Interfaces:**
- Produces: `class SidecarProcess { start(); request(method, payload); onEvent(); stop() }`
- 心跳：每 5s `app.ping`；连续 3 次超时 → `status: disconnected` 并有限次退避重启（3 次）

- [ ] **Step 1: TS 侧常量与 Method 列表与 Python 对齐（测试对比快照字符串）**

- [ ] **Step 2: 实现 spawn**

```typescript
// 开发态
const python = process.env.VIDEODL_PYTHON ?? path.join(repoRoot, "venv/bin/python");
spawn(python, ["-m", "src.sidecar"], { cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"] });
```

stderr 写入日志文件或 `console.error`。请求 Map：`id -> {resolve,reject,timer}`。

- [ ] **Step 3: 假 Sidecar 脚本测握手与 ping → 提交**

```bash
git commit -m "feat(desktop): add SidecarProcess client with hello, RPC, and heartbeat"
```

---

### Task 9: Main IPC + Preload 白名单

**Files:**
- Modify: `desktop/electron/main.ts`
- Create: `desktop/electron/preload.ts`
- Create: `desktop/electron/preload.d.ts`

**Interfaces:**
- Produces: `window.api = { getSnapshot, ping, shutdown, onEvent, getConnectionState }`
- IPC 通道名固定白名单：`sidecar:request`、`sidecar:event`、`sidecar:state`；preload 用 `contextBridge.exposeInMainWorld`
- Main 启用 `app.requestSingleInstanceLock()`；第二实例退出

- [ ] **Step 1: 写 preload 类型测试或简单 node 测试确保不暴露 `require`/`process`**

- [ ] **Step 2: 实现并手工：`npm run dev` 打开窗体能 `getSnapshot`**

- [ ] **Step 3: 提交**

```bash
git commit -m "feat(desktop): wire secure preload API and single-instance main process"
```

---

### Task 10: 最小 Renderer 状态页

**Files:**
- Create: `desktop/renderer/index.html`
- Create: `desktop/renderer/main.tsx`
- Create: `desktop/renderer/App.tsx`
- Create: `desktop/renderer/styles.css`

**范围（故意极简，非命令中心）：**

- 显示连接状态：连接中 / 已连接 / 重连中 / 失败
- 显示任务快照条数与列表（标题、状态、进度）
- 按钮：刷新快照、退出应用（走 `app.shutdown`）
- Sidecar 失败时展示日志目录路径（从 Main 传入）

不实现侧边栏、新建任务表单、设置页（阶段 2）。

- [ ] **Step 1: 实现 → `npm run dev` 冒烟 → 提交**

```bash
git commit -m "feat(desktop): add minimal renderer for sidecar connection and snapshot"
```

---

### Task 11: 端到端协议验收

**Files:**
- Create: `tests/sidecar/test_e2e_subprocess.py`
- 可能小改 server/handlers

- [ ] **Step 1: 子进程真 E2E**

用 `subprocess.Popen([venv_python, "-m", "src.sidecar"], ...)`，临时 `VIDEODL_DATA_DIR` 环境变量指向 `tmp_path`（`AppPaths` 需支持该 env，Task 3 一并预留）。

流程：hello → ping → settings.update → getSnapshot → shutdown；断言退出码 0、stdout 无非 JSON 行。

- [ ] **Step 2: 全量回归**

```bash
pytest tests -q
cd desktop && npm test
```

- [ ] **Step 3: 对照规格阶段 1 验收清单**

- [ ] 协议 schema 冻结（方法集合完整）
- [ ] Sidecar 命令循环可独立运行
- [ ] Electron Main/Preload 存在且 contextIsolation
- [ ] 握手、快照、心跳、关闭通路打通
- [ ] PyQt `python src/main.py` 仍可启动

- [ ] **Step 4: 提交收尾**

```bash
git commit -m "test(sidecar): add subprocess e2e for hello-ping-snapshot-shutdown"
```

---

## 阶段 1 明确不做

- 命令中心四页 UI、拖拽、批量解析交互打磨（阶段 2）
- 旧 Trae 数据迁移（阶段 3）
- yt-dlp 独立更新实装（阶段 3；协议保留 `NOT_IMPLEMENTED`）
- 签名 / 公证 / DMG（阶段 4）
- Windows / Linux

---

## 自审记录

- **规格覆盖**：§13 阶段 1 四项均有任务；心跳参数与 §7.1 一致（5s / 连续 3 次）；单实例与 §6.3 一致；新路径与 §9.1 一致。
- **与阶段 0 衔接**：复用 `DownloadManager` / `QueueStore` / `ParseSession` / `TaskSnapshot`，不重写状态机。
- **提交边界**：Electron 与 Python 分任务提交，避免再出现「引用未入库模块」。
- **占位符**：updater 显式 `NOT_IMPLEMENTED`，不留静默空实现。
