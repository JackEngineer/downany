"""关闭 Sidecar 前必须确认正在解析的子进程已退出。"""
import io
import sys
import threading
import time
from unittest.mock import MagicMock

import pytest

from src.core import url_parser
from src.core.url_parser import ParseCancelled
from src.data.json_config import JsonConfig
from src.sidecar import handlers
from src.sidecar.handlers import HandlerContext, HandlerError, dispatch
from src.sidecar.paths import AppPaths
from src.sidecar.protocol import Method
from src.sidecar.server import SidecarServer


def _context(tmp_path):
    paths = AppPaths(data_dir=tmp_path / "data", log_dir=tmp_path / "logs").ensure()
    return HandlerContext(
        JsonConfig(str(paths.config_path)), MagicMock(), MagicMock(),
        lambda _name, _payload: None, paths,
    )


@pytest.fixture
def sleeping_parsers(tmp_path, monkeypatch):
    processes = []
    markers = []
    original_start = url_parser._start_parse_process
    ctx = _context(tmp_path)

    def start(command, **kwargs):
        process = original_start(command, **kwargs)
        processes.append(process)
        return process

    def launch(*, ignore_terminate=False, count=2):
        def command(_url, _proxy=None, **_kwargs):
            marker = tmp_path / f"ready-{len(markers)}"
            markers.append(marker)
            ignore = "signal.signal(signal.SIGTERM, signal.SIG_IGN);" if ignore_terminate else ""
            code = (
                "import pathlib, signal, time;"
                f"{ignore}pathlib.Path({str(marker)!r}).write_text('ready');"
                "time.sleep(20)"
            )
            return [sys.executable, "-c", code]

        monkeypatch.setattr(url_parser, "build_parse_command", command)
        monkeypatch.setattr(url_parser, "_start_parse_process", start)
        ids = [dispatch(ctx, Method.DOWNLOAD_PARSE_URLS.value, {
            "urls": ["https://example.invalid/video"], "timeout": 30,
        })["parseId"] for _ in range(count)]
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if len(processes) == count and all(marker.exists() for marker in markers):
                break
            time.sleep(0.01)
        assert len(processes) == count
        assert all(marker.exists() for marker in markers)
        assert all(process.poll() is None for process in processes)
        return ctx, processes, ids

    yield launch

    for process in processes:
        if process.poll() is None:
            process.kill()
        process.wait(timeout=5)
    deadline = time.monotonic() + 2
    while ctx._parse_jobs and time.monotonic() < deadline:
        time.sleep(0.01)


@pytest.mark.parametrize("operation", ["shutdown", "eof"])
@pytest.mark.parametrize("ignore_terminate", [
    False,
    pytest.param(True, marks=pytest.mark.skipif(sys.platform == "win32", reason="Windows terminate does not deliver SIGTERM")),
])
def test_sidecar_stops_all_real_parse_processes_before_exit(sleeping_parsers, operation, ignore_terminate):
    ctx, processes, _ids = sleeping_parsers(ignore_terminate=ignore_terminate)
    started = time.monotonic()

    if operation == "shutdown":
        assert dispatch(ctx, Method.APP_SHUTDOWN.value, {}) == {"ok": True}
        assert ctx.shutdown_requested is True
    else:
        server = SidecarServer(ctx, ctx.paths)
        assert server.serve_after_handshake(io.StringIO(""), io.StringIO()) == 0

    assert all(process.poll() is not None for process in processes)
    assert not ctx._parse_jobs
    assert time.monotonic() - started < 5


@pytest.mark.parametrize("operation", ["shutdown", "eof"])
def test_unconfirmed_parse_cleanup_is_not_reported_as_success(tmp_path, monkeypatch, operation):
    ctx = _context(tmp_path)
    started = threading.Event()
    release = threading.Event()

    class UnconfirmedSession:
        def run(self):
            started.set()
            release.wait(timeout=5)
            raise ParseCancelled("test")

        def cancel(self):
            pass

        def cancel_and_wait(self, timeout):
            return False

    monkeypatch.setattr(handlers, "_new_parse_session", lambda *_args, **_kwargs: UnconfirmedSession())
    monkeypatch.setattr(handlers, "_PARSE_SHUTDOWN_TIMEOUT", 0.05, raising=False)
    result = dispatch(ctx, Method.DOWNLOAD_PARSE_URLS.value, {"urls": ["https://example.invalid/video"]})
    assert started.wait(timeout=2)
    try:
        if operation == "shutdown":
            with pytest.raises(HandlerError):
                dispatch(ctx, Method.APP_SHUTDOWN.value, {})
            assert ctx.shutdown_requested is False
        else:
            server = SidecarServer(ctx, ctx.paths)
            assert server.serve_after_handshake(io.StringIO(""), io.StringIO()) != 0
        assert result["parseId"] in ctx._parse_jobs
    finally:
        release.set()
        deadline = time.monotonic() + 2
        while ctx._parse_jobs and time.monotonic() < deadline:
            time.sleep(0.01)
