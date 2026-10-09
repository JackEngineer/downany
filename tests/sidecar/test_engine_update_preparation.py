"""只验证离线候选准备协议；合成归档不代表官方引擎发布验收。"""
import hashlib
import io
import json
import subprocess
import sys
import threading
import time
from types import SimpleNamespace
import urllib.request
import zipfile

import pytest

from src.sidecar import ytdlp_updater as updater
from src.sidecar.paths import AppPaths


VERSION = "2026.09.27"
BASE = f"https://github.com/yt-dlp/yt-dlp/releases/download/{VERSION}/"
SECRET = "private-path-cookie-and-url"
PREPARE_ERROR = "下载工具准备失败，请稍后重试。"
CHECK_ERROR = "暂时无法检查下载工具更新，请稍后重试。"


class Response(io.BytesIO):
    def __init__(self, content, url):
        super().__init__(content)
        self.url = url

    def geturl(self):
        return self.url


def archive_bytes(version=VERSION):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("__main__.py", "pass\n")
        archive.writestr("yt_dlp/__init__.py", "SYNTHETIC = True\n")
        archive.writestr("yt_dlp/version.py", f"__version__ = {version!r}\n")
        archive.writestr("yt_dlp_ejs/__init__.py", "version = 'synthetic'\n")
    return output.getvalue()


def release_payload():
    return {
        "tag_name": VERSION,
        "draft": False,
        "prerelease": False,
        "assets": [{"name": name, "browser_download_url": BASE + name}
                   for name in ("yt-dlp", "SHA2-256SUMS")],
    }


@pytest.fixture
def package(tmp_path, monkeypatch):
    paths = AppPaths(tmp_path / "data", tmp_path / "logs")
    payload = archive_bytes()
    digest = hashlib.sha256(payload).hexdigest()
    resources = {
        updater.RELEASE_API: json.dumps(release_payload()).encode(),
        BASE + "SHA2-256SUMS": f"{digest}  yt-dlp\n{'0' * 64}  yt-dlp.exe\n".encode(),
        BASE + "yt-dlp": payload,
    }
    requests = []
    probes = []

    def opener(request, timeout):
        requests.append((request.full_url, timeout))
        return Response(resources[request.full_url], request.full_url)

    def probe(command, **kwargs):
        probes.append((command, kwargs))
        return SimpleNamespace(returncode=0, stderr="", stdout=json.dumps({
            "version": VERSION, "source": "updated", "selection": digest,
        }))

    monkeypatch.setattr(updater, "current_engine", lambda: {
        "version": "2026.08.19", "source": "bundled", "selection": "bundled",
    })
    monkeypatch.setattr(updater.subprocess, "run", probe)
    return SimpleNamespace(paths=paths, payload=payload, digest=digest,
                           resources=resources, requests=requests, probes=probes, opener=opener)


def seed_pending(package, *, data=None, manifest=None):
    directory = package.paths.data_dir / "engines" / package.digest
    directory.mkdir(parents=True)
    (directory / "yt-dlp.zip").write_bytes(package.payload if data is None else data)
    pointer = manifest or {"schemaVersion": 1, "sha256": package.digest, "version": VERSION}
    (directory.parent / "pending.json").write_text(json.dumps(pointer), encoding="utf-8")
    return directory / "yt-dlp.zip"


def wait_job(service):
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        snapshot = service.snapshot()
        if snapshot["operation"]["state"] != "running":
            return snapshot
        time.sleep(0.005)
    pytest.fail("background job did not finish")


def test_check_uses_same_tag_universal_archive_and_does_not_return_download_url(package):
    assert updater.check_update(package.paths, opener=package.opener) == {
        "currentVersion": "2026.08.19", "latestVersion": VERSION, "updateAvailable": True,
    }
    assert package.requests == [(updater.RELEASE_API, 30)]
    assert package.probes == []
    assert not package.paths.data_dir.exists()


