"""SidecarServer 握手与 ping 集成测试。"""
import io
import json
import queue
import threading
import time
from datetime import datetime, timezone
from unittest.mock import MagicMock

import pytest

from src.core.download_manager import DownloadManager
from src.core.download_task import DownloadTask, TaskStatus, VideoInfo
from src.data.json_config import JsonConfig
from src.sidecar.handlers import HandlerContext
from src.sidecar.paths import AppPaths
from src.sidecar.protocol import APP_NAME, APP_VERSION, PROTOCOL_VERSION
from src.sidecar.server import SidecarServer
import src.sidecar.server as sidecar_server


class LinePipe:
    """线程安全的按行读写管道，供测试驱动 server。"""

    def __init__(self):
        self._lines: queue.Queue[str] = queue.Queue()
        self._buffer = ""
        self._write_lock = threading.Lock()

    def write(self, data: str) -> int:
        with self._write_lock:
            self._buffer += data
            while "\n" in self._buffer:
                line, self._buffer = self._buffer.split("\n", 1)
                self._lines.put(line + "\n")
        return len(data)

    def flush(self) -> None:
        return None

    def readline(self) -> str:
        return self._lines.get(timeout=5)


def _ts() -> str:
    return datetime.now(timezone.utc).isoformat()


def _hello(app: str = "electron") -> dict:
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "type": "hello",
        "payload": {"app": app, "appVersion": "test"},
        "timestamp": _ts(),
    }


def test_hello_then_ping(tmp_path):
    paths = AppPaths(data_dir=tmp_path / "data", log_dir=tmp_path / "logs").ensure()
    stdin_pipe = LinePipe()
    stdout_pipe = LinePipe()
    server = SidecarServer.from_paths(paths)
    thread = threading.Thread(
        target=server.run,
        args=(stdin_pipe, stdout_pipe),
        daemon=True,
    )
    thread.start()

    sidecar_hello = json.loads(stdout_pipe.readline())
    assert sidecar_hello["type"] == "hello"
    assert sidecar_hello["protocolVersion"] == PROTOCOL_VERSION
    assert sidecar_hello["payload"]["app"] == APP_NAME
    assert sidecar_hello["payload"]["appVersion"] == APP_VERSION

    stdin_pipe.write(json.dumps(_hello()) + "\n")
    stdin_pipe.write(
        json.dumps(
            {
                "protocolVersion": PROTOCOL_VERSION,
                "type": "request",
                "id": "1",
                "method": "app.ping",
                "payload": {},
                "timestamp": _ts(),
            }
        )
        + "\n"
    )

    response = json.loads(stdout_pipe.readline())
    assert response["type"] == "response"
    assert response["correlationId"] == "1"
    assert response["payload"] == {"ok": True}

    stdin_pipe.write(
        json.dumps(
            {
                "protocolVersion": PROTOCOL_VERSION,
                "type": "request",
                "id": "2",
                "method": "app.shutdown",
                "payload": {},
                "timestamp": _ts(),
            }
        )
        + "\n"
    )
    shutdown_resp = json.loads(stdout_pipe.readline())
    assert shutdown_resp["payload"]["ok"] is True
    thread.join(timeout=5)
    assert not thread.is_alive()


def test_protocol_mismatch_exits(tmp_path):
    paths = AppPaths(data_dir=tmp_path / "data2", log_dir=tmp_path / "logs2").ensure()
    stdin_pipe = LinePipe()
    stdout_pipe = LinePipe()
    server = SidecarServer.from_paths(paths)
    thread = threading.Thread(
        target=server.run,
        args=(stdin_pipe, stdout_pipe),
        daemon=True,
    )
    thread.start()
    json.loads(stdout_pipe.readline())  # sidecar hello

    bad = _hello()
    bad["protocolVersion"] = 999
    stdin_pipe.write(json.dumps(bad) + "\n")

    err = json.loads(stdout_pipe.readline())
    assert err["type"] == "response" or err["type"] == "hello"
    # server should exit after mismatch
    thread.join(timeout=5)
    assert not thread.is_alive()


class _ReconfigurableStream:
    def __init__(self):
        self.calls = []

    def reconfigure(self, **kwargs):
        self.calls.append(kwargs)


