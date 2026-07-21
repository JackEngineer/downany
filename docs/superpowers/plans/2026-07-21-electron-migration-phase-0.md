# Electron 迁移阶段 0：核心稳定化 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把下载核心从 Qt 中解耦、建立不可变快照、实现队列持久化与重启恢复、实现可取消解析、修复退出语义，为 Python Sidecar 打好地基，同时保持 PyQt 应用可运行。

**Architecture:** 核心（`src/core/`、`src/data/`）移除所有 PyQt 依赖，用线程安全的回调事件分发器替代 pyqtSignal；PyQt 界面通过一个薄 Qt 适配器（保留原有 7 个信号和方法签名）继续工作。队列持久化到与历史同库的 SQLite 新表 `task_queue`；解析改为子进程方式运行 yt-dlp，从而可被真正中断和超时。

**Tech Stack:** Python 3、threading、sqlite3、subprocess、yt-dlp、pytest、PyQt6（仅适配器层）。

**规格来源:** `docs/superpowers/specs/2026-07-19-electron-migration-design.md` 第 6.5、8.3、13（阶段 0）节。

**约定:**
- 测试命令一律在仓库根目录、激活 venv 后运行：`source venv/bin/activate`。
- 现有仓库有未提交改动；开工前先创建分支，只提交本计划涉及的文件。
- UI 文案中文，标识符英文；不使用内联 import。

---

## 文件结构总览

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/core/events.py` | 新建 | Qt 无关的线程安全事件分发器 |
| `src/core/interfaces.py` | 新建 | 核心对配置/历史库的 Protocol 依赖声明 |
| `src/core/download_manager.py` | 修改 | 去 Qt 化、构造注入、快照、持久化钩子、退出即暂停 |
| `src/core/download_task.py` | 修改 | 新增不可变 `TaskSnapshot` 与 `to_snapshot()` |
| `src/core/url_parser.py` | 新建 | 子进程方式的可取消、带超时 URL 解析 |
| `src/data/queue_store.py` | 新建 | `task_queue` 表的读写与任务重建 |
| `src/ui/qt_manager_adapter.py` | 新建 | pyqtSignal 适配器 + 默认管理器工厂 |
| `src/ui/main_window.py` | 修改 | 改用适配器 |
| `tests/core/test_events.py` | 新建 | 事件分发器测试 |
| `tests/core/test_download_manager.py` | 修改 | 去 Qt 化后重写 |
| `tests/core/test_task_snapshot.py` | 新建 | 快照测试 |
| `tests/data/test_queue_store.py` | 新建 | 队列持久化测试 |
| `tests/core/test_queue_restore.py` | 新建 | 重启恢复与退出语义测试 |
| `tests/core/test_url_parser.py` | 新建 | 解析取消/超时测试 |
| `tests/ui/test_qt_manager_adapter.py` | 新建 | 适配器信号转发测试 |

---

### Task 0: 建立工作分支

- [ ] **Step 1: 创建分支**

```bash
git checkout -b electron-phase-0
```

现有未提交改动保持原样，不要 stash 或提交；本计划的每次提交只 `git add` 计划中点名的文件。

---

### Task 1: 核心事件分发器

**Files:**
- Create: `src/core/events.py`
- Test: `tests/core/test_events.py`

- [ ] **Step 1: 写失败测试**

创建 `tests/core/test_events.py`：

```python
"""EventEmitter 行为测试。"""
import threading

from src.core.events import EventEmitter


def test_emit_delivers_event_and_payload():
    emitter = EventEmitter()
    received = []
    emitter.subscribe(lambda event, payload: received.append((event, payload)))

    emitter.emit("task_added", {"task_id": "abc"})

    assert received == [("task_added", {"task_id": "abc"})]


def test_emit_without_payload_delivers_empty_dict():
    emitter = EventEmitter()
    received = []
    emitter.subscribe(lambda event, payload: received.append(payload))

    emitter.emit("task_started")

    assert received == [{}]


def test_unsubscribe_stops_delivery():
    emitter = EventEmitter()
    received = []
    unsubscribe = emitter.subscribe(lambda event, payload: received.append(event))

    emitter.emit("a")
    unsubscribe()
    emitter.emit("b")

    assert received == ["a"]


