# Downany v0.2.4 最终大小持久化回归 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为已修复的最终成品大小补充真实 SQLite 重建回归，保护后续 v0.2.5/v0.3 的历史与队列恢复。

**Architecture:** 同步执行真实 DownloadManager 完成流程，保留真实成品提交、HistoryDB 和 QueueStore，只替换网络下载、媒体工具探测与外部脚本边界。完成后重建历史对象、队列对象和 DownloadManager，断言持久化大小及 Renderer 快照与手工确定的文件字节数一致。

**Tech Stack:** Python、pytest、SQLite、现有 DownloadManager / HistoryDB / QueueStore。

**Spec:** `docs/superpowers/specs/2026-08-26-downany-v0-2-4-output-correctness-design.md`，尤其第 4、5.6、9.2、11 节；补充依据是 2026-08-27 候选独立审查对真实存储大小回归的非阻断建议。

## Global Constraints

- 已经完成的历史文件不改名、不移动、不删除。
- 自动化通过不能代替这组可见验收。
- 本规格批准不代表允许合并、推送、打标签、清理其他分支或公开发布。
- 本补强只增加测试和证据，不修改生产源码、应用版本、安装包或真实用户配置；不创建本地提交。
- 所有测试数据使用 pytest `tmp_path`；验证辅助文件只写入当前工作树被忽略的 `.build` 或本计划专属 SDD 目录。
- 不联网、不运行桌面应用、不发送 Telegram、不操作用户下载目录；不得删除原有未提交工作。

## 文件职责

- `tests/core/test_completed_output_size_persistence.py`：两个参数化场景及最小的边界替身。
- `.build/v024-size-persistence/baseline_runner.py`：仅在独立 Python 进程内载入修复前模块，不改变工作树，用于验证新测试能捕获旧问题。
- `docs/acceptance/v0.2.4-output-correctness.md`：控制器在真实测试结束后记录结果；实施者不编辑该文件。

### Task 1: Verify finalized sizes after reopening real stores

**Files:**
- Create: `tests/core/test_completed_output_size_persistence.py`
- Create, ignored: `.build/v024-size-persistence/baseline_runner.py`
- Test: `tests/core/test_completed_output_size_persistence.py`

**Interfaces:**
- Consumes: `DownloadManager(config, db, queue_store, temp_dir)`, `add_task(task)`, `_download_task(task)`, `restore_tasks()`, `get_task(task_id)`, `get_snapshot()`。
- Consumes: `HistoryDB(db_path=...)`, `get_download_record(task_id)`；HistoryDB 是单例，重建时使用 pytest monkeypatch 隔离并恢复 `_instance`。
- Consumes: `QueueStore(db_path)`，所有对象使用同一真实 SQLite 文件。
- Produces: 两个不用真实网络/媒体程序/桌面应用的回归场景，以及修复前失败、当前源码通过的证据。

- [x] **Step 1: Add the regression test**

以下完整起点允许为现有接口作必要的小调整；不得把真实持久化或成品提交替换为 mock。此测试要捕获的具体回归是：最终大小回写被移除、放到持久化之后，或脚本后没有再次回写。

