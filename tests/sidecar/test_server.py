"""SidecarServer 握手与 ping 集成测试。"""
import json
import queue
import threading
from datetime import datetime, timezone

from src.sidecar.paths import AppPaths
from src.sidecar.protocol import APP_NAME, APP_VERSION, PROTOCOL_VERSION
from src.sidecar.server import SidecarServer


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