class _SlowWriteStream:
    def __init__(self):
        self._state_lock = threading.Lock()
        self.active_writes = 0
        self.max_active_writes = 0
        self.chunks = []

    def write(self, data: str) -> int:
        with self._state_lock:
            self.active_writes += 1
            self.max_active_writes = max(self.max_active_writes, self.active_writes)
        try:
            # Force a thread switch while the write is in progress. The
            # server-level lock, rather than the stream implementation, must
            # provide protocol-line serialization.
            time.sleep(0.01)
            self.chunks.append(data)
            return len(data)
        finally:
            with self._state_lock:
                self.active_writes -= 1

    def flush(self) -> None:
        return None


def test_protocol_stdio_is_configured_as_utf8(monkeypatch):
    stdin = _ReconfigurableStream()
    stdout = _ReconfigurableStream()
    stderr = _ReconfigurableStream()
    monkeypatch.setattr(sidecar_server.sys, "stdin", stdin)
    monkeypatch.setattr(sidecar_server.sys, "stdout", stdout)
    monkeypatch.setattr(sidecar_server.sys, "stderr", stderr)

    sidecar_server._configure_stdio()

    assert stdin.calls == [{"encoding": "utf-8", "errors": "strict"}]
    assert stdout.calls == [
        {"encoding": "utf-8", "errors": "strict", "line_buffering": True}
    ]
    assert stderr.calls == [
        {"encoding": "utf-8", "errors": "replace", "line_buffering": True}
    ]


def test_protocol_messages_are_serialized_across_event_threads():
    stream = _SlowWriteStream()
    server = SidecarServer.__new__(SidecarServer)
    server._stdout = stream
    server._stdout_lock = threading.RLock()

    threads = [
        threading.Thread(target=server._write, args=({"type": "event", "id": index},))
        for index in range(2)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=2)

    assert stream.max_active_writes == 1
    assert {json.loads(chunk)["id"] for chunk in stream.chunks} == {0, 1}


def _event_server(tmp_path):
    paths = AppPaths(data_dir=tmp_path / "data", log_dir=tmp_path / "logs").ensure()
    config = JsonConfig(str(paths.config_path))
    manager = DownloadManager(config=config, db=MagicMock())
    task = DownloadTask(id="task", status=TaskStatus.DOWNLOADING,
                        video_info=VideoInfo(url="https://example.com/v", title="video"))
    manager.add_task(task)
    ctx = HandlerContext(config=config, db=MagicMock(), manager=manager,
                         emit_event=lambda *_: None, paths=paths)
    server = SidecarServer(ctx, paths)
    server._stdout = io.StringIO()
    return server, task


@pytest.mark.parametrize("event,status", [
    ("task_paused", TaskStatus.PAUSED), ("task_cancelled", TaskStatus.CANCELLED),
    ("task_completed", TaskStatus.COMPLETED), ("task_failed", TaskStatus.FAILED),
    ("task_updated", TaskStatus.PENDING),
])
def test_leaving_progress_clears_throttle_and_late_progress_is_ignored(tmp_path, event, status):
    server, task = _event_server(tmp_path)
    server._last_progress_emit[task.id] = 0.0
    task.status = status
    server._on_manager_event(event, {"task_id": task.id})
    assert task.id not in server._last_progress_emit
    before = server._stdout.getvalue()
    server._on_manager_event("task_progress", {"task_id": task.id, "progress": {"progress": 99}})
    assert task.id not in server._last_progress_emit
    assert server._stdout.getvalue() == before


def test_removed_event_clears_throttle_and_missing_task_progress_is_ignored(tmp_path):
    server, task = _event_server(tmp_path)
    server._last_progress_emit[task.id] = 0.0
    server.ctx.manager.remove_task(task.id, force=True)
    server._write_event("task.removed", {"taskId": task.id})
    assert task.id not in server._last_progress_emit
    before = server._stdout.getvalue()
    server._on_manager_event("task_progress", {"task_id": task.id, "progress": {"progress": 99}})
    assert server._stdout.getvalue() == before


def test_progress_events_use_a_locked_single_task_snapshot(tmp_path, monkeypatch):
    server, task = _event_server(tmp_path)
    original = server.ctx.manager.get_task_snapshot
    calls = []

    def snapshot(task_id):
        calls.append(task_id)
        return original(task_id)

    monkeypatch.setattr(server.ctx.manager, "get_task_snapshot", snapshot)
    server._on_manager_event("task_progress", {"task_id": task.id, "progress": {"progress": 10}})
    message = json.loads(server._stdout.getvalue())
    assert calls == [task.id]
    assert message["payload"]["task"]["status"] == "downloading"
    assert message["payload"]["task"]["id"] == task.id