```python
"""Final output sizes survive reopening the real history and queue stores."""
from pathlib import Path
from types import MappingProxyType, SimpleNamespace

import pytest

from src.core import download_manager as manager_module
from src.core.download_manager import DownloadManager
from src.core.download_task import DownloadOptions, DownloadTask, TaskStatus, VideoInfo
from src.core.downloader import DownloadResult, SourceFacts
from src.core.media_verifier import MediaVerification
from src.data.database import HistoryDB
from src.data.queue_store import QueueStore
from src.sidecar.bin_paths import MediaToolchain


class _Config:
    def get_concurrent_downloads(self):
        return 1

    def get_proxy_for_download(self):
        return None


@pytest.mark.parametrize(
    ("mode", "expected_size"),
    [("audio", 22), ("script", 19)],
    ids=["converted_audio", "script_changes_size"],
)
def test_final_output_size_survives_database_reopen(tmp_path, monkeypatch, mode, expected_size):
    monkeypatch.setenv("DOWNANY_DATA_DIR", str(tmp_path / "app-data"))
    monkeypatch.setattr(HistoryDB, "_instance", None)
    database_path = str(tmp_path / "history.db")
    history = HistoryDB(db_path=database_path)
    suffix = ".mp3" if mode == "audio" else ".mp4"
    task = DownloadTask(
        id="size-persistence",
        video_info=VideoInfo(
            url=f"https://example.invalid/fixture{suffix}",
            title="大小持久化验收",
            file_size=7,
        ),
        options=DownloadOptions(
            output_path=str(tmp_path / "downloads"),
            embed_metadata=False,
            audio_only=mode == "audio",
            postprocessing="script" if mode == "script" else "none",
            postprocess_script="test-output {file}" if mode == "script" else "",
        ),
        downloaded_bytes=5,
        total_bytes=9,
    )

    class FixtureDownloader:
        last_info = None

        def set_callbacks(self, **_kwargs):
            pass

        def download(self, _url, _plan, *, toolchain, staging_dir):
            staging = Path(staging_dir)
            staging.mkdir(parents=True, exist_ok=True)
            media = staging / f"fixture{suffix}"
            media.write_bytes(b"before" if mode == "script" else b"final-output-is-larger")
            return DownloadResult(
                main_file=media,
                subtitles=(),
                info=MappingProxyType({"title": "大小持久化验收", "filepath": str(media)}),
                rendered_leaf=f"fixture{suffix}",
                source_key="size-fixture",
                downloaded_this_run=True,
                source_facts=SourceFacts((), False, False, False, True),
            )

    toolchain = MediaToolchain(
        ffmpeg=tmp_path / "ffmpeg",
        ffprobe=tmp_path / "ffprobe",
        ffmpeg_location=tmp_path,
        source="test",
    )
    monkeypatch.setattr(manager_module, "Downloader", FixtureDownloader)
    monkeypatch.setattr(manager_module, "resolve_media_toolchain", lambda **_kwargs: toolchain)
    monkeypatch.setattr(manager_module, "ensure_local_thumbnail", lambda *_args, **_kwargs: "")
    monkeypatch.setattr(
        manager_module.VideoInfoExtractor, "extract", lambda *_args, **_kwargs: None
    )
    monkeypatch.setattr(
        manager_module,
        "verify_media",
        lambda *_args, **_kwargs: MediaVerification(
            "mp3" if mode == "audio" else "mp4",
            ("audio",) if mode == "audio" else ("video",),
            (), False, False, 0,
        ),
    )

    def run_script(command, **_kwargs):
        assert mode == "script" and isinstance(command, str)
        assert command.startswith("test-output ")
        Path(task.file_path).write_bytes(b"after-script-output")
        return SimpleNamespace(returncode=0, stderr="")

    # Both cases reject every external command except the explicit script stub.
    monkeypatch.setattr(manager_module.subprocess, "run", run_script)

    manager = DownloadManager(
        config=_Config(), db=history,
        queue_store=QueueStore(database_path),
        temp_dir=str(tmp_path / "staging"),
    )
    manager.add_task(task)
    manager._download_task(task)
    assert task.status is TaskStatus.COMPLETED, task.error_message
    assert Path(task.file_path).stat().st_size == expected_size

    monkeypatch.setattr(HistoryDB, "_instance", None)
    reopened_history = HistoryDB(db_path=database_path)
    assert reopened_history is not history
    reopened_manager = DownloadManager(
        config=_Config(), db=reopened_history,
        queue_store=QueueStore(database_path),
        temp_dir=str(tmp_path / "staging"),
    )
    reopened_manager.restore_tasks()
    record = reopened_history.get_download_record(task.id)
    assert record is not None
    assert record.status == "completed"
    assert record.file_size == expected_size
    assert record.file_path == task.file_path
    restored = reopened_manager.get_task(task.id)
    assert restored is not None and restored is not task
    assert restored.status is TaskStatus.COMPLETED
    assert restored.file_path == task.file_path
    assert restored.downloaded_bytes == expected_size
    assert restored.total_bytes == expected_size
    assert restored.video_info.file_size == expected_size
    snapshot = reopened_manager.get_snapshot()[0]
    assert snapshot.status == "completed"
    assert snapshot.downloaded_bytes == expected_size
    assert snapshot.total_bytes == expected_size
    assert snapshot.file_path == task.file_path
```

