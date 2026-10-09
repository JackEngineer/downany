"""从官方 release 准备共享引擎；此模块不切换活动版本。"""
from __future__ import annotations

import copy
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import uuid
from typing import Any

from src.core.ytdlp_runtime import _verify_archive, current_engine
from src.sidecar.paths import AppPaths


RELEASE_API = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest"
_RELEASE_BASE = "https://github.com/yt-dlp/yt-dlp/releases/download/"
_OFFICIAL_HOSTS = {"api.github.com", "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"}
_VERSION = re.compile(r"[0-9]{4}\.[0-9]{2}\.[0-9]{2}(?:\.[0-9]+)?\Z")
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
_MAX_METADATA_BYTES = 2 * 1024 * 1024
_MAX_CHECKSUM_BYTES = 1024 * 1024
_PREPARE_TIMEOUT = 120.0
_CHECK_TIMEOUT = 60.0
_CHECK_ERROR = "暂时无法检查下载工具更新，请稍后重试。"
_PREPARE_ERROR = "下载工具准备失败，请稍后重试。"
_BUSY_ERROR = "下载工具更新任务正在进行，请稍后重试。"


def _official_url(url: str) -> bool:
    parsed = urllib.parse.urlsplit(url)
    return (parsed.scheme == "https" and parsed.hostname in _OFFICIAL_HOSTS
            and parsed.username is None and parsed.password is None
            and parsed.port in (None, 443))


class _OfficialRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not _official_url(newurl):
            raise ValueError("untrusted_redirect")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _default_open(request, timeout):
    return urllib.request.build_opener(_OfficialRedirectHandler()).open(request, timeout=timeout)


def _remaining(deadline: float, cap: float = 30.0) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("deadline_exceeded")
    return min(cap, remaining)


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate_json_key")
        result[key] = value
    return result


def _open(opener, url: str, deadline: float):
    if not _official_url(url):
        raise ValueError("untrusted_url")
    request = urllib.request.Request(url, headers={
        "User-Agent": "Downany/0.3", "Accept": "application/vnd.github+json" if url == RELEASE_API else "*/*",
    })
    response = opener(request, timeout=_remaining(deadline))
    try:
        if not _official_url(response.geturl()):
            raise ValueError("untrusted_response")
    except Exception:
        response.close()
        raise
    return response


def _chunks(response, limit: int, deadline: float):
    size = 0
    # HTTPResponse.read(n) 可持续等待慢速流填满 n；read1 每次底层读取后返回，
    # 才能在有数据持续到达时仍检查整个任务的截止时间。
    read = getattr(response, "read1", response.read)
    while True:
        _remaining(deadline)
        chunk = read(min(65536, limit - size + 1))
        _remaining(deadline)
        if not chunk:
            return
        size += len(chunk)
        if size > limit:
            raise ValueError("response_too_large")
        yield chunk


def _read(opener, url: str, limit: int, deadline: float) -> bytes:
    with _open(opener, url, deadline) as response:
        return b"".join(_chunks(response, limit, deadline))


def _release(opener, deadline: float) -> tuple[str, str, str]:
    release = json.loads(_read(opener, RELEASE_API, _MAX_METADATA_BYTES, deadline), object_pairs_hook=_unique_object)
    if (not isinstance(release, dict) or release.get("draft") is True
            or release.get("prerelease") is True):
        raise ValueError("invalid_release")
    tag = release.get("tag_name")
    if not isinstance(tag, str):
        raise ValueError("invalid_tag")
    version = tag.removeprefix("v")
    if not _VERSION.fullmatch(version):
        raise ValueError("invalid_version")
    assets = release.get("assets")
    if not isinstance(assets, list):
        raise ValueError("invalid_assets")
    urls = []
    for name in ("yt-dlp", "SHA2-256SUMS"):
        matches = [asset for asset in assets if isinstance(asset, dict) and asset.get("name") == name]
        expected = f"{_RELEASE_BASE}{tag}/{name}"
        if len(matches) != 1 or matches[0].get("browser_download_url") != expected:
            raise ValueError("invalid_asset")
        urls.append(expected)
    return version, urls[0], urls[1]