@pytest.mark.parametrize("change", ["missing-sums", "other-host", "other-tag", "duplicate", "draft", "bad-version"])
def test_invalid_release_metadata_fails_closed_without_following_asset_url(package, change):
    release = release_payload()
    if change == "missing-sums":
        release["assets"].pop()
    elif change == "other-host":
        release["assets"][0]["browser_download_url"] = "https://example.invalid/private"
    elif change == "other-tag":
        release["assets"][0]["browser_download_url"] = BASE.replace(VERSION, "2025.01.01") + "yt-dlp"
    elif change == "duplicate":
        release["assets"].append(release["assets"][0])
    elif change == "draft":
        release["draft"] = True
    else:
        release["tag_name"] = SECRET
    package.resources[updater.RELEASE_API] = json.dumps(release).encode()
    with pytest.raises(RuntimeError, match=CHECK_ERROR):
        updater.check_update(package.paths, opener=package.opener)
    assert len(package.requests) == 1


@pytest.mark.parametrize("current", [VERSION, "2026.10.01"])
def test_check_does_not_offer_same_or_older_release(package, monkeypatch, current):
    monkeypatch.setattr(updater, "current_engine", lambda: {
        "version": current, "source": "bundled", "selection": "bundled",
    })
    assert updater.check_update(package.paths, opener=package.opener)["updateAvailable"] is False


@pytest.mark.parametrize("source", ["bundled", "updated"])
@pytest.mark.parametrize("current", [VERSION, "2026.10.01"])
def test_same_or_older_pending_is_not_available_after_app_upgrade(package, monkeypatch, source, current):
    archive = seed_pending(package)
    pending = archive.parent.parent / "pending.json"
    original = pending.read_bytes()
    monkeypatch.setattr(updater, "current_engine", lambda: {
        "version": current, "source": source, "selection": "bundled" if source == "bundled" else "0" * 64,
    })
    assert updater.read_pending(package.paths) is None
    assert updater.EngineUpdateService(package.paths).snapshot()["pending"] is None
    assert pending.read_bytes() == original
    assert archive.read_bytes() == package.payload
    assert package.requests == package.probes == []


@pytest.mark.parametrize("existing_pending", [False, True])
@pytest.mark.parametrize("current", [VERSION, "2026.10.01"])
def test_prepare_returns_up_to_date_for_same_or_older_official_release(package, monkeypatch, current, existing_pending):
    engines = package.paths.data_dir / "engines"
    if existing_pending:
        seed_pending(package)
    engines.mkdir(parents=True, exist_ok=True)
    active = engines / "active.json"
    active.write_text("current-active-must-remain", encoding="utf-8")
    pending = engines / "pending.json"
    original_pending = pending.read_bytes() if existing_pending else None
    monkeypatch.setattr(updater, "current_engine", lambda: {
        "version": current, "source": "bundled", "selection": "bundled",
    })
    assert updater.update_ytdlp(package.paths, opener=package.opener) == {
        "ok": False, "upToDate": True, "version": current,
    }
    assert [url for url, _ in package.requests] == [updater.RELEASE_API]
    assert package.probes == []
    assert active.read_text() == "current-active-must-remain"
    assert (pending.read_bytes() if pending.exists() else None) == original_pending
    assert updater.EngineUpdateService(package.paths).snapshot()["pending"] is None


@pytest.mark.parametrize("pending_version", ["2026.08.18", "2026.08.19"])
def test_prepare_replaces_stale_pending_with_newer_official_release(package, pending_version):
    old_payload = archive_bytes(pending_version)
    old_digest = hashlib.sha256(old_payload).hexdigest()
    old_directory = package.paths.data_dir / "engines" / old_digest
    old_directory.mkdir(parents=True)
    old_archive = old_directory / "yt-dlp.zip"
    old_archive.write_bytes(old_payload)
    (old_directory.parent / "pending.json").write_text(json.dumps({
        "schemaVersion": 1, "sha256": old_digest, "version": pending_version,
    }), encoding="utf-8")
    assert updater.update_ytdlp(package.paths, opener=package.opener) == {
        "ok": True, "version": VERSION, "sha256": package.digest,
    }
    assert [url for url, _ in package.requests] == [updater.RELEASE_API, BASE + "SHA2-256SUMS", BASE + "yt-dlp"]
    assert updater.read_pending(package.paths)["sha256"] == package.digest
    assert old_archive.read_bytes() == old_payload