def test_concurrent_emit_is_safe():
    emitter = EventEmitter()
    received = []
    lock = threading.Lock()

    def listener(event, payload):
        with lock:
            received.append(event)

    emitter.subscribe(listener)
    threads = [
        threading.Thread(target=lambda: [emitter.emit("x") for _ in range(100)])
        for _ in range(8)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert len(received) == 800
```

- [ ] **Step 2: 运行确认失败**

Run: `pytest tests/core/test_events.py -v`
Expected: FAIL，`ModuleNotFoundError: No module named 'src.core.events'`

- [ ] **Step 3: 实现**

创建 `src/core/events.py`：

```python
"""下载核心事件分发器，不依赖 Qt。"""
from __future__ import annotations

import threading
from typing import Any, Callable, Dict, List, Optional

Listener = Callable[[str, Dict[str, Any]], None]


class EventEmitter:
    """线程安全的事件分发器。监听器在触发线程上同步执行。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._listeners: List[Listener] = []

    def subscribe(self, listener: Listener) -> Callable[[], None]:
        """注册监听器，返回反注册函数。"""
        with self._lock:
            self._listeners.append(listener)

        def unsubscribe() -> None:
            with self._lock:
                if listener in self._listeners:
                    self._listeners.remove(listener)

        return unsubscribe

    def emit(self, event: str, payload: Optional[Dict[str, Any]] = None) -> None:
        with self._lock:
            listeners = list(self._listeners)
        data = payload if payload is not None else {}
        for listener in listeners:
            listener(event, data)
```

- [ ] **Step 4: 运行确认通过**

Run: `pytest tests/core/test_events.py -v`
Expected: 4 passed

- [ ] **Step 5: 提交**

```bash
git add src/core/events.py tests/core/test_events.py
git commit -m "feat(core): add Qt-free thread-safe EventEmitter"
```

---

### Task 2: DownloadManager 去 Qt 化与依赖注入

**Files:**
- Create: `src/core/interfaces.py`
- Modify: `src/core/download_manager.py`
- Test: `tests/core/test_download_manager.py`（重写）

事件名与 payload 约定（后续所有任务遵守）：

| 事件 | payload |
|---|---|
| `task_added` | `{"task_id": str}` |
| `task_started` | `{"task_id": str}` |
| `task_progress` | `{"task_id": str, "progress": dict}` |
| `task_completed` | `{"task_id": str}` |
| `task_failed` | `{"task_id": str, "error": str}` |
| `task_paused` | `{"task_id": str}` |
| `task_cancelled` | `{"task_id": str}` |

- [ ] **Step 1: 创建接口声明**

创建 `src/core/interfaces.py`：

```python
"""核心对外部依赖的最小接口声明（Qt 无关）。"""
from __future__ import annotations

from typing import Protocol

from src.data.models import DownloadRecord


class DownloadConfig(Protocol):
    """下载核心需要的配置读取能力。"""

    def get_concurrent_downloads(self) -> int: ...


class HistoryWriter(Protocol):
    """下载核心需要的历史写入能力。"""

    def add_download_record(self, record: DownloadRecord) -> None: ...
```

- [ ] **Step 2: 重写测试（先于实现修改）**

用以下内容整体替换 `tests/core/test_download_manager.py`。与旧版的差异：不再依赖 QCoreApplication，管理器通过构造注入 config/db，信号断言改为事件断言。

```python
"""DownloadManager 状态机与并发安全测试（Qt 无关）。"""
import threading
import time
from unittest.mock import MagicMock, patch

import pytest

from src.core.download_manager import DownloadManager
from src.core.download_task import DownloadOptions, DownloadTask, TaskStatus, VideoInfo
from src.core.downloader import DownloadCancelled, DownloadError


@pytest.fixture
def manager():
    config = MagicMock()
    config.get_concurrent_downloads.return_value = 2
    db = MagicMock()
    mgr = DownloadManager(config=config, db=db)
    mgr.start()
    yield mgr
    mgr.stop(join_timeout=2)


def _make_task(url="https://example.com/a", title="t"):
    return DownloadTask(
        video_info=VideoInfo(url=url, title=title),
        options=DownloadOptions(output_path="/tmp"),
    )


def _wait_until(predicate, timeout=3.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return predicate()


def test_download_failure_marks_failed_and_emits_event(manager):
    task = _make_task()
    events = []
    manager.events.subscribe(lambda e, p: events.append((e, p)))

    with patch("src.core.download_manager.Downloader") as mock_cls, patch(
        "src.core.download_manager.VideoInfoExtractor.extract", return_value=None
    ):
        instance = MagicMock()
        instance.download.side_effect = DownloadError("boom")
        mock_cls.return_value = instance
        manager.add_task(task)
        assert _wait_until(lambda: task.status == TaskStatus.FAILED)

    assert "boom" in task.error_message
    manager.db.add_download_record.assert_called()
    assert ("task_added", {"task_id": task.id}) in events
    assert ("task_failed", {"task_id": task.id, "error": task.error_message}) in events


def test_cancel_does_not_complete(manager):
    task = _make_task(title="cancel-me")
    started = threading.Event()
    proceed = threading.Event()

    def fake_download(url, opts=None):
        started.set()
        proceed.wait(timeout=2)
        raise DownloadCancelled("任务已取消")

    with patch("src.core.download_manager.Downloader") as mock_cls, patch(
        "src.core.download_manager.VideoInfoExtractor.extract", return_value=None
    ):
        instance = MagicMock()
        instance.download.side_effect = fake_download
        mock_cls.return_value = instance
        manager.add_task(task)
        assert started.wait(2)
        manager.cancel_task(task.id)
        proceed.set()
        assert _wait_until(lambda: task.id not in manager.active_tasks)

    assert task.status == TaskStatus.CANCELLED


def test_pause_then_resume_after_thread_exits(manager):
    task = _make_task(title="pause-me")
    call_count = {"n": 0}
    gate = threading.Event()

    def fake_download(url, opts=None):
        call_count["n"] += 1
        if call_count["n"] == 1:
            gate.set()
            time.sleep(0.15)
            raise DownloadCancelled("任务已暂停")
        return "/tmp/done.mp4"

    with patch("src.core.download_manager.Downloader") as mock_cls, patch(
        "src.core.download_manager.VideoInfoExtractor.extract", return_value=None
    ):
        instance = MagicMock()
        instance.download.side_effect = fake_download
        mock_cls.return_value = instance
        manager.add_task(task)
        assert gate.wait(2)
        manager.pause_task(task.id)
        assert _wait_until(lambda: task.id not in manager.active_tasks)
        assert task.status == TaskStatus.PAUSED

        manager.resume_task(task.id)
        assert _wait_until(lambda: task.status == TaskStatus.COMPLETED)

    assert call_count["n"] >= 2


def test_resume_while_active_does_not_double_start(manager):
    task = _make_task(title="double")
    started = threading.Event()
    release = threading.Event()
    starts = []

    def fake_download(url, opts=None):
        starts.append(1)
        started.set()
        release.wait(timeout=2)
        raise DownloadCancelled("任务已暂停")

    with patch("src.core.download_manager.Downloader") as mock_cls, patch(
        "src.core.download_manager.VideoInfoExtractor.extract", return_value=None
    ):
        instance = MagicMock()
        instance.download.side_effect = fake_download
        mock_cls.return_value = instance
        manager.add_task(task)
        assert started.wait(2)
        manager.pause_task(task.id)
        manager.resume_task(task.id)
        assert len(starts) == 1
        release.set()
        assert _wait_until(lambda: task.id not in manager.active_tasks)

    assert len(starts) <= 2


def test_two_managers_are_independent_instances():
    a = DownloadManager(config=MagicMock(), db=MagicMock())
    b = DownloadManager(config=MagicMock(), db=MagicMock())
    assert a is not b
```

- [ ] **Step 3: 运行确认失败**

Run: `pytest tests/core/test_download_manager.py -v`
Expected: FAIL，`TypeError`（当前构造函数不接受 config/db 关键字）或 `AttributeError: 'DownloadManager' object has no attribute 'events'`

- [ ] **Step 4: 修改 `src/core/download_manager.py`**

按以下对照逐处修改。

(a) 文件头 import 区。删除：

```python
from PyQt6.QtCore import QObject, pyqtSignal
```

新增（保持 import 在顶部，与现有 import 合并排序）：

```python
from src.core.events import EventEmitter
from src.core.interfaces import DownloadConfig, HistoryWriter
```

(b) 类定义与构造。将：

```python
class DownloadManager(QObject):
    """下载管理器单例类"""

    _instance = None

    task_added = pyqtSignal(str)
    task_started = pyqtSignal(str)
    task_progress = pyqtSignal(str, dict)
    task_completed = pyqtSignal(str)
    task_failed = pyqtSignal(str, str)
    task_paused = pyqtSignal(str)
    task_cancelled = pyqtSignal(str)

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._initialized = False
        return cls._instance

    def __init__(self):
        if self._initialized:
            return

        super().__init__()
        self._initialized = True

        self.config = ConfigManager()
        self.db = HistoryDB()
```

替换为：

```python
class DownloadManager:
    """下载管理器（Qt 无关）。事件通过 self.events 分发。"""

    def __init__(self, config: DownloadConfig, db: HistoryWriter):
        self.config = config
        self.db = db
        self.events = EventEmitter()
```

(c) 删除文件头对 `ConfigManager` 与 `HistoryDB` 的 import（`from src.data.config_manager import ConfigManager`、`from src.data.database import HistoryDB`），它们不再被引用。

(d) 全部 7 处信号发射逐一替换：

| 原代码 | 新代码 |
|---|---|
| `self.task_added.emit(task.id)` | `self.events.emit("task_added", {"task_id": task.id})` |
| `self.task_started.emit(task.id)` | `self.events.emit("task_started", {"task_id": task.id})` |
| `self.task_progress.emit(task.id, slim)` | `self.events.emit("task_progress", {"task_id": task.id, "progress": slim})` |
| `self.task_completed.emit(task.id)` | `self.events.emit("task_completed", {"task_id": task.id})` |
| `self.task_failed.emit(task.id, str(e))` | `self.events.emit("task_failed", {"task_id": task.id, "error": str(e)})` |
| `self.task_paused.emit(task_id)` | `self.events.emit("task_paused", {"task_id": task_id})` |
| `self.task_cancelled.emit(task_id)`（cancel_task 内） | `self.events.emit("task_cancelled", {"task_id": task_id})` |
| `self.task_cancelled.emit(task.id)`（_download_task 异常分支内） | `self.events.emit("task_cancelled", {"task_id": task.id})` |

- [ ] **Step 5: 运行确认通过**

Run: `pytest tests/core/test_download_manager.py tests/core/test_events.py -v`
Expected: 全部 passed

- [ ] **Step 6: 提交**

```bash
git add src/core/interfaces.py src/core/download_manager.py tests/core/test_download_manager.py
git commit -m "refactor(core): remove Qt from DownloadManager, inject config/db, emit via EventEmitter"
```

此刻 PyQt 界面暂时不可运行（main_window 仍按旧接口构造），Task 3 立即修复。

---

### Task 3: Qt 适配器与界面接线

**Files:**
- Create: `src/ui/qt_manager_adapter.py`
- Modify: `src/ui/main_window.py`
- Test: `tests/ui/test_qt_manager_adapter.py`

- [ ] **Step 1: 写失败测试**

创建 `tests/ui/test_qt_manager_adapter.py`：

```python
"""Qt 适配器信号转发测试。"""
from unittest.mock import MagicMock

import pytest
from PyQt6.QtCore import QCoreApplication

from src.core.download_manager import DownloadManager
from src.ui.qt_manager_adapter import QtDownloadManager


@pytest.fixture(scope="module")
def qapp():
    app = QCoreApplication.instance()
    if app is None:
        app = QCoreApplication([])
    return app


@pytest.fixture
def core_manager():
    config = MagicMock()
    config.get_concurrent_downloads.return_value = 1
    return DownloadManager(config=config, db=MagicMock())


def test_events_forwarded_as_signals(qapp, core_manager):
    adapter = QtDownloadManager(core_manager)
    received = {}
    adapter.task_added.connect(lambda tid: received.setdefault("added", tid))
    adapter.task_progress.connect(lambda tid, d: received.setdefault("progress", (tid, d)))
    adapter.task_failed.connect(lambda tid, err: received.setdefault("failed", (tid, err)))

    core_manager.events.emit("task_added", {"task_id": "t1"})
    core_manager.events.emit("task_progress", {"task_id": "t1", "progress": {"p": 1}})
    core_manager.events.emit("task_failed", {"task_id": "t1", "error": "boom"})
    QCoreApplication.processEvents()

    assert received["added"] == "t1"
    assert received["progress"] == ("t1", {"p": 1})
    assert received["failed"] == ("t1", "boom")


def test_methods_delegate_to_core(qapp, core_manager):
    adapter = QtDownloadManager(core_manager)
    assert adapter.get_all_tasks() == {}
    assert adapter.get_task("missing") is None
    assert adapter.remove_task("missing") is False
```

- [ ] **Step 2: 运行确认失败**

Run: `pytest tests/ui/test_qt_manager_adapter.py -v`
Expected: FAIL，`ModuleNotFoundError: No module named 'src.ui.qt_manager_adapter'`

- [ ] **Step 3: 实现适配器**

创建 `src/ui/qt_manager_adapter.py`：

```python
"""把 Qt 无关的 DownloadManager 适配为带 pyqtSignal 的对象，供现有界面使用。"""
from __future__ import annotations

from typing import Any, Dict, Optional

from PyQt6.QtCore import QObject, pyqtSignal

from src.core.download_manager import DownloadManager
from src.core.download_task import DownloadTask
from src.data.config_manager import ConfigManager
from src.data.database import HistoryDB


class QtDownloadManager(QObject):
    """信号与方法签名同旧版 DownloadManager，内部委托核心管理器。"""

    task_added = pyqtSignal(str)
    task_started = pyqtSignal(str)
    task_progress = pyqtSignal(str, dict)
    task_completed = pyqtSignal(str)
    task_failed = pyqtSignal(str, str)
    task_paused = pyqtSignal(str)
    task_cancelled = pyqtSignal(str)

    def __init__(self, manager: DownloadManager, parent: Optional[QObject] = None):
        super().__init__(parent)
        self._manager = manager
        self._unsubscribe = manager.events.subscribe(self._on_core_event)

    def _on_core_event(self, event: str, payload: Dict[str, Any]) -> None:
        task_id = payload.get("task_id", "")
        if event == "task_added":
            self.task_added.emit(task_id)
        elif event == "task_started":
            self.task_started.emit(task_id)
        elif event == "task_progress":
            self.task_progress.emit(task_id, payload.get("progress", {}))
        elif event == "task_completed":
            self.task_completed.emit(task_id)
        elif event == "task_failed":
            self.task_failed.emit(task_id, payload.get("error", ""))
        elif event == "task_paused":
            self.task_paused.emit(task_id)
        elif event == "task_cancelled":
            self.task_cancelled.emit(task_id)

    # ---- 方法委托，签名与旧版一致 ----

    def start(self) -> None:
        self._manager.start()

    def stop(self, join_timeout: float = 5.0) -> None:
        self._manager.stop(join_timeout=join_timeout)

    def add_task(self, task: DownloadTask) -> None:
        self._manager.add_task(task)

    def pause_task(self, task_id: str) -> None:
        self._manager.pause_task(task_id)

    def resume_task(self, task_id: str) -> None:
        self._manager.resume_task(task_id)

    def cancel_task(self, task_id: str) -> None:
        self._manager.cancel_task(task_id)

    def retry_task(self, task_id: str) -> None:
        self._manager.retry_task(task_id)

    def get_task(self, task_id: str) -> Optional[DownloadTask]:
        return self._manager.get_task(task_id)

    def get_all_tasks(self) -> Dict[str, DownloadTask]:
        return self._manager.get_all_tasks()

    def remove_task(self, task_id: str) -> bool:
        return self._manager.remove_task(task_id)


def create_default_manager() -> QtDownloadManager:
    """PyQt 应用的默认装配：真实配置 + 真实历史库。"""
    core = DownloadManager(config=ConfigManager(), db=HistoryDB())
    return QtDownloadManager(core)
```

- [ ] **Step 4: 接线 main_window**

修改 `src/ui/main_window.py`。import 区将：

```python
from src.core.download_manager import DownloadManager
```

替换为：

```python
from src.ui.qt_manager_adapter import create_default_manager
```

`__init__` 中将：

```python
        self.download_manager = DownloadManager()
        self.download_manager.start()
```

替换为：

```python
        self.download_manager = create_default_manager()
        self.download_manager.start()
```

各 Tab 文件（`queue_tab.py`、`history_tab.py`、`search_tab.py`、`download_tab.py`、`queue_model.py`）的类型标注仍写 `DownloadManager`，运行时收到的是鸭子类型兼容的适配器。本任务顺带把这五个文件的类型标注改为 `QtDownloadManager`（import 从 `src.ui.qt_manager_adapter`），保证标注真实。每个文件的改法相同，以 `queue_tab.py` 为例：

```python
# 原
from src.core.download_manager import DownloadManager
...
def __init__(self, download_manager: DownloadManager, toast: ToastService | None = None):

# 新
from src.ui.qt_manager_adapter import QtDownloadManager
...
def __init__(self, download_manager: QtDownloadManager, toast: ToastService | None = None):
```

- [ ] **Step 5: 运行适配器与全部 UI 测试**

Run: `pytest tests/ui tests/core -v`
Expected: 全部 passed（若 UI 测试因构造方式失败，按失败信息把测试中的 `DownloadManager()` 单例用法替换为 `create_default_manager()` 或 MagicMock）

- [ ] **Step 6: 手工冒烟**

Run: `python src/main.py`
Expected: 窗口正常打开，添加一条下载任务队列页有响应（无需等待下载完成），关闭无崩溃。

- [ ] **Step 7: 提交**

```bash
git add src/ui/qt_manager_adapter.py src/ui/main_window.py src/ui/tabs/queue_tab.py src/ui/tabs/history_tab.py src/ui/tabs/search_tab.py src/ui/tabs/download_tab.py src/ui/tabs/queue_model.py tests/ui/test_qt_manager_adapter.py
git commit -m "feat(ui): bridge Qt UI to core via QtDownloadManager adapter"
```

---

### Task 4: 不可变任务快照

**Files:**
- Modify: `src/core/download_task.py`
- Modify: `src/core/download_manager.py`
- Test: `tests/core/test_task_snapshot.py`

- [ ] **Step 1: 写失败测试**

创建 `tests/core/test_task_snapshot.py`：

```python
"""TaskSnapshot 不可变性与内容测试。"""
import dataclasses
from unittest.mock import MagicMock

import pytest

from src.core.download_manager import DownloadManager
from src.core.download_task import (
    DownloadOptions,
    DownloadTask,
    Platform,
    TaskStatus,
    VideoInfo,
)


def _make_task():
    return DownloadTask(
        video_info=VideoInfo(
            url="https://example.com/v",
            title="示例视频",
            platform=Platform.YOUTUBE,
        ),
        options=DownloadOptions(output_path="/tmp"),
        status=TaskStatus.DOWNLOADING,
        progress=42.5,
        downloaded_bytes=1000,
        total_bytes=2000,
    )


def test_to_snapshot_copies_fields():
    task = _make_task()
    snap = task.to_snapshot()
    assert snap.id == task.id
    assert snap.url == "https://example.com/v"
    assert snap.title == "示例视频"
    assert snap.platform == "youtube"
    assert snap.status == "downloading"
    assert snap.progress == 42.5
    assert snap.downloaded_bytes == 1000
    assert snap.total_bytes == 2000


def test_snapshot_is_immutable():
    snap = _make_task().to_snapshot()
    with pytest.raises(dataclasses.FrozenInstanceError):
        snap.progress = 99.0


def test_manager_get_snapshot_returns_all_tasks():
    config = MagicMock()
    config.get_concurrent_downloads.return_value = 1
    manager = DownloadManager(config=config, db=MagicMock())
    task = _make_task()
    with manager._lock:
        manager.tasks[task.id] = task
    snaps = manager.get_snapshot()
    assert len(snaps) == 1
    assert snaps[0].id == task.id
```

- [ ] **Step 2: 运行确认失败**

Run: `pytest tests/core/test_task_snapshot.py -v`
Expected: FAIL，`AttributeError: 'DownloadTask' object has no attribute 'to_snapshot'`

- [ ] **Step 3: 实现**

在 `src/core/download_task.py` 的 `DownloadTask` 类定义之前新增：

```python
@dataclass(frozen=True)
class TaskSnapshot:
    """任务的不可变快照，用于跨线程/跨进程只读展示。"""
    id: str
    url: str
    title: str
    platform: str
    status: str
    progress: float
    downloaded_bytes: int
    total_bytes: int
    speed: str
    eta: str
    file_path: str
    error_message: str
    created_at: str
    started_at: Optional[str]
    completed_at: Optional[str]
```

在 `DownloadTask` 类内（`to_dict` 之后）新增方法：

```python
    def to_snapshot(self) -> "TaskSnapshot":
        """生成不可变快照。"""
        return TaskSnapshot(
            id=self.id,
            url=self.video_info.url,
            title=self.video_info.title,
            platform=self.video_info.platform.value,
            status=self.status.value,
            progress=self.progress,
            downloaded_bytes=self.downloaded_bytes,
            total_bytes=self.total_bytes,
            speed=self.speed,
            eta=self.eta,
            file_path=self.file_path,
            error_message=self.error_message,
            created_at=self.created_at.isoformat(),
            started_at=self.started_at.isoformat() if self.started_at else None,
            completed_at=self.completed_at.isoformat() if self.completed_at else None,
        )
```

在 `src/core/download_manager.py` 中，`get_all_tasks` 方法之后新增（import 区补 `from src.core.download_task import TaskSnapshot` 到现有 import 行，以及 `from typing import List`——该文件 typing import 已有 Dict/Optional/Set，加 List 即可）：

```python
    def get_snapshot(self) -> List[TaskSnapshot]:
        """所有任务的不可变快照（锁内构建，锁外安全使用）。"""
        with self._lock:
            return [task.to_snapshot() for task in self.tasks.values()]
```

- [ ] **Step 4: 运行确认通过**

Run: `pytest tests/core/test_task_snapshot.py -v`
Expected: 3 passed

- [ ] **Step 5: 提交**

```bash
git add src/core/download_task.py src/core/download_manager.py tests/core/test_task_snapshot.py
git commit -m "feat(core): add immutable TaskSnapshot and DownloadManager.get_snapshot"
```

---

### Task 5: 队列持久化存储 QueueStore

**Files:**
- Create: `src/data/queue_store.py`
- Test: `tests/data/test_queue_store.py`

- [ ] **Step 1: 写失败测试**

创建 `tests/data/test_queue_store.py`：

```python
"""QueueStore 读写与任务重建测试。"""
from src.core.download_task import (
    DownloadOptions,
    DownloadTask,
    Platform,
    TaskStatus,
    VideoInfo,
)
from src.data.queue_store import QueueStore


def _make_task(status=TaskStatus.PENDING):
    return DownloadTask(
        video_info=VideoInfo(
            url="https://example.com/v",
            title="示例",
            duration=120,
            uploader="up",
            platform=Platform.BILIBILI,
            file_size=999,
        ),
        options=DownloadOptions(
            quality="1080p",
            download_subtitles=True,
            output_path="/tmp/dl",
            speed_limit=1024,
            proxy="http://127.0.0.1:7890",
        ),
        status=status,
        progress=33.0,
        downloaded_bytes=100,
        total_bytes=300,
    )


def test_upsert_and_load_roundtrip(tmp_path):
    store = QueueStore(str(tmp_path / "q.db"))
    task = _make_task()
    store.upsert_task(task)

    loaded = store.load_tasks()
    assert len(loaded) == 1
    got = loaded[0]
    assert got.id == task.id
    assert got.video_info.url == "https://example.com/v"
    assert got.video_info.title == "示例"
    assert got.video_info.platform == Platform.BILIBILI
    assert got.options.quality == "1080p"
    assert got.options.download_subtitles is True
    assert got.options.output_path == "/tmp/dl"
    assert got.options.speed_limit == 1024
    assert got.options.proxy == "http://127.0.0.1:7890"
    assert got.status == TaskStatus.PENDING
    assert got.progress == 33.0
    assert got.downloaded_bytes == 100
    assert got.total_bytes == 300


def test_upsert_twice_keeps_single_row(tmp_path):
    store = QueueStore(str(tmp_path / "q.db"))
    task = _make_task()
    store.upsert_task(task)
    task.status = TaskStatus.PAUSED
    store.upsert_task(task)

    loaded = store.load_tasks()
    assert len(loaded) == 1
    assert loaded[0].status == TaskStatus.PAUSED


def test_update_progress(tmp_path):
    store = QueueStore(str(tmp_path / "q.db"))
    task = _make_task()
    store.upsert_task(task)
    store.update_progress(task.id, 80.0, 240, 300)

    got = store.load_tasks()[0]
    assert got.progress == 80.0
    assert got.downloaded_bytes == 240


def test_remove_task(tmp_path):
    store = QueueStore(str(tmp_path / "q.db"))
    task = _make_task()
    store.upsert_task(task)
    store.remove_task(task.id)
    assert store.load_tasks() == []


def test_shares_db_file_with_history(tmp_path):
    """与历史库共用同一个 SQLite 文件不冲突。"""
    db_file = str(tmp_path / "history.db")
    from src.data.database import HistoryDB

    HistoryDB._instance = None
    HistoryDB(db_path=db_file)
    store = QueueStore(db_file)
    store.upsert_task(_make_task())
    assert len(store.load_tasks()) == 1
    HistoryDB._instance = None
```

- [ ] **Step 2: 运行确认失败**

Run: `pytest tests/data/test_queue_store.py -v`
Expected: FAIL，`ModuleNotFoundError: No module named 'src.data.queue_store'`

- [ ] **Step 3: 实现**

创建 `src/data/queue_store.py`：

```python
"""下载队列持久化存储（Qt 无关）。与历史记录共用同一个 SQLite 文件。"""
from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime
from typing import List

from src.core.download_task import (
    DownloadOptions,
    DownloadTask,
    Platform,
    TaskStatus,
    VideoInfo,
)
from src.utils.logger import setup_logger

logger = setup_logger("QueueStore")


class QueueStore:
    """task_queue 表的读写与 DownloadTask 重建。"""

    def __init__(self, db_path: str):
        self.db_path = db_path
        os.makedirs(os.path.dirname(self.db_path) or ".", exist_ok=True)
        self._init_table()

    def _get_connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout=5000")
        conn.execute("PRAGMA journal_mode=WAL")
        return conn

    def _init_table(self) -> None:
        with self._get_connection() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS task_queue (
                    id TEXT PRIMARY KEY,
                    status TEXT NOT NULL,
                    progress REAL NOT NULL DEFAULT 0,
                    downloaded_bytes INTEGER NOT NULL DEFAULT 0,
                    total_bytes INTEGER NOT NULL DEFAULT 0,
                    error_message TEXT NOT NULL DEFAULT '',
                    file_path TEXT NOT NULL DEFAULT '',
                    video_info_json TEXT NOT NULL,
                    options_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            conn.commit()

    def upsert_task(self, task: DownloadTask) -> None:
        # formats 列表可能很大且可再解析，不落库
        video_info = {
            "url": task.video_info.url,
            "title": task.video_info.title,
            "duration": task.video_info.duration,
            "thumbnail_url": task.video_info.thumbnail_url,
            "uploader": task.video_info.uploader,
            "platform": task.video_info.platform.value,
            "file_size": task.video_info.file_size,
        }
        options = {
            "format_id": task.options.format_id,
            "quality": task.options.quality,
            "download_subtitles": task.options.download_subtitles,
            "output_path": task.options.output_path,
            "speed_limit": task.options.speed_limit,
            "proxy": task.options.proxy,
        }
        with self._get_connection() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO task_queue
                (id, status, progress, downloaded_bytes, total_bytes, error_message,
                 file_path, video_info_json, options_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    task.id,
                    task.status.value,
                    task.progress,
                    task.downloaded_bytes,
                    task.total_bytes,
                    task.error_message,
                    task.file_path,
                    json.dumps(video_info, ensure_ascii=False),
                    json.dumps(options, ensure_ascii=False),
                    task.created_at.isoformat(),
                    datetime.now().isoformat(),
                ),
            )
            conn.commit()

    def update_progress(
        self, task_id: str, progress: float, downloaded_bytes: int, total_bytes: int
    ) -> None:
        with self._get_connection() as conn:
            conn.execute(
                """
                UPDATE task_queue
                SET progress = ?, downloaded_bytes = ?, total_bytes = ?, updated_at = ?
                WHERE id = ?
                """,
                (progress, downloaded_bytes, total_bytes, datetime.now().isoformat(), task_id),
            )
            conn.commit()

    def remove_task(self, task_id: str) -> None:
        with self._get_connection() as conn:
            conn.execute("DELETE FROM task_queue WHERE id = ?", (task_id,))
            conn.commit()

    def load_tasks(self) -> List[DownloadTask]:
        with self._get_connection() as conn:
            rows = conn.execute(
                "SELECT * FROM task_queue ORDER BY created_at ASC"
            ).fetchall()
        tasks: List[DownloadTask] = []
        for row in rows:
            try:
                tasks.append(self._row_to_task(row))
            except (ValueError, KeyError, json.JSONDecodeError) as exc:
                logger.error(f"跳过无法重建的队列行 {row['id']}: {exc}")
        return tasks

    @staticmethod
    def _row_to_task(row: sqlite3.Row) -> DownloadTask:
        info = json.loads(row["video_info_json"])
        opts = json.loads(row["options_json"])
        try:
            platform = Platform(info.get("platform", "unknown"))
        except ValueError:
            platform = Platform.UNKNOWN
        return DownloadTask(
            id=row["id"],
            video_info=VideoInfo(
                url=info["url"],
                title=info.get("title", ""),
                duration=info.get("duration", 0),
                thumbnail_url=info.get("thumbnail_url", ""),
                uploader=info.get("uploader", ""),
                platform=platform,
                file_size=info.get("file_size", 0),
            ),
            options=DownloadOptions(
                format_id=opts.get("format_id"),
                quality=opts.get("quality", "best"),
                download_subtitles=bool(opts.get("download_subtitles", False)),
                output_path=opts.get("output_path", "downloads"),
                speed_limit=opts.get("speed_limit"),
                proxy=opts.get("proxy"),
            ),
            status=TaskStatus(row["status"]),
            progress=row["progress"],
            downloaded_bytes=row["downloaded_bytes"],
            total_bytes=row["total_bytes"],
            file_path=row["file_path"],
            error_message=row["error_message"],
            created_at=datetime.fromisoformat(row["created_at"]),
        )
```

- [ ] **Step 4: 运行确认通过**

Run: `pytest tests/data/test_queue_store.py -v`
Expected: 5 passed

- [ ] **Step 5: 提交**

```bash
git add src/data/queue_store.py tests/data/test_queue_store.py
git commit -m "feat(data): add QueueStore for download queue persistence"
```

---

### Task 6: 管理器接入持久化与重启恢复

**Files:**
- Modify: `src/core/download_manager.py`
- Modify: `src/ui/qt_manager_adapter.py`（工厂装配 QueueStore）
- Test: `tests/core/test_queue_restore.py`

- [ ] **Step 1: 写失败测试**

创建 `tests/core/test_queue_restore.py`：

```python
"""队列持久化接入与重启恢复测试。"""
import time
from unittest.mock import MagicMock

from src.core.download_manager import DownloadManager
from src.core.download_task import DownloadOptions, DownloadTask, TaskStatus, VideoInfo
from src.data.queue_store import QueueStore


def _make_task(status=TaskStatus.PENDING, title="t"):
    return DownloadTask(
        video_info=VideoInfo(url="https://example.com/a", title=title),
        options=DownloadOptions(output_path="/tmp"),
        status=status,
    )


def _make_manager(store):
    config = MagicMock()
    config.get_concurrent_downloads.return_value = 1
    return DownloadManager(config=config, db=MagicMock(), queue_store=store)


def test_add_task_persists(tmp_path):
    store = QueueStore(str(tmp_path / "q.db"))
    manager = _make_manager(store)
    task = _make_task()
    manager.add_task(task)
    assert [t.id for t in store.load_tasks()] == [task.id]


def test_status_change_persists(tmp_path):
    store = QueueStore(str(tmp_path / "q.db"))
    manager = _make_manager(store)
    task = _make_task(status=TaskStatus.DOWNLOADING)
    with manager._lock:
        manager.tasks[task.id] = task
    store.upsert_task(task)

    manager.pause_task(task.id)
    assert store.load_tasks()[0].status == TaskStatus.PAUSED


def test_remove_task_removes_row(tmp_path):
    store = QueueStore(str(tmp_path / "q.db"))
    manager = _make_manager(store)
    task = _make_task(status=TaskStatus.COMPLETED)
    with manager._lock:
        manager.tasks[task.id] = task
    store.upsert_task(task)

    assert manager.remove_task(task.id) is True
    assert store.load_tasks() == []


def test_restore_downgrades_downloading_to_paused(tmp_path):
    store = QueueStore(str(tmp_path / "q.db"))
    store.upsert_task(_make_task(status=TaskStatus.DOWNLOADING, title="was-downloading"))
    store.upsert_task(_make_task(status=TaskStatus.COMPLETED, title="done"))

    manager = _make_manager(store)
    manager.restore_tasks()

    statuses = {t.video_info.title: t.status for t in manager.get_all_tasks().values()}
    assert statuses["was-downloading"] == TaskStatus.PAUSED
    assert statuses["done"] == TaskStatus.COMPLETED
    # 降级后的状态要写回数据库
    persisted = {t.video_info.title: t.status for t in store.load_tasks()}
    assert persisted["was-downloading"] == TaskStatus.PAUSED


def test_restore_reenqueues_pending(tmp_path):
    store = QueueStore(str(tmp_path / "q.db"))
    store.upsert_task(_make_task(status=TaskStatus.PENDING, title="waiting"))

    manager = _make_manager(store)
    manager.restore_tasks()

    assert manager.task_queue.qsize() == 1


def test_manager_without_store_still_works():
    config = MagicMock()
    config.get_concurrent_downloads.return_value = 1
    manager = DownloadManager(config=config, db=MagicMock())
    task = _make_task()
    manager.add_task(task)
    manager.restore_tasks()  # 无存储时为空操作
    assert task.id in manager.get_all_tasks()
```

- [ ] **Step 2: 运行确认失败**

Run: `pytest tests/core/test_queue_restore.py -v`
Expected: FAIL，`TypeError: __init__() got an unexpected keyword argument 'queue_store'`

- [ ] **Step 3: 修改 `src/core/download_manager.py`**

(a) import 区新增：

```python
import time

from src.data.queue_store import QueueStore
```

类型标注用 `Optional[QueueStore]`。注意：`src/data/queue_store.py` 不 import 任何 core 之外的东西，不构成循环依赖（queue_store 只 import download_task）。

(b) 构造函数改为：

```python
    def __init__(
        self,
        config: DownloadConfig,
        db: HistoryWriter,
        queue_store: Optional[QueueStore] = None,
    ):
        self.config = config
        self.db = db
        self.queue_store = queue_store
        self.events = EventEmitter()
        self._last_progress_persist: Dict[str, float] = {}
```

（其余已有初始化行保持不变。）

(c) 新增私有持久化助手（放在 `add_task` 之前）：

```python
    def _persist(self, task: DownloadTask) -> None:
        """把任务当前状态写入队列存储；失败只记日志，不影响下载。"""
        if self.queue_store is None:
            return
        try:
            self.queue_store.upsert_task(task)
        except Exception as exc:
            logger.error(f"持久化任务失败 {task.id}: {exc}")

    def _persist_remove(self, task_id: str) -> None:
        if self.queue_store is None:
            return
        try:
            self.queue_store.remove_task(task_id)
        except Exception as exc:
            logger.error(f"删除持久化任务失败 {task_id}: {exc}")
```

(d) 新增恢复方法（放在 `start` 之前）：

```python
    def restore_tasks(self) -> None:
        """从队列存储恢复任务。下载中降级为已暂停；等待中重新入队。"""
        if self.queue_store is None:
            return
        restored = self.queue_store.load_tasks()
        downgraded = []
        with self._lock:
            for task in restored:
                if task.status == TaskStatus.DOWNLOADING:
                    task.status = TaskStatus.PAUSED
                    downgraded.append(task)
                self.tasks[task.id] = task
                if task.status == TaskStatus.PENDING:
                    self.task_queue.put(task.id)
        for task in downgraded:
            self._persist(task)
        if restored:
            logger.info(f"从数据库恢复 {len(restored)} 个任务")
```

(e) 在每个状态变化点之后调用持久化（逐处添加）：

- `add_task`：`self.task_queue.put(task.id)` 之后（锁外、emit 之前或之后均可，放 emit 之前）加 `self._persist(task)`。
- `pause_task`：`self.events.emit("task_paused", ...)` 之前加 `self._persist(task)`。
- `resume_task`：两个分支——`self._resume_requested.add(task_id)` 分支无状态变化不持久化；正常分支在 `self.task_queue.put(task_id)` 之后（锁外）加 `self._persist(task)`。
- `cancel_task`：emit 之前加 `self._persist(task)`。
- `retry_task`：`self.task_queue.put(task_id)` 之后（锁外）加 `self._persist(task)`。
- `remove_task`：`self.tasks.pop(task_id, None)` 之后加 `self._persist_remove(task_id)`。
- `_download_task`：
  - 状态置 DOWNLOADING 后（`self.events.emit("task_started", ...)` 之前）加 `self._persist(task)`；
  - 完成分支 `self._save_to_history(task)` 之后加 `self._persist(task)`；
  - `DownloadCancelled` 分支：PAUSED 与 CANCELLED 两个路径各加 `self._persist(task)`；
  - 失败分支 `self._save_to_history(task)` 之后加 `self._persist(task)`；
  - `finally` 中 requeue 路径 `self.task_queue.put(task.id)` 之后加 `self._persist(task)`（在 `with self._lock` 块之外，用 requeue 标志判断）。

(f) 进度低频写库。在 `progress_callback` 内、`self.events.emit("task_progress", ...)` 之前加：

```python
                if self.queue_store is not None:
                    now = time.monotonic()
                    last = self._last_progress_persist.get(task.id, 0.0)
                    if now - last >= 2.0:
                        self._last_progress_persist[task.id] = now
                        try:
                            self.queue_store.update_progress(
                                task.id, task.progress, downloaded, total
                            )
                        except Exception as exc:
                            logger.error(f"持久化进度失败 {task.id}: {exc}")
```

- [ ] **Step 4: 更新工厂装配**

修改 `src/ui/qt_manager_adapter.py` 的 `create_default_manager`：

```python
def create_default_manager() -> QtDownloadManager:
    """PyQt 应用的默认装配：真实配置 + 真实历史库 + 队列持久化。"""
    db = HistoryDB()
    store = QueueStore(db.db_path)
    core = DownloadManager(config=ConfigManager(), db=db, queue_store=store)
    core.restore_tasks()
    return QtDownloadManager(core)
```

import 区补 `from src.data.queue_store import QueueStore`。

- [ ] **Step 5: 运行确认通过**

Run: `pytest tests/core/test_queue_restore.py tests/core/test_download_manager.py -v`
Expected: 全部 passed

- [ ] **Step 6: 手工冒烟（队列跨重启）**

Run: `python src/main.py`，添加一个下载任务，任务开始下载后直接关闭窗口；再次 `python src/main.py`。
Expected: 队列页出现该任务且状态为“已暂停”，点恢复可继续。

- [ ] **Step 7: 提交**

```bash
git add src/core/download_manager.py src/ui/qt_manager_adapter.py tests/core/test_queue_restore.py
git commit -m "feat(core): persist download queue and restore on startup"
```

---

### Task 7: 退出语义修复——停止即暂停，不取消

**Files:**
- Modify: `src/core/download_manager.py:76-93`（`stop` 方法）
- Test: `tests/core/test_queue_restore.py`（追加）

- [ ] **Step 1: 写失败测试**

在 `tests/core/test_queue_restore.py` 末尾追加：

```python
def test_stop_marks_downloading_as_paused_not_cancelled(tmp_path):
    """规格 8.3：退出不取消任何任务，下载中转为已暂停并持久化。"""
    store = QueueStore(str(tmp_path / "q.db"))
    manager = _make_manager(store)
    task = _make_task(status=TaskStatus.DOWNLOADING)
    with manager._lock:
        manager.tasks[task.id] = task
    store.upsert_task(task)

    manager.stop(join_timeout=1)

    assert task.status == TaskStatus.PAUSED
    assert store.load_tasks()[0].status == TaskStatus.PAUSED
```

- [ ] **Step 2: 运行确认失败**

Run: `pytest tests/core/test_queue_restore.py::test_stop_marks_downloading_as_paused_not_cancelled -v`
Expected: FAIL，`assert task.status == TaskStatus.PAUSED`（当前 stop 会置为 CANCELLED）

- [ ] **Step 3: 修改 `stop` 方法**

将现有 `stop` 整体替换为：

```python
    def stop(self, join_timeout: float = 5.0):
        """停止调度器。下载中的任务中断并标记为已暂停（保留半成品，可续传）。"""
        paused_tasks = []
        with self._lock:
            self.running = False
            for task in self.tasks.values():
                if task.status == TaskStatus.DOWNLOADING:
                    task.status = TaskStatus.PAUSED
                    paused_tasks.append(task)
            threads = list(self.active_tasks.values())
            scheduler = self.scheduler_thread

        for task in paused_tasks:
            self._persist(task)

        if scheduler and scheduler.is_alive():
            scheduler.join(timeout=join_timeout)

        for thread in threads:
            if thread.is_alive():
                thread.join(timeout=join_timeout)

        logger.info("调度器已停止")
```

工作线程侧无需改动：progress 回调发现状态为 PAUSED 会抛 `DownloadCancelled`，异常分支对 PAUSED 只记日志退出，半成品文件保留——与手动暂停完全同一条路径。

- [ ] **Step 4: 运行确认通过**

Run: `pytest tests/core/test_queue_restore.py tests/core/test_download_manager.py -v`
Expected: 全部 passed

- [ ] **Step 5: 提交**

```bash
git add src/core/download_manager.py tests/core/test_queue_restore.py
git commit -m "fix(core): stop() pauses in-flight downloads instead of cancelling (spec 8.3)"
```

---

### Task 8: 可取消、带超时的 URL 解析

**Files:**
- Create: `src/core/url_parser.py`
- Test: `tests/core/test_url_parser.py`

设计：以子进程运行 `python -m yt_dlp --dump-single-json`，取消即终止进程——这是“真正中断 yt-dlp 调用”的唯一可靠手段（进程内的 `extract_info` 不可中断）。现有 `VideoInfoExtractor`（进程内、不可取消）保留给下载线程的元数据补齐用，不动它。

- [ ] **Step 1: 写失败测试**

创建 `tests/core/test_url_parser.py`：

```python
"""ParseSession 取消、超时与成功路径测试。"""
import json
import sys
import threading
import time

import pytest

import src.core.url_parser as url_parser
from src.core.download_task import Platform
from src.core.url_parser import (
    ParseCancelled,
    ParseFailed,
    ParseSession,
    ParseTimeout,
    build_parse_command,
)


FAKE_INFO = {
    "title": "测试视频",
    "duration": 61,
    "thumbnail": "https://example.com/t.jpg",
    "uploader": "uploader1",
    "filesize": 12345,
}


def _fake_command(payload):
    """构造一个打印 JSON 后退出的子进程命令。"""
    code = f"import json; print(json.dumps({payload!r}))"
    return [sys.executable, "-c", code]


def test_build_parse_command_includes_proxy():
    cmd = build_parse_command("https://example.com/v", proxy="http://127.0.0.1:7890")
    assert "--proxy" in cmd
    assert "http://127.0.0.1:7890" in cmd
    assert cmd[-1] == "https://example.com/v"


def test_successful_parse(monkeypatch):
    monkeypatch.setattr(
        url_parser, "build_parse_command", lambda url, proxy=None: _fake_command(FAKE_INFO)
    )
    session = ParseSession("https://www.youtube.com/watch?v=x", timeout=10)
    info = session.run()
    assert info.title == "测试视频"
    assert info.duration == 61
    assert info.uploader == "uploader1"
    assert info.platform == Platform.YOUTUBE


def test_timeout_kills_process(monkeypatch):
    monkeypatch.setattr(
        url_parser,
        "build_parse_command",
        lambda url, proxy=None: [sys.executable, "-c", "import time; time.sleep(30)"],
    )
    session = ParseSession("https://example.com/v", timeout=0.5)
    start = time.monotonic()
    with pytest.raises(ParseTimeout):
        session.run()
    assert time.monotonic() - start < 5


def test_cancel_interrupts_running_parse(monkeypatch):
    monkeypatch.setattr(
        url_parser,
        "build_parse_command",
        lambda url, proxy=None: [sys.executable, "-c", "import time; time.sleep(30)"],
    )
    session = ParseSession("https://example.com/v", timeout=60)
    result = {}

    def run():
        try:
            session.run()
        except Exception as exc:
            result["error"] = exc

    thread = threading.Thread(target=run)
    thread.start()
    time.sleep(0.3)
    session.cancel()
    thread.join(timeout=5)

    assert not thread.is_alive()
    assert isinstance(result["error"], ParseCancelled)


def test_cancel_before_run_raises_immediately():
    session = ParseSession("https://example.com/v")
    session.cancel()
    with pytest.raises(ParseCancelled):
        session.run()


def test_nonzero_exit_raises_parse_failed(monkeypatch):
    monkeypatch.setattr(
        url_parser,
        "build_parse_command",
        lambda url, proxy=None: [
            sys.executable,
            "-c",
            "import sys; sys.stderr.write('ERROR: Unsupported URL'); sys.exit(1)",
        ],
    )
    session = ParseSession("https://example.com/v", timeout=10)
    with pytest.raises(ParseFailed) as exc_info:
        session.run()
    assert "Unsupported URL" in str(exc_info.value)
```

- [ ] **Step 2: 运行确认失败**

Run: `pytest tests/core/test_url_parser.py -v`
Expected: FAIL，`ModuleNotFoundError: No module named 'src.core.url_parser'`

- [ ] **Step 3: 实现**

创建 `src/core/url_parser.py`：

```python
"""可取消、带超时的 URL 解析。以子进程方式运行 yt-dlp，可被真正中断。"""
from __future__ import annotations

import json
import subprocess
import sys
import threading
from typing import List, Optional

from src.core.download_task import VideoInfo
from src.core.platform_detector import PlatformDetector
from src.utils.logger import setup_logger

logger = setup_logger("UrlParser")

DEFAULT_PARSE_TIMEOUT = 30.0


class ParseCancelled(Exception):
    """解析被用户取消。"""


class ParseTimeout(Exception):
    """解析超时。"""


class ParseFailed(Exception):
    """解析失败（无效链接、网络错误等）。"""


def build_parse_command(url: str, proxy: Optional[str] = None) -> List[str]:
    cmd = [
        sys.executable,
        "-m",
        "yt_dlp",
        "--dump-single-json",
        "--no-playlist",
        "--no-warnings",
        "--no-color",
    ]
    if proxy:
        cmd += ["--proxy", proxy]
    cmd.append(url)
    return cmd


class ParseSession:
    """单个 URL 的解析会话。cancel() 可从任意线程调用。"""

    def __init__(
        self,
        url: str,
        proxy: Optional[str] = None,
        timeout: float = DEFAULT_PARSE_TIMEOUT,
    ):
        self.url = url
        self.proxy = proxy
        self.timeout = timeout
        self._lock = threading.Lock()
        self._process: Optional[subprocess.Popen] = None
        self._cancelled = False

    def cancel(self) -> None:
        with self._lock:
            self._cancelled = True
            if self._process is not None and self._process.poll() is None:
                self._process.terminate()

    def run(self) -> VideoInfo:
        """阻塞执行解析。由调用方决定放在哪个线程。"""
        with self._lock:
            if self._cancelled:
                raise ParseCancelled(self.url)
            self._process = subprocess.Popen(
                build_parse_command(self.url, self.proxy),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            process = self._process

        try:
            stdout, stderr = process.communicate(timeout=self.timeout)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()
            raise ParseTimeout(f"解析超时（{self.timeout:.0f} 秒）: {self.url}")

        if self._cancelled:
            raise ParseCancelled(self.url)
        if process.returncode != 0:
            message = stderr.strip().splitlines()[-1] if stderr.strip() else "未知错误"
            raise ParseFailed(message)

        try:
            info = json.loads(stdout)
        except json.JSONDecodeError as exc:
            raise ParseFailed(f"解析输出无法读取: {exc}") from exc
        return self._to_video_info(info)

    def _to_video_info(self, info: dict) -> VideoInfo:
        duration = info.get("duration") or 0
        return VideoInfo(
            url=self.url,
            title=info.get("title") or "未命名视频",
            duration=int(duration) if duration else 0,
            thumbnail_url=info.get("thumbnail") or "",
            uploader=info.get("uploader") or "未知",
            platform=PlatformDetector.detect(self.url),
            file_size=info.get("filesize", 0) or info.get("filesize_approx", 0) or 0,
        )
```

- [ ] **Step 4: 运行确认通过**

Run: `pytest tests/core/test_url_parser.py -v`
Expected: 6 passed

- [ ] **Step 5: 真实 yt-dlp 冒烟（可选，网络可用时）**

```bash
python -c "
from src.core.url_parser import ParseSession
info = ParseSession('https://www.youtube.com/watch?v=jNQXAC9IVRw', timeout=60).run()
print(info.title, info.duration)
"
```

Expected: 打印视频标题与时长。失败（网络/风控）不阻塞本任务，单测已覆盖行为。

- [ ] **Step 6: 提交**

```bash
git add src/core/url_parser.py tests/core/test_url_parser.py
git commit -m "feat(core): add cancellable subprocess-based URL parser with timeout"
```

---

### Task 9: 全量回归与收尾

**Files:**
- 可能修改：因全量回归暴露问题的任意文件

- [ ] **Step 1: 全量测试**

Run: `pytest tests -v`
Expected: 全部 passed。若 UI 测试因 `DownloadManager` 单例假设失败，把测试中的 `DownloadManager._instance = None` 清理逻辑删除、构造改为 `DownloadManager(config=MagicMock(), db=MagicMock())` 或 `create_default_manager()`。

- [ ] **Step 2: 手工完整冒烟**

Run: `python src/main.py`
验证清单：
1. 添加下载任务，队列页显示进度；
2. 暂停后恢复，能续传；
3. 下载中直接关窗，重开后任务为“已暂停”且可恢复；
4. 历史页、设置页正常。

- [ ] **Step 3: 核对阶段 0 验收（对照规格 §13 阶段 0）**

- `rg "PyQt6" src/core src/data/queue_store.py src/data/database.py` 输出应为空（下载核心零 Qt 依赖；`src/data/config_manager.py` 的 QSettings 属 PyQt 装配侧，阶段 1 处理）；
- `TaskSnapshot` 存在且不可变；
- 队列持久化与重启恢复有测试覆盖；
- 解析可取消、有超时；
- `stop()` 暂停而非取消。

- [ ] **Step 4: 提交收尾**

```bash
git add -u
git commit -m "test: fix remaining suite fallout from core de-Qt refactor"
```

（若 Step 1 无需改动则跳过本提交。）

---

## 自审记录

- **规格覆盖**：阶段 0 的六项工作——去 Qt（Task 2/3）、不可变快照（Task 4）、队列持久化与恢复（Task 5/6）、解析可取消与超时（Task 8）、线程关闭协议（Task 7）、配置与数据库接口（Task 2 的 `interfaces.py` + 构造注入）——全部有对应任务。
- **占位符扫描**：无 TBD/TODO；所有代码步骤含完整代码。
- **类型一致性**：事件名与 payload 在 Task 2 表格定义，Task 3 适配器与 Task 2 发射点一致；`QueueStore` 方法名（`upsert_task`/`update_progress`/`remove_task`/`load_tasks`）在 Task 5 定义、Task 6/7 使用处一致；`ParseSession.run/cancel` 与测试一致。
- **已知取舍**：`rg "PyQt6" src/data` 会命中 `config_manager.py`（QSettings）——它属于 PyQt 装配侧，Sidecar 的 JSON 配置存储在阶段 1 实现；Task 9 Step 3 的检查范围据此只针对 `src/core` 与 `src/data/queue_store.py`、`src/data/database.py`。