def current_version(paths: AppPaths) -> str:
    """报告当前进程真实引擎；不执行用户目录里的旧 standalone。"""
    try:
        version = current_engine().get("version")
        return version if isinstance(version, str) and _VERSION.fullmatch(version) else "unknown"
    except Exception:
        return "unknown"


def _is_newer(version: str, current: str) -> bool:
    return current == "unknown" or tuple(map(int, version.split("."))) > tuple(map(int, current.split(".")))


def check_update(paths: AppPaths, *, opener=None) -> dict[str, Any]:
    try:
        version, _archive_url, _checksum_url = _release(opener or _default_open, time.monotonic() + _CHECK_TIMEOUT)
        current = current_version(paths)
        return {"currentVersion": current, "latestVersion": version, "updateAvailable": _is_newer(version, current)}
    except Exception:
        raise RuntimeError(_CHECK_ERROR) from None


def read_pending(paths: AppPaths) -> dict | None:
    """只返回身份有效且比实际引擎更新的候选；旧文件保留但不可激活。"""
    root = paths.data_dir / "engines"
    path = root / "pending.json"
    try:
        if root.is_symlink() or path.is_symlink():
            return None
        with path.open("rb") as stream:
            content = stream.read(16385)
        if len(content) > 16384:
            return None
        manifest = json.loads(content, object_pairs_hook=_unique_object)
        if (not isinstance(manifest, dict) or set(manifest) != {"schemaVersion", "sha256", "version"}
                or type(manifest["schemaVersion"]) is not int or manifest["schemaVersion"] != 1
                or not isinstance(manifest["sha256"], str) or not _SHA256.fullmatch(manifest["sha256"])
                or not isinstance(manifest["version"], str) or not _VERSION.fullmatch(manifest["version"])):
            return None
        if not _is_newer(manifest["version"], current_version(paths)):
            return None
        _verify_archive(root, manifest["sha256"], manifest["version"])
        return manifest
    except Exception:
        return None


def _checksum(content: bytes) -> str:
    matches = []
    for line in content.decode("utf-8").splitlines():
        fields = line.split()
        if not fields or fields[-1].lstrip("*") != "yt-dlp":
            continue
        match = re.fullmatch(r"([0-9a-fA-F]{64}) [ *]yt-dlp", line)
        if not match:
            raise ValueError("invalid_checksum")
        matches.append(match[1].lower())
    if len(matches) != 1:
        raise ValueError("invalid_checksum")
    return matches[0]


def _publish_archive(root: Path, selection: str, version: str, url: str, opener, deadline: float) -> None:
    directory = root / selection
    if directory.is_symlink():
        raise ValueError("invalid_directory")
    directory.mkdir(exist_ok=True)
    target = directory / "yt-dlp.zip"
    if target.exists() or target.is_symlink():
        _verify_archive(root, selection, version)
        return
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=root, prefix=".download-", delete=False) as out:
            temporary = Path(out.name)
            digest = hashlib.sha256()
            with _open(opener, url, deadline) as response:
                for chunk in _chunks(response, _MAX_ARCHIVE_BYTES, deadline):
                    digest.update(chunk)
                    out.write(chunk)
            out.flush()
            os.fsync(out.fileno())
        if digest.hexdigest() != selection:
            raise ValueError("checksum_mismatch")
        try:
            # 同卷硬链接原子发布且不覆盖已有路径；不存在半写入的可见归档。
            os.link(temporary, target)
        except FileExistsError:
            pass
        _verify_archive(root, selection, version)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def _probe(paths: AppPaths, manifest: dict, deadline: float) -> None:
    frozen = bool(getattr(sys, "frozen", False))
    prefix = [sys.executable] if frozen else [sys.executable, "-m", "src.sidecar"]
    env = {**os.environ, "DOWNANY_DATA_DIR": str(paths.data_dir.resolve()), "PYTHONIOENCODING": "utf-8"}
    env.pop("PYINSTALLER_RESET_ENVIRONMENT", None)
    process = subprocess.run(
        [*prefix, "--engine-probe", "--engine-id", manifest["sha256"]],
        stdin=subprocess.DEVNULL, capture_output=True, text=True, encoding="utf-8",
        timeout=_remaining(deadline), check=False, env=env,
        cwd=None if frozen else str(Path(__file__).resolve().parents[2]),
    )
    expected = {"version": manifest["version"], "source": "updated", "selection": manifest["sha256"]}
    if (process.returncode != 0 or len(process.stdout) > 16384
            or json.loads(process.stdout, object_pairs_hook=_unique_object) != expected):
        raise ValueError("probe_failed")