@pytest.mark.parametrize("existing_pending", [False, True])
def test_unknown_current_version_can_still_prepare(package, monkeypatch, existing_pending):
    if existing_pending:
        seed_pending(package)
    monkeypatch.setattr(updater, "current_engine", lambda: {
        "version": "unknown", "source": "bundled", "selection": "bundled",
    })
    assert updater.update_ytdlp(package.paths, opener=package.opener)["ok"] is True
    assert updater.EngineUpdateService(package.paths).snapshot()["pending"]["version"] == VERSION
    assert len(package.requests) == (0 if existing_pending else 3)


def test_up_to_date_prepare_is_successful_job_without_pending_or_error(package, monkeypatch):
    seed_pending(package)
    monkeypatch.setattr(updater, "current_engine", lambda: {
        "version": VERSION, "source": "bundled", "selection": "bundled",
    })
    monkeypatch.setattr(updater, "_default_open", package.opener)
    service = updater.EngineUpdateService(package.paths)
    identifier = service.start_prepare()["jobId"]
    completed = wait_job(service)
    assert completed["operation"] == {
        "id": identifier, "kind": "prepare", "state": "succeeded",
        "result": {"ok": False, "upToDate": True, "version": VERSION},
    }
    assert completed["pending"] is None
    assert package.probes == []


def test_preparation_publishes_verified_immutable_archive_and_pending_only(package, monkeypatch):
    monkeypatch.setenv("PYINSTALLER_RESET_ENVIRONMENT", "1")
    monkeypatch.setenv("_PYI_ARCHIVE_FILE", "same-sidecar")
    engines = package.paths.data_dir / "engines"
    engines.mkdir(parents=True)
    active = engines / "active.json"
    active.write_text("old-active-must-remain", encoding="utf-8")
    result = updater.update_ytdlp(package.paths, opener=package.opener)
    assert result == {"ok": True, "version": VERSION, "sha256": package.digest}
    assert (engines / package.digest / "yt-dlp.zip").read_bytes() == package.payload
    assert json.loads((engines / "pending.json").read_text()) == {
        "schemaVersion": 1, "sha256": package.digest, "version": VERSION,
    }
    assert active.read_text() == "old-active-must-remain"
    command, options = package.probes[0]
    assert command == [sys.executable, "-m", "src.sidecar", "--engine-probe", "--engine-id", package.digest]
    assert options["env"]["DOWNANY_DATA_DIR"] == str(package.paths.data_dir.resolve())
    assert options["env"]["_PYI_ARCHIVE_FILE"] == "same-sidecar"
    assert "PYINSTALLER_RESET_ENVIRONMENT" not in options["env"]
    assert options["stdin"] == subprocess.DEVNULL
    assert options["timeout"] == 30
    assert sorted(path.name for path in engines.iterdir()) == sorted(["active.json", "pending.json", package.digest])


def test_frozen_probe_reuses_current_executable(package, monkeypatch):
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    updater.update_ytdlp(package.paths, opener=package.opener)
    assert package.probes[0][0] == [sys.executable, "--engine-probe", "--engine-id", package.digest]


@pytest.mark.parametrize("checksum", [
    "", "0" * 64 + "  yt-dlp\n", "g" * 64 + "  yt-dlp\n",
    "{sha}  yt-dlp\n{sha}  yt-dlp\n", "{sha}  another-file\n",
])
def test_bad_or_ambiguous_checksum_never_publishes_pending(package, checksum):
    package.resources[BASE + "SHA2-256SUMS"] = checksum.format(sha=package.digest).encode()
    with pytest.raises(RuntimeError, match=PREPARE_ERROR):
        updater.update_ytdlp(package.paths, opener=package.opener)
    assert not (package.paths.data_dir / "engines" / "pending.json").exists()
    assert package.probes == []


def test_valid_checksum_plus_malformed_duplicate_is_rejected(package):
    package.resources[BASE + "SHA2-256SUMS"] = f"{package.digest}  yt-dlp\ninvalid  yt-dlp\n".encode()
    with pytest.raises(RuntimeError, match=PREPARE_ERROR):
        updater.update_ytdlp(package.paths, opener=package.opener)
    assert package.probes == []


