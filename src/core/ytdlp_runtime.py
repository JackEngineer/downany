"""在首次导入前选择 yt-dlp；归档激活只在新进程启动时执行。

更新器负责可信来源及原子发布，本模块验证已发布的内容身份和可导入性。
内容寻址归档在使用期间必须保持不变，不支持运行中 reload。
"""
from __future__ import annotations

import ast
import hashlib
import importlib
import json
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import threading
import zipfile
import zlib

from src.sidecar.paths import AppPaths


_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_VERSION = re.compile(r"[0-9][0-9A-Za-z.+_-]{0,63}\Z")
_MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
_MAX_EXPANDED_BYTES = 256 * 1024 * 1024
_REQUIRED_MEMBERS = {"__main__.py", "yt_dlp/__init__.py", "yt_dlp/version.py", "yt_dlp_ejs/__init__.py"}
_engine: dict | None = None
_lock = threading.RLock()


class EngineActivationError(RuntimeError):
    """仅携带固定错误类别，避免启动日志包含本地路径或底层异常。"""


def _engine_modules() -> list[str]:
    return [name for name in sys.modules
            if name in ("yt_dlp", "yt_dlp_ejs") or name.startswith(("yt_dlp.", "yt_dlp_ejs."))]


def _valid_version(version: object) -> bool:
    return isinstance(version, str) and _VERSION.fullmatch(version) is not None


def _read_manifest(root: Path) -> tuple[str, str] | None:
    try:
        with (root / "active.json").open("rb") as stream:
            raw = stream.read(16 * 1024 + 1)
        if len(raw) > 16 * 1024:
            raise ValueError
        manifest = json.loads(raw)
        if (not isinstance(manifest, dict)
                or type(manifest.get("schemaVersion")) is not int
                or manifest["schemaVersion"] != 1
                or not isinstance(manifest.get("sha256"), str)
                or not _SHA256.fullmatch(manifest["sha256"])
                or not _valid_version(manifest.get("version"))):
            raise ValueError
        return manifest["sha256"], manifest["version"]
    except FileNotFoundError:
        return None
    except (OSError, ValueError, TypeError, RecursionError):
        raise EngineActivationError("invalid_manifest") from None


def _archive_version(archive: zipfile.ZipFile) -> str:
    member = archive.getinfo("yt_dlp/version.py")
    if member.file_size > 64 * 1024:
        raise ValueError
    tree = ast.parse(archive.read(member).decode("utf-8"))
    versions = [node.value.value for node in tree.body
                if isinstance(node, ast.Assign)
                and any(isinstance(target, ast.Name) and target.id == "__version__" for target in node.targets)
                and isinstance(node.value, ast.Constant)]
    if len(versions) != 1 or not _valid_version(versions[0]):
        raise ValueError
    return versions[0]


def _verify_archive(root: Path, selection: str, expected_version: str | None) -> tuple[Path, str]:
    path = root / selection / "yt-dlp.zip"
    try:
        if path.is_symlink() or path.parent.is_symlink():
            raise EngineActivationError("invalid_archive")
        path.resolve().relative_to(root.resolve())
        if path.stat().st_size > _MAX_ARCHIVE_BYTES:
            raise EngineActivationError("invalid_archive")
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest() != selection:
            raise EngineActivationError("digest_mismatch")
        with zipfile.ZipFile(path) as archive:
            members = archive.infolist()
            names = [member.filename for member in members]
            if (len(members) > 50000 or len(names) != len(set(names))
                    or not _REQUIRED_MEMBERS.issubset(names)
                    or sum(member.file_size for member in members) > _MAX_EXPANDED_BYTES):
                raise ValueError
            for member in members:
                name = member.filename
                if ("\\" in name or ":" in name or name.startswith("/")
                        or ".." in PurePosixPath(name).parts
                        or stat.S_ISLNK(member.external_attr >> 16)
                        or member.flag_bits & 1):
                    raise ValueError
            if archive.testzip() is not None:
                raise ValueError
            version = _archive_version(archive)
        if expected_version is not None and version != expected_version:
            raise EngineActivationError("version_mismatch")
        return path.resolve(), version
    except EngineActivationError:
        raise
    except FileNotFoundError:
        raise EngineActivationError("archive_missing") from None
    except (OSError, ValueError, SyntaxError, KeyError, RuntimeError, zipfile.BadZipFile, zlib.error):
        raise EngineActivationError("invalid_archive") from None