def _write_pending(root: Path, manifest: dict) -> None:
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=root, prefix=".pending-", mode="w", encoding="utf-8", delete=False) as out:
            temporary = Path(out.name)
            json.dump(manifest, out, ensure_ascii=True)
            out.write("\n")
            out.flush()
            os.fsync(out.fileno())
        os.replace(temporary, root / "pending.json")
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def update_ytdlp(paths: AppPaths, *, opener=None) -> dict[str, Any]:
    """准备候选并自检；复用候选也重新自检，但从不写 active.json。"""
    try:
        deadline = time.monotonic() + _PREPARE_TIMEOUT
        manifest = read_pending(paths)
        if manifest is None:
            open_url = opener or _default_open
            version, archive_url, checksum_url = _release(open_url, deadline)
            current = current_version(paths)
            if not _is_newer(version, current):
                return {"ok": False, "upToDate": True, "version": current}
            selection = _checksum(_read(open_url, checksum_url, _MAX_CHECKSUM_BYTES, deadline))
            root = paths.data_dir / "engines"
            if root.is_symlink():
                raise ValueError("invalid_directory")
            root.mkdir(parents=True, exist_ok=True)
            _publish_archive(root, selection, version, archive_url, open_url, deadline)
            manifest = {"schemaVersion": 1, "sha256": selection, "version": version}
        _probe(paths, manifest, deadline)
        _remaining(deadline)
        _write_pending(paths.data_dir / "engines", manifest)
        return {"ok": True, "version": manifest["version"], "sha256": manifest["sha256"]}
    except Exception:
        raise RuntimeError(_PREPARE_ERROR) from None


class EngineUpdateService:
    """一个 Sidecar 一个服务；锁只保护任务状态，网络与自检都在后台。"""

    def __init__(self, paths: AppPaths):
        self.paths = paths
        self._lock = threading.Lock()
        self._operation: dict | None = None

    def start_check(self) -> dict:
        return self._start("check")

    def start_prepare(self) -> dict:
        return self._start("prepare")

    def _start(self, kind: str) -> dict:
        with self._lock:
            if self._operation is not None and self._operation["state"] == "running":
                if self._operation["kind"] != kind:
                    raise RuntimeError(_BUSY_ERROR)
                return {"jobId": self._operation["id"]}
            identifier = str(uuid.uuid4())
            self._operation = {"id": identifier, "kind": kind, "state": "running"}
        try:
            threading.Thread(target=self._run, args=(identifier, kind), daemon=True).start()
        except Exception:
            with self._lock:
                if self._operation is not None and self._operation["id"] == identifier:
                    self._operation.update(state="failed", error=_CHECK_ERROR if kind == "check" else _PREPARE_ERROR)
        return {"jobId": identifier}

    def _run(self, identifier: str, kind: str) -> None:
        try:
            result = check_update(self.paths) if kind == "check" else update_ytdlp(self.paths)
            changes = {"state": "succeeded", "result": result}
        except Exception:
            changes = {"state": "failed", "error": _CHECK_ERROR if kind == "check" else _PREPARE_ERROR}
        with self._lock:
            if self._operation is not None and self._operation["id"] == identifier:
                self._operation.update(changes)

    def snapshot(self) -> dict:
        with self._lock:
            operation = copy.deepcopy(self._operation)
        return {"current": current_engine(), "pending": read_pending(self.paths), "operation": operation}