@pytest.mark.parametrize("url", [
    "http://github.com/yt-dlp/yt-dlp/releases/download/2026.09.27/yt-dlp",
    "https://example.invalid/archive", "https://github.com.evil.invalid/archive",
    "https://user:password@github.com/archive", "https://github.com:8443/archive",
])
def test_redirect_handler_rejects_external_or_downgraded_requests(url):
    handler = updater._OfficialRedirectHandler()
    with pytest.raises(ValueError):
        handler.redirect_request(urllib.request.Request(BASE + "yt-dlp"), None, 302, "Found", {}, url)


def test_redirect_handler_accepts_official_asset_cdn():
    target = "https://release-assets.githubusercontent.com/release-file?signature=test"
    redirected = updater._OfficialRedirectHandler().redirect_request(
        urllib.request.Request(BASE + "yt-dlp"), None, 302, "Found", {}, target,
    )
    assert redirected.full_url == target


@pytest.mark.parametrize("resource,limit", [
    (updater.RELEASE_API, "_MAX_METADATA_BYTES"),
    (BASE + "SHA2-256SUMS", "_MAX_CHECKSUM_BYTES"),
])
def test_metadata_and_checksum_reads_are_bounded(package, monkeypatch, resource, limit):
    monkeypatch.setattr(updater, limit, 32)
    package.resources[resource] = b"x" * 33
    with pytest.raises(RuntimeError, match=PREPARE_ERROR):
        updater.update_ytdlp(package.paths, opener=package.opener)
    assert package.probes == []


def test_archive_download_is_bounded_and_never_probed_when_too_large(package, monkeypatch):
    monkeypatch.setattr(updater, "_MAX_ARCHIVE_BYTES", 32, raising=False)
    with pytest.raises(RuntimeError, match=PREPARE_ERROR):
        updater.update_ytdlp(package.paths, opener=package.opener)
    assert not (package.paths.data_dir / "engines" / "pending.json").exists()
    assert package.probes == []
    assert not list((package.paths.data_dir / "engines").glob(".download-*"))


def test_slow_continuous_download_has_total_deadline(package, monkeypatch):
    clock = [0.0]
    reads = []
    timeouts = []
    monkeypatch.setattr(updater, "_PREPARE_TIMEOUT", 5.0, raising=False)
    monkeypatch.setattr(time, "monotonic", lambda: clock[0])

    class SlowResponse(Response):
        def read(self, _size=-1):
            pytest.fail("read(size) can wait indefinitely for a slow continuous stream")

        def read1(self, _size=-1):
            clock[0] += 1
            reads.append(clock[0])
            return io.BytesIO.read(self, 1)

    def opener(request, timeout):
        timeouts.append(timeout)
        if request.full_url == BASE + "yt-dlp":
            return SlowResponse(package.payload, request.full_url)
        return Response(package.resources[request.full_url], request.full_url)

    with pytest.raises(RuntimeError, match=PREPARE_ERROR):
        updater.update_ytdlp(package.paths, opener=opener)
    assert reads == [1, 2, 3, 4, 5]
    assert all(0 < timeout <= 5 for timeout in timeouts)
    assert package.probes == []
    assert not (package.paths.data_dir / "engines" / "pending.json").exists()


@pytest.mark.parametrize("stdout,code", [
    ("not-json", 0),
    ("{secret}", 1),
    ('{{"version":"2026.09.27","source":"bundled","selection":"bundled"}}', 0),
    ('{{"version":"2026.09.26","source":"updated","selection":"{sha}"}}', 0),
    ('{{"version":"2026.09.27","source":"updated","selection":"{sha}","extra":"{secret}"}}', 0),
])
def test_probe_must_confirm_exact_three_field_contract(package, monkeypatch, stdout, code):
    monkeypatch.setattr(updater.subprocess, "run", lambda *_a, **_k: SimpleNamespace(
        returncode=code, stderr=SECRET, stdout=stdout.format(sha=package.digest, secret=SECRET),
    ))
    with pytest.raises(RuntimeError) as error:
        updater.update_ytdlp(package.paths, opener=package.opener)
    assert str(error.value) == PREPARE_ERROR
    assert SECRET not in str(error.value)
    assert not (package.paths.data_dir / "engines" / "pending.json").exists()


