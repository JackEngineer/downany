"""真实子进程验证：引擎工具模式不启动队列或污染 JSONL 协议。"""
import json
import hashlib
import os
import subprocess
import sys
import threading
import zipfile
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from yt_dlp.version import __version__

from src.core.url_parser import ParseSession


def _run_engine(tmp_path, *arguments):
    data = tmp_path / "data"
    data.mkdir(exist_ok=True)
    for marker in (".migration_v1_done", ".migration_videodownloader_done"):
        (data / marker).write_text("isolated-engine-test\n")
    env = {**os.environ, "DOWNANY_DATA_DIR": str(data)}
    return subprocess.run(
        [sys.executable, "-m", "src.sidecar", *arguments],
        cwd=Path(__file__).resolve().parents[2],
        env=env,
        input="",
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=20,
        check=False,
    )


def test_engine_cli_reports_imported_library_without_starting_sidecar(tmp_path):
    result = _run_engine(tmp_path, "--engine-cli", "--engine-id", "bundled", "--", "--version")

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == __version__
    assert not (tmp_path / "data" / "history.db").exists()
    assert not (tmp_path / "data" / "config.json").exists()


def test_engine_probe_reports_actual_version_without_queue_start(tmp_path):
    result = _run_engine(tmp_path, "--engine-probe", "--engine-id", "bundled")

    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {
        "version": __version__, "source": "bundled", "selection": "bundled",
    }
    assert not (tmp_path / "data" / "history.db").exists()


def test_probe_rejects_an_archive_that_cannot_load_downany_consumers(tmp_path):
    archive = tmp_path / "incompatible.zip"
    with zipfile.ZipFile(archive, "w") as output:
        for name, content in {
            "__main__.py": "pass\n", "yt_dlp/__init__.py": "# no YoutubeDL\n",
            "yt_dlp/version.py": "__version__ = '2026.08.19'\n",
            "yt_dlp_ejs/__init__.py": "pass\n",
        }.items():
            output.writestr(name, content)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    dest = tmp_path / "data" / "engines" / digest / "yt-dlp.zip"
    dest.parent.mkdir(parents=True)
    archive.replace(dest)

    result = _run_engine(tmp_path, "--engine-probe", "--engine-id", digest)

    assert result.returncode != 0
    assert result.stdout == ""
    assert str(tmp_path) not in result.stderr
    assert not (tmp_path / "data" / "history.db").exists()


@pytest.mark.parametrize("arguments", [
    ("--engine-cli", "--engine-id", "../private-path", "--", "--version"),
    ("--engine-probe", "--engine-id", "0" * 64),
    ("--engine-cli", "--version"),
    ("--unrecognized-option",),
])
def test_invalid_tool_request_fails_without_protocol_or_private_output(tmp_path, arguments):
    result = _run_engine(tmp_path, *arguments)

    assert result.returncode != 0
    assert result.stdout == ""
    assert "private-path" not in result.stderr
    assert str(tmp_path) not in result.stderr
    assert not (tmp_path / "data" / "history.db").exists()


def test_real_parse_worker_returns_metadata_without_starting_a_queue(tmp_path, monkeypatch):
    # 只验证直接媒体元数据与进程输出，不作为媒体可播放性证据。
    (tmp_path / "movie.mp4").write_bytes(b"controlled metadata fixture")
    handler = partial(SimpleHTTPRequestHandler, directory=str(tmp_path))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    data = tmp_path / "isolated-data"
    monkeypatch.setenv("DOWNANY_DATA_DIR", str(data))
    monkeypatch.setenv("NO_PROXY", "localhost,127.0.0.1")
    monkeypatch.setenv("no_proxy", "localhost,127.0.0.1")
    url = f"http://127.0.0.1:{server.server_port}/movie.mp4"
    try:
        result = ParseSession(url, timeout=20).run()
        assert result.info.url == url
        assert result.info.title == "movie"
        assert not (data / "history.db").exists()
        assert not (data / "config.json").exists()
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
