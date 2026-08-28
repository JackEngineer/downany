"""Windows package gate: real old/new Sidecars, SQLite, HTTP media and restart.

No source modules or downloader substitutes are imported. All state, downloads
and logs live in a newly owned temporary directory, retained for inspection.
This is not an installer, real-website or physical-OS-reboot acceptance test.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import queue
import re
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
from collections import Counter
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ACTIVE = {"pending", "downloading", "paused"}
OFFSET = "9007199254740993"


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def wait_until(read, predicate, description: str, timeout: float = 30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = read()
        if predicate(value):
            return value
        time.sleep(0.05)
    raise AssertionError(f"Timed out: {description}; last={value!r}")


class Sidecar:
    def __init__(self, executable: Path, version: str, data: Path, logs: Path):
        self.version = version
        self.counter = 0
        self.messages: queue.Queue = queue.Queue()
        self.errors = (logs / f"sidecar-{version}-{time.time_ns()}.log").open("wb")
        env = dict(os.environ)
        for name in ("DOWNANY_BIN_DIR", "VIDEODL_BIN_DIR", "VIDEODL_DATA_DIR"):
            env.pop(name, None)
        env.update({
            "DOWNANY_DATA_DIR": str(data), "DOWNANY_UPDATE_DISABLED": "1",
            "HTTP_PROXY": "", "HTTPS_PROXY": "", "ALL_PROXY": "",
            "NO_PROXY": "127.0.0.1,localhost", "PYTHONUNBUFFERED": "1",
        })
        try:
            self.process = subprocess.Popen(
                [str(executable)], cwd=executable.parent, env=env,
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.errors,
                text=True, encoding="utf-8", creationflags=subprocess.CREATE_NO_WINDOW,
            )
        except BaseException:
            self.errors.close()
            raise
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    def _read(self):
        try:
            for line in self.process.stdout:
                message = json.loads(line)
                # Events are intentionally not buffered: use authoritative RPC
                # snapshots and leave this harness's memory bounded by requests.
                if message.get("type") != "event":
                    self.messages.put(message)
        except BaseException as error:
            self.messages.put({"readError": type(error).__name__})
        finally:
            self.messages.put(None)

    def _receive(self, timeout: float = 30):
        try:
            message = self.messages.get(timeout=timeout)
        except queue.Empty as error:
            raise AssertionError("Packaged Sidecar response timeout") from error
        if message is None or "readError" in message:
            raise AssertionError(f"Packaged Sidecar protocol closed: {message!r}")
        return message

    def _send(self, message):
        self.process.stdin.write(json.dumps({
            "protocolVersion": 1, "timestamp": "2026-08-27T00:00:00Z", **message,
        }) + "\n")
        self.process.stdin.flush()

    def __enter__(self):
        try:
            hello = self._receive()
            assert hello.get("type") == "hello", hello
            assert hello.get("payload", {}).get("appVersion") == self.version, hello
            self._send({"type": "hello", "payload": {"app": "package-queue-gate", "appVersion": self.version}})
            assert self.request("app.ping")["ok"] is True
            return self
        except BaseException:
            self.crash()
            self._close_handles()
            raise

    def request(self, method: str, payload=None):
        self.counter += 1
        request_id = f"gate-{self.counter}"
        self._send({"type": "request", "id": request_id, "method": method, "payload": payload or {}})
        response = self._receive()
        assert response.get("correlationId") == request_id, response
        assert not response.get("error"), (method, response.get("error"))
        return response.get("payload", {})

    def tasks(self):
        tasks = self.request("app.getSnapshot")["tasks"]
        assert len({task["id"] for task in tasks}) == len(tasks)
        return {task["id"]: task for task in tasks}

    def wait_task(self, task_id: str, status: str, *, progress: bool = False):
        return wait_until(
            lambda: self.tasks()[task_id],
            lambda task: task["status"] == status and (not progress or task["downloaded_bytes"] > 0),
            f"task {task_id} becomes {status}",
        )

    def shutdown(self):
        if self.process.poll() is None:
            assert self.request("app.shutdown")["ok"] is True
            assert self.process.wait(timeout=30) == 0

    def crash(self):
        if self.process.poll() is None:
            # Only the still-owned child PID and its descendants are targeted.
            result = subprocess.run(
                ["taskkill", "/PID", str(self.process.pid), "/T", "/F"],
                capture_output=True, timeout=15, creationflags=subprocess.CREATE_NO_WINDOW,
            )
            if result.returncode and self.process.poll() is None:
                raise AssertionError("Could not terminate the owned Sidecar process tree")
            self.process.wait(timeout=15)

    def _close_handles(self):
        self.reader.join(timeout=5)
        self.process.stdin.close()
        self.process.stdout.close()
        self.errors.close()

    def __exit__(self, exc_type, exc_value, traceback):
        try:
            if exc_type is None:
                self.shutdown()
            else:
                self.crash()
        finally:
            if self.process.poll() is None:
                self.crash()
            self._close_handles()


class MediaServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, media: bytes):
        self.media = media
        self.release = threading.Event()
        self.release.set()
        self.lock = threading.Lock()
        self.open_streams = 0
        self.requests = Counter()
        super().__init__(("127.0.0.1", 0), MediaHandler)

    def stream_count(self):
        with self.lock:
            return self.open_streams


class MediaHandler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_HEAD(self):
        self._serve(head=True)

    def do_GET(self):
        self._serve(head=False)

    def _serve(self, *, head: bool):
        server = self.server
        if self.path == "/missing.mp4":
            self.send_error(404)
            return
        if not re.fullmatch(r"/[a-z0-9-]+\.mp4", self.path):
            self.send_error(404)
            return
        start, end = 0, len(server.media) - 1
        requested = self.headers.get("Range")
        if requested:
            match = re.fullmatch(r"bytes=(\d+)-(\d*)", requested)
            if not match:
                self.send_error(416)
                return
            start = int(match[1])
            end = min(end, int(match[2])) if match[2] else end
            if start > end:
                self.send_error(416)
                return
        self.send_response(206 if requested else 200)
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        if requested:
            self.send_header("Content-Range", f"bytes {start}-{end}/{len(server.media)}")
        self.end_headers()
        if head:
            return
        with server.lock:
            server.open_streams += 1
            server.requests[self.path] += 1
        try:
            for position in range(start, end + 1, 4096):
                # Enough progress for a real yt-dlp callback, then a controlled
                # network stall. Releasing it lets pause callbacks drain too.
                if position - start >= 65536:
                    server.release.wait()
                self.wfile.write(server.media[position:min(position + 4096, end + 1)])
                self.wfile.flush()
                if not server.release.is_set():
                    time.sleep(0.01)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        finally:
            with server.lock:
                server.open_streams -= 1


def create(client: Sidecar, base_url: str, slug: str, *, group="", index=0):
    url = f"{base_url}/{slug}.mp4"
    result = client.request("download.createTasks", {
        "urls": [url], "expand_playlists": False,
        "items": [{"url": url, "title": slug, "group_id": group,
                   "group_title": group, "playlist_index": index}],
    })
    assert len(result["taskIds"]) == 1
    return result["taskIds"][0]


@contextmanager
def database(data: Path):
    connection = sqlite3.connect((data / "history.db").as_uri() + "?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        yield connection
    finally:
        connection.close()


def active_order(tasks):
    return [task["id"] for task in tasks.values() if task["status"] in ACTIVE]


def run_gate(executable: Path, previous: Path, rounds: int, root: Path, *,
             expected_version: str = "0.2.5", previous_version: str = "0.2.4"):
    data, output, logs = (root / name for name in ("data", "output", "logs"))
    for directory in (data, output, logs):
        directory.mkdir()
    resources = next(parent for parent in executable.parents if parent.name.lower() == "resources")
    ffmpeg = resources / "bin" / "ffmpeg.exe"
    ffprobe = resources / "bin" / "ffprobe.exe"
    media = root / "fixture.mp4"
    subprocess.run([
        str(ffmpeg), "-hide_banner", "-loglevel", "error", "-nostdin",
        "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
        "-t", "30", "-c:v", "mpeg4", "-q:v", "3", "-c:a", "aac",
        "-threads", "1", "-movflags", "+faststart", str(media),
    ], check=True, timeout=60, creationflags=subprocess.CREATE_NO_WINDOW)
    assert media.stat().st_size > 65536 * (rounds + 3), "Fixture is too small for restart rounds"
    settings = {
        "download_dir": str(output), "concurrent_downloads": 1,
        "concurrent_fragments": 4, "proxy_enabled": True, "proxy_url": "",
        "theme_mode": "light", "embed_metadata": False,
        "telegram_auto_send_enabled": False, "clipboard_monitor": False,
    }
    (data / "config.json").write_text(json.dumps(settings), encoding="utf-8")
    server = MediaServer(media.read_bytes())
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base_url = f"http://127.0.0.1:{server.server_port}"
    evidence = []
    try:
        with Sidecar(previous, previous_version, data, logs) as old:
            old.request("telegram.configure", {"discoveredTargets": [], "nextUpdateOffset": OFFSET})
            completed = create(old, base_url, "already-completed")
            completed_task = old.wait_task(completed, "completed")
            completed_path = Path(completed_task["file_path"])
            completed_hash = digest(completed_path)
            failed = create(old, base_url, "missing")
            old.wait_task(failed, "failed")
            server.release.clear()
            paused = create(old, base_url, "explicitly-paused")
            old.wait_task(paused, "downloading", progress=True)
            old.request("download.pause", {"taskId": paused})
            old.wait_task(paused, "paused")
            server.release.set()
            wait_until(server.stream_count, lambda count: count == 0, "paused HTTP stream exits")
            server.release.clear()
            running = create(old, base_url, "interrupted-running")
            old.wait_task(running, "downloading", progress=True)
            group_a = [create(old, base_url, f"group-a-{index}", group="group-a", index=index) for index in (1, 2)]
            group_b = [create(old, base_url, f"group-b-{index}", group="group-b", index=index) for index in (1, 2)]
            waiting = create(old, base_url, "waiting-to-pause")
            cancelled = create(old, base_url, "cancelled")
            old.request("download.cancel", {"taskId": cancelled})
            ids = set(old.tasks())
            assert len(ids) == 10
            old.crash()
        with database(data) as connection:
            columns = {row["name"] for row in connection.execute("PRAGMA table_info(task_queue)")}
            has_intent = tuple(map(int, previous_version.split("."))) >= (0, 2, 5)
            assert ("run_intent" in columns) == has_intent, "Previous package produced an unexpected queue schema"
        expected_order = None
        for round_index in range(rounds):
            with Sidecar(executable, expected_version, data, logs) as current:
                current.wait_task(running, "downloading", progress=True)
                if round_index == 0:
                    current.request("download.pause", {"taskId": waiting})
                    report = current.request("download.applyGroupAction", {"groupId": "group-a", "action": "pause"})
                    assert len(report["applied"]) == 2 and not report["deferred"] and not report["skipped"]
                    repeated = current.request("download.applyGroupAction", {"groupId": "group-a", "action": "pause"})
                    assert len(repeated["skipped"]) == 2 and not repeated["applied"]
                    resumed = current.request("download.applyGroupAction", {"groupId": "group-a", "action": "resume"})
                    assert len(resumed["applied"]) == 2
                    expected_order = [paused, waiting, running, *group_b, *group_a]
                    current.request("download.reorder", {"orderedIds": expected_order})
                tasks = current.tasks()
                assert set(tasks) == ids and active_order(tasks) == expected_order
                assert tasks[paused]["status"] == tasks[waiting]["status"] == "paused"
                assert tasks[failed]["status"] == "failed" and tasks[cancelled]["status"] == "cancelled"
                assert tasks[completed]["status"] == "completed" and tasks[completed]["progress"] == 100
                assert digest(completed_path) == completed_hash
                restored_settings = current.request("settings.get")
                assert all(restored_settings[key] == value for key, value in settings.items())
                assert current.request("telegram.getConfig")["nextUpdateOffset"] == OFFSET
                for group, members in (("group-a", group_a), ("group-b", group_b)):
                    assert [(tasks[task_id]["group_id"], tasks[task_id]["playlist_index"]) for task_id in members] == [(group, 1), (group, 2)]
                kind = "crash" if round_index % 2 == 0 else "graceful"
                current.crash() if kind == "crash" else current.shutdown()
            with database(data) as connection:
                rows = {row["id"]: dict(row) for row in connection.execute("SELECT * FROM task_queue")}
                assert rows[running]["run_intent"] == "run"
                assert rows[running]["status"] == ("downloading" if kind == "crash" else "paused")
                # The verified v0.2.4 row may retain its compatibility default:
                # a blank intent on a legacy paused row means explicit pause.
                # A new v0.2.5 action, however, must persist its intent exactly.
                assert rows[paused]["status"] == "paused" and rows[paused]["run_intent"] in ("", "pause")
                assert rows[waiting]["status"] == "paused" and rows[waiting]["run_intent"] == "pause"
                assert set(rows) == ids
            evidence.append({"round": round_index + 1, "shutdown": kind, "tasks": len(ids), "orderRetained": True})
            print(json.dumps(evidence[-1]), flush=True)
        with Sidecar(executable, expected_version, data, logs) as current:
            server.release.set()
            finish_ids = {completed, running, *group_a, *group_b}
            tasks = wait_until(
                current.tasks,
                lambda items: all(items[task_id]["status"] == "completed" for task_id in finish_ids),
                "resumed real media downloads complete", timeout=120,
            )
            assert set(tasks) == ids and tasks[paused]["status"] == tasks[waiting]["status"] == "paused"
            assert tasks[failed]["status"] == "failed" and tasks[cancelled]["status"] == "cancelled"
            outputs = []
            for task_id in sorted(finish_ids):
                task = tasks[task_id]
                file = Path(task["file_path"]).resolve(strict=True)
                assert file.is_relative_to(output.resolve()) and task["progress"] == 100
                assert task["downloaded_bytes"] == task["total_bytes"] == file.stat().st_size
                outputs.append({"taskId": task_id, "path": str(file.relative_to(output)), "bytes": file.stat().st_size, "sha256": digest(file)})
            assert len({item["path"] for item in outputs}) == len(finish_ids) == 6
            assert len(list(output.rglob("*.mp4"))) == 6
            assert not list(output.rglob("*.part")) and digest(completed_path) == completed_hash
            probe = subprocess.run([
                str(ffprobe), "-v", "error", "-show_streams", "-of", "json", str(completed_path),
            ], capture_output=True, text=True, encoding="utf-8", check=True, timeout=30,
                creationflags=subprocess.CREATE_NO_WINDOW)
            assert {stream["codec_type"] for stream in json.loads(probe.stdout)["streams"]} >= {"video", "audio"}
        with database(data) as connection:
            history = {row["id"]: dict(row) for row in connection.execute("SELECT id,status,file_path,file_size FROM download_history")}
            for item in outputs:
                row = history[item["taskId"]]
                assert row["status"] == "completed" and row["file_size"] == item["bytes"]
        report = {
            "result": "passed", "previousVersion": previous_version, "version": expected_version,
            "previousSidecarSHA256": digest(previous), "sidecarSHA256": digest(executable),
            "dataRoot": str(root), "rounds": evidence, "queueTasks": 10,
            "completed": outputs, "paused": 2, "failed": 1, "cancelled": 1,
            "httpRequests": dict(server.requests), "userDataTouched": False,
            "manualInstallationOrOSReboot": False,
        }
        (root / "result.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return report
    finally:
        server.release.set()
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--executable", type=Path, required=True)
    parser.add_argument("--previous-executable", type=Path, required=True)
    parser.add_argument("--rounds", type=int, default=5)
    parser.add_argument("--expected-version", default="0.2.5")
    parser.add_argument("--previous-version", default="0.2.4")
    args = parser.parse_args(argv)
    if any(not re.fullmatch(r"\d+\.\d+\.\d+", value) for value in (args.expected_version, args.previous_version)):
        parser.error("Package versions must use major.minor.patch")
    if sys.platform != "win32":
        parser.error("This gate targets Windows packages only")
    for executable in (args.executable, args.previous_executable):
        if not executable.is_absolute() or not executable.is_file():
            parser.error("Both executable arguments must name existing absolute files")
    if not 1 <= args.rounds <= 20:
        parser.error("rounds must be between 1 and 20")
    root = Path(tempfile.mkdtemp(prefix="downany-packaged-queue-"))
    print(f"Owned isolated evidence directory: {root}", flush=True)
    report = run_gate(args.executable.resolve(), args.previous_executable.resolve(), args.rounds, root,
                      expected_version=args.expected_version, previous_version=args.previous_version)
    print(f"Packaged queue upgrade/recovery gate passed: {len(report['rounds'])} rounds, 10 tasks, 6 verified outputs", flush=True)
    print(f"Evidence: {root / 'result.json'}", flush=True)


if __name__ == "__main__":
    main()