def test_existing_archive_is_reused_without_replacement_or_redownload(package):
    path = seed_pending(package)
    original_stat = path.stat()
    updater.update_ytdlp(package.paths, opener=package.opener)
    assert path.stat().st_ino == original_stat.st_ino
    assert path.stat().st_mtime_ns == original_stat.st_mtime_ns
    assert package.requests == []
    assert len(package.probes) == 1


def test_damaged_existing_hash_directory_is_never_overwritten(package):
    path = seed_pending(package, data=b"damaged-immutable-file")
    with pytest.raises(RuntimeError, match=PREPARE_ERROR):
        updater.update_ytdlp(package.paths, opener=package.opener)
    assert path.read_bytes() == b"damaged-immutable-file"


def test_failed_prepare_preserves_previous_pending(package, monkeypatch):
    engines = package.paths.data_dir / "engines"
    engines.mkdir(parents=True)
    pending = engines / "pending.json"
    pending.write_text("previous-pointer", encoding="utf-8")
    monkeypatch.setattr(updater.subprocess, "run", lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError(SECRET)))
    with pytest.raises(RuntimeError, match=PREPARE_ERROR):
        updater.update_ytdlp(package.paths, opener=package.opener)
    assert pending.read_text() == "previous-pointer"


def test_atomic_pending_write_failure_preserves_old_record_and_removes_temp(package, monkeypatch):
    path = seed_pending(package)
    pending = path.parent.parent / "pending.json"
    previous = pending.read_bytes()

    def fail(*_args):
        raise OSError(SECRET)

    monkeypatch.setattr(updater.os, "replace", fail)
    with pytest.raises(RuntimeError, match=PREPARE_ERROR):
        updater.update_ytdlp(package.paths, opener=package.opener)
    assert pending.read_bytes() == previous
    assert not list(pending.parent.glob(".pending-*"))


def test_racing_archive_publication_does_not_overwrite_winner(package, monkeypatch):
    target = package.paths.data_dir / "engines" / package.digest / "yt-dlp.zip"

    def another_writer(_source, destination):
        destination.write_bytes(b"another-writer")
        raise FileExistsError

    monkeypatch.setattr(updater.os, "link", another_writer)
    with pytest.raises(RuntimeError, match=PREPARE_ERROR):
        updater.update_ytdlp(package.paths, opener=package.opener)
    assert target.read_bytes() == b"another-writer"
    assert not list(target.parent.parent.glob(".download-*"))


@pytest.mark.parametrize("patch", [
    {"schemaVersion": True}, {"schemaVersion": 2}, {"sha256": "../private"},
    {"version": "2026.09.26"}, {"extra": SECRET},
])
def test_pending_reader_rejects_invalid_schema_or_identity(package, patch):
    seed_pending(package, manifest={"schemaVersion": 1, "sha256": package.digest, "version": VERSION, **patch})
    assert updater.read_pending(package.paths) is None
    assert package.requests == []
    assert package.probes == []


def test_pending_reader_accepts_only_matching_archive(package):
    path = seed_pending(package)
    assert updater.read_pending(package.paths) == {"schemaVersion": 1, "sha256": package.digest, "version": VERSION}
    path.write_bytes(b"changed")
    assert updater.read_pending(package.paths) is None


def test_pending_reader_rejects_duplicated_identity_keys(package):
    path = seed_pending(package).parent.parent / "pending.json"
    path.write_text(
        '{"schemaVersion":1,"sha256":"' + package.digest + '",'
        '"version":"2025.01.01","version":"' + VERSION + '"}', encoding="utf-8",
    )
    assert updater.read_pending(package.paths) is None