- [x] **Step 2: Prove RED against the pre-fix module without editing production files**

Create the following ignored runner with `apply_patch`. Run from the candidate worktree. It loads only the baseline download-manager module into the isolated test process; current storage implementations and new tests remain real.

```python
import subprocess
import sys
import types
from pathlib import Path

import pytest

root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root))
import src.core

source = subprocess.check_output(
    ["git", "show", "c7709bcc64035c18cf94efcfc62b40ad088b8f24:src/core/download_manager.py"],
    cwd=root, text=True, encoding="utf-8", timeout=15,
)
module = types.ModuleType("src.core.download_manager")
module.__file__ = str(root / "src/core/download_manager.py")
module.__package__ = "src.core"
sys.modules[module.__name__] = module
src.core.download_manager = module
exec(compile(source, module.__file__, "exec"), module.__dict__)
raise SystemExit(pytest.main([
    str(root / "tests/core/test_completed_output_size_persistence.py"),
    "-q", "-p", "no:cacheprovider",
]))
```

Run: `& 'D:\work\downany\venv\Scripts\python.exe' -X utf8 .build/v024-size-persistence/baseline_runner.py`

Expected: exactly two assertion failures reporting persisted sizes different from 22 and 19; import, fixture or launch errors are not acceptable RED evidence. Keep evidence and the runner; do not edit or restore production files.

- [x] **Step 3: Verify GREEN on current source**

Run: `& 'D:\work\downany\venv\Scripts\python.exe' -X utf8 -m pytest tests/core/test_completed_output_size_persistence.py -q`

Expected: 2 passed. No production change is expected because this is coverage for an existing fix. If a genuine current-source defect appears, report the exact failure instead of changing product behavior within this task.

Isolation fix verification: before adding the `ensure_local_thumbnail` stub, install the strict subprocess guard and the temporary `DOWNANY_DATA_DIR` override, then run the two tests. Both must fail through the rejected thumbnail subprocess without running a real media executable or touching the real profile. Add the thumbnail stub and re-run the old-module RED plus current-source GREEN. This proves the test's external-process guard and removes the initially observed thumbnail warnings.

- [x] **Step 4: Run the affected regression scope once and report**

Run: `& 'D:\work\downany\venv\Scripts\python.exe' -X utf8 -m pytest tests/core/test_completed_output_size_persistence.py tests/core/test_download_manager.py tests/core/test_download_manager_output_contract.py tests/data/test_database.py tests/data/test_queue_store.py -q`

Expected: all pass. The pre-change baseline was 81 passed in 31.31s; record actual new counts and duration, not an assumed result.

Write the task report with commands, actual RED/GREEN results, scope and self-review. No commit is authorized. Controller will independently review the test diff, run the full Python gate once, and update the acceptance record without claiming Windows restart or macOS acceptance.

## 执行结果（2026-08-27）

Task 1 已完成，独立复审确认测试隔离问题已解决，没有新增 Critical / Important 问题。最终测试在旧模块上因历史大小 7 不等于 22/19 而失败（2 failed in 0.57s），当前源码通过（2 passed in 0.93s），受影响范围 83 passed in 24.29s。控制器另以隔离数据目录执行完整 Python 回归，394 passed in 49.42s，退出码 0。

未修改生产源码或安装包，未创建提交。完整证据见 `docs/acceptance/v0.2.4-output-correctness.md`；本补验完成不代表 v0.2.4 Task 14 或 v0.3 执行索引的 Step 1 完成。