def _bundled(fallback_reason: str | None = None) -> dict:
    try:
        importlib.import_module("yt_dlp")
        version = importlib.import_module("yt_dlp.version").__version__
        if not _valid_version(version):
            raise ValueError
    except (Exception, SystemExit):
        raise EngineActivationError("bundled_import_failed") from None
    info = {"version": version, "source": "bundled", "selection": "bundled"}
    if fallback_reason is not None:
        info["fallbackReason"] = fallback_reason
    return info


def _updated(root: Path, selection: str, expected_version: str | None) -> dict:
    if _engine_modules():
        raise EngineActivationError("already_imported")
    path, version = _verify_archive(root, selection, expected_version)
    archive_path = str(path)
    sys.path.insert(0, archive_path)
    importlib.invalidate_caches()
    failure = None
    try:
        modules = [importlib.import_module(name) for name in ("yt_dlp", "yt_dlp.version", "yt_dlp_ejs")]
        prefix = archive_path.replace("\\", "/") + "/"
        if not all(str(getattr(module, "__file__", "")).replace("\\", "/").startswith(prefix) for module in modules):
            raise EngineActivationError("import_failed")
        if modules[1].__version__ != version:
            raise EngineActivationError("version_mismatch")
        return {"version": version, "source": "updated", "selection": selection}
    except EngineActivationError as exc:
        failure = str(exc) if str(exc) in ("import_failed", "version_mismatch") else "import_failed"
    except (Exception, SystemExit):
        failure = "import_failed"
    finally:
        if failure is not None:
            # 此前确认没有引擎模块；只清理本次 bootstrap 产生的自身模块。
            for name in _engine_modules():
                sys.modules.pop(name, None)
            sys.path.remove(archive_path)
            sys.path_importer_cache.pop(archive_path, None)
            importlib.invalidate_caches()
    raise EngineActivationError(failure) from None


def activate_engine(selection: str | None = None) -> dict:
    """激活一次。默认指针失败可回退；显式内容身份失败必须终止。"""
    global _engine
    with _lock:
        if selection is not None and (not isinstance(selection, str)
                                      or (selection != "bundled" and not _SHA256.fullmatch(selection))):
            raise EngineActivationError("invalid_selection")
        if _engine is not None:
            if selection is not None and selection != _engine["selection"]:
                raise EngineActivationError("already_activated")
            return dict(_engine)
        if selection == "bundled":
            _engine = _bundled()
            return dict(_engine)
        root = AppPaths.default().data_dir / "engines"
        expected_version = None
        try:
            chosen = selection
            if chosen is None:
                manifest = _read_manifest(root)
                if manifest is None:
                    _engine = _bundled()
                    return dict(_engine)
                chosen, expected_version = manifest
            _engine = _updated(root, chosen, expected_version)
        except EngineActivationError as exc:
            if selection is not None or str(exc) == "already_imported":
                raise
            _engine = _bundled(str(exc))
        return dict(_engine)


def current_engine() -> dict:
    """普通 CLI / 测试若先导入内置模块，报告实际已用版本，不切换它。"""
    global _engine
    with _lock:
        if _engine is None and _engine_modules():
            _engine = _bundled()
        return dict(_engine) if _engine is not None else activate_engine()


def engine_cli_command() -> list[str]:
    """解析子进程固定到父进程当前引擎，不再追随可能变化的活动指针。"""
    prefix = [sys.executable] if getattr(sys, "frozen", False) else [sys.executable, "-m", "src.sidecar"]
    return [*prefix, "--engine-cli", "--engine-id", current_engine()["selection"], "--"]