def test_pending_reader_rejects_symlinked_archive(package, tmp_path):
    path = seed_pending(package)
    other = tmp_path / "elsewhere.zip"
    path.replace(other)
    try:
        path.symlink_to(other)
    except OSError:
        pytest.skip("symlinks unavailable")
    assert updater.read_pending(package.paths) is None


def test_external_download_url_is_not_an_input(package):
    with pytest.raises(TypeError):
        updater.update_ytdlp(package.paths, download_url="https://example.invalid/private")
    assert package.requests == []


@pytest.mark.parametrize("operation,message", [("check_update", CHECK_ERROR), ("update_ytdlp", PREPARE_ERROR)])
def test_network_exceptions_are_sanitized(package, operation, message):
    def broken(*_args, **_kwargs):
        raise RuntimeError(SECRET)
    with pytest.raises(RuntimeError) as error:
        getattr(updater, operation)(package.paths, opener=broken)
    assert str(error.value) == message
    assert error.value.__suppress_context__ is True


def test_service_single_flight_does_not_block_protocol_and_returns_copies(package, monkeypatch):
    entered = threading.Event()
    release = threading.Event()

    def slow_check(_paths):
        entered.set()
        assert release.wait(2)
        return {"currentVersion": "2026.08.19", "latestVersion": VERSION, "updateAvailable": True}

    monkeypatch.setattr(updater, "check_update", slow_check)
    service = updater.EngineUpdateService(package.paths)
    started_at = time.monotonic()
    first = service.start_check()
    assert time.monotonic() - started_at < 0.2
    assert entered.wait(1)
    try:
        assert service.start_check() == first
        with pytest.raises(RuntimeError):
            service.start_prepare()
        snapshot = service.snapshot()
        assert snapshot["operation"] == {"id": first["jobId"], "kind": "check", "state": "running"}
        snapshot["operation"]["state"] = "changed"
        assert service.snapshot()["operation"]["state"] == "running"
    finally:
        release.set()
    completed = wait_job(service)
    assert completed["operation"]["state"] == "succeeded"
    assert completed["operation"]["result"]["latestVersion"] == VERSION
    assert completed["current"]["selection"] == "bundled"
    assert completed["pending"] is None


def test_service_reuses_valid_pending_and_does_not_activate(package, monkeypatch):
    seed_pending(package)
    monkeypatch.setattr(updater, "_default_open", lambda *_a, **_k: pytest.fail("pending must not download again"), raising=False)
    service = updater.EngineUpdateService(package.paths)
    identifier = service.start_prepare()["jobId"]
    completed = wait_job(service)
    assert completed["operation"] == {
        "id": identifier, "kind": "prepare", "state": "succeeded",
        "result": {"ok": True, "version": VERSION, "sha256": package.digest},
    }
    assert completed["pending"]["sha256"] == package.digest
    assert not (package.paths.data_dir / "engines" / "active.json").exists()


def test_service_reports_only_fixed_error_and_allows_retry(package, monkeypatch):
    def fail(_paths):
        raise RuntimeError(SECRET)
    monkeypatch.setattr(updater, "update_ytdlp", fail)
    service = updater.EngineUpdateService(package.paths)
    first = service.start_prepare()["jobId"]
    snapshot = wait_job(service)
    assert snapshot["operation"] == {"id": first, "kind": "prepare", "state": "failed", "error": PREPARE_ERROR}
    second = service.start_prepare()["jobId"]
    assert second != first
    wait_job(service)


def test_service_starts_worker_outside_state_lock(package, monkeypatch):
    service = updater.EngineUpdateService(package.paths)
    lock_free = []

    class InlineThread:
        def __init__(self, *, target, args, daemon):
            self.target, self.args = target, args

        def start(self):
            acquired = service._lock.acquire(blocking=False)
            lock_free.append(acquired)
            if not acquired:
                raise RuntimeError("worker launched under state lock")
            service._lock.release()
            self.target(*self.args)

    monkeypatch.setattr(updater.threading, "Thread", InlineThread)
    monkeypatch.setattr(updater, "check_update", lambda _paths: {"latestVersion": VERSION})
    service.start_check()
    assert lock_free == [True]
    assert service.snapshot()["operation"]["state"] == "succeeded"
