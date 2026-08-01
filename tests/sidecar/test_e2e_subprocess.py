"""子进程真 E2E：hello → ping → settings → snapshot → shutdown。"""
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from src.sidecar.protocol import PROTOCOL_VERSION


def _ts() -> str:
    return datetime.now(timezone.utc).isoformat()


def _read_json_line(proc: subprocess.Popen) -> dict:
    assert proc.stdout is not None
    line = proc.stdout.readline()
    assert line, "stdout 意外结束"
    # 确保是单行 JSON
    assert "\n" not in line.strip() or line.endswith("\n")
    return json.loads(line)


def test_subprocess_hello_ping_snapshot_shutdown(tmp_path):
    env = os.environ.copy()
    env["DOWNANY_DATA_DIR"] = str(tmp_path / "data")
    repo = Path(__file__).resolve().parents[2]
    python = repo / "venv" / "bin" / "python"
    if not python.exists():
        python = Path(sys.executable)

    proc = subprocess.Popen(
        [str(python), "-m", "src.sidecar"],
        cwd=str(repo),
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    assert proc.stdin is not None

    try:
        hello = _read_json_line(proc)
        assert hello["type"] == "hello"
        assert hello["protocolVersion"] == PROTOCOL_VERSION

        proc.stdin.write(
            json.dumps(
                {
                    "protocolVersion": PROTOCOL_VERSION,
                    "type": "hello",
                    "payload": {"app": "electron", "appVersion": "test"},
                    "timestamp": _ts(),
                }
            )
            + "\n"
        )
        proc.stdin.flush()

        def request(req_id: str, method: str, payload: dict) -> dict:
            proc.stdin.write(
                json.dumps(
                    {
                        "protocolVersion": PROTOCOL_VERSION,
                        "type": "request",
                        "id": req_id,
                        "method": method,
                        "payload": payload,
                        "timestamp": _ts(),
                    }
                )
                + "\n"
            )
            proc.stdin.flush()
            return _read_json_line(proc)

        ping = request("1", "app.ping", {})
        assert ping["correlationId"] == "1"
        assert ping["payload"]["ok"] is True

        updated = request(
            "2",
            "settings.update",
            {"concurrent_downloads": 2, "theme_mode": "light"},
        )
        # settings.update 可能先发 event 再发 response——按协议 response 与 event 交错
        while updated.get("type") == "event":
            updated = _read_json_line(proc)
        assert updated["payload"]["concurrent_downloads"] == 2

        snap = request("3", "app.getSnapshot", {})
        while snap.get("type") == "event":
            snap = _read_json_line(proc)
        assert "tasks" in snap["payload"]
        assert snap["payload"]["settings"]["theme_mode"] == "light"

        bye = request("4", "app.shutdown", {})
        while bye.get("type") == "event":
            bye = _read_json_line(proc)
        assert bye["payload"]["ok"] is True

        code = proc.wait(timeout=10)
        assert code == 0

        # 确认 stdout 已无残留非空行
        leftover = proc.stdout.read()
        assert leftover.strip() == ""
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=5)
