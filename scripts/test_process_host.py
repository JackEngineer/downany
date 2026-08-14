#!/usr/bin/env python3
"""Small real-process smoke for DownanyProcessHost.

The production acceptance job runs this on the target OS.  The Windows job
passes an inheritable fd-3 handle through its native runner; this standalone
smoke intentionally refuses to fake that handle on Windows.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import socket
import subprocess
import sys
import time
from typing import NoReturn


def fail(message: str) -> "NoReturn":
    raise SystemExit(f"ProcessHost smoke failed: {message}")


def unix_smoke(executable: str) -> None:
    if not os.path.isabs(executable):
        fail("executable must be absolute")
    if not os.access(executable, os.X_OK):
        fail(f"executable is not runnable: {executable}")

    parent, child = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
    saved_fd3 = None
    try:
        try:
            saved_fd3 = os.dup(3)
        except OSError:
            saved_fd3 = None
        os.dup2(child.fileno(), 3)
        code = (
            "import os,sys,time; "
            "sys.stdout.write('before-resume\\n'); sys.stdout.flush(); "
            "time.sleep(0.05); sys.stdout.write('after-resume\\n'); sys.stdout.flush()"
        )
        process = subprocess.Popen(
            [executable, "--instance-id", "process-host-smoke", "--", sys.executable, "-c", code],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            close_fds=True,
            pass_fds=(3,),
            text=True,
        )
    finally:
        if saved_fd3 is None:
            os.close(3)
        else:
            os.dup2(saved_fd3, 3)
            os.close(saved_fd3)
        child.close()

    parent.settimeout(5.0)
    try:
        raw = b""
        while not raw.endswith(b"\n"):
            block = parent.recv(1)
            if not block:
                fail("control channel closed before handshake")
            raw += block
            if len(raw) > 4096:
                fail("handshake too large")
        handshake = json.loads(raw.decode("utf-8"))
        expected = {
            "schemaVersion": 2,
            "instanceId": "process-host-smoke",
            "containment": "darwin_process_group",
        }
        for key, value in expected.items():
            if handshake.get(key) != value:
                fail(f"handshake {key} mismatch: {handshake!r}")
        for key in ("guardianPid", "targetPid", "processGroupId"):
            if not isinstance(handshake.get(key), int) or handshake[key] <= 0:
                fail(f"invalid handshake identity: {key}")
        parent.sendall(b'{"command":"resume"}\n')
    except Exception:
        parent.close()
        raise

    try:
        stdout, stderr = process.communicate(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.communicate()
        parent.close()
        fail("host did not settle after target exit")
    parent.close()
    if process.returncode != 0:
        fail(f"host returned {process.returncode}; stderr={stderr!r}")
    if stdout != "before-resume\nafter-resume\n":
        fail(f"unexpected target stdout: {stdout!r}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--executable", required=True)
    parser.add_argument("--platform", choices=("darwin", "win32"), default=sys.platform)
    args = parser.parse_args()
    if args.platform == "win32" or os.name == "nt":
        # The Windows release runner supplies the fd-3 HANDLE_LIST through its
        # native ProcessHost adapter.  A Python-only fallback would test a
        # different protocol and must not be mistaken for acceptance.
        fail("run the Windows smoke from the native HANDLE_LIST acceptance runner")
    unix_smoke(args.executable)
    print("ProcessHost smoke passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
