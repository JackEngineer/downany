"""Atomic no-overwrite publication of verified output bundles."""
from __future__ import annotations

import ctypes
import errno
import os
import re
import shutil
import stat
import sys
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from itertools import count
from pathlib import Path
from uuid import uuid4

from src.core.downloader import DownloadResult
from src.core.error_codes import OutputVerificationFailed
from src.core.output_paths import FinalPathPlan, build_final_path_plan
from src.utils.logger import setup_logger

logger = setup_logger("OutputCommit")

_SAFE_COMMIT_FAILURE = "成品无法验证，请导出诊断后重试"
_UNSUPPORTED_PUBLICATION = "当前磁盘无法安全保存成品"
_HIDDEN_NAME_RE = re.compile(r"^\..+\.downany-[0-9a-f]{32}\.tmp$")
_ROOT_LOCKS: dict[str, threading.RLock] = {}
_ROOT_LOCKS_GUARD = threading.Lock()


@dataclass(frozen=True)
class OutputFingerprint:
    path: Path
    device: int
    inode: int
    size: int
    mtime_ns: int


@dataclass(frozen=True)
class CommittedOutput:
    main_file: Path
    subtitle_files: tuple[Path, ...]
    created_fingerprints: tuple[OutputFingerprint, ...]


def _commit_failure(detail: str) -> OutputVerificationFailed:
    logger.error("成品发布失败: %s", detail)
    return OutputVerificationFailed(_SAFE_COMMIT_FAILURE)


def _root_lock(root: Path) -> threading.RLock:
    key = os.path.normcase(str(Path(root).expanduser().resolve(strict=False)))
    with _ROOT_LOCKS_GUARD:
        lock = _ROOT_LOCKS.get(key)
        if lock is None:
            lock = threading.RLock()
            _ROOT_LOCKS[key] = lock
        return lock


def _is_inside(root: Path, candidate: Path) -> bool:
    try:
        return os.path.commonpath(
            [os.path.normcase(str(root)), os.path.normcase(str(candidate))]
        ) == os.path.normcase(str(root))
    except ValueError:
        return False


def _prepare_directory(plan: FinalPathPlan) -> Path:
    try:
        plan.directory.mkdir(parents=True, exist_ok=True)
        directory = plan.directory.resolve(strict=True)
        root = plan.root.resolve(strict=True)
    except (OSError, RuntimeError, ValueError) as exc:
        raise _commit_failure(f"成品目录无法创建: {exc}") from exc
    if not directory.is_dir() or not _is_inside(root, directory):
        raise _commit_failure("成品目录超出下载位置")
    return directory


def _validated_target(root: Path, target: Path, directory: Path) -> Path:
    try:
        resolved = target.resolve(strict=False)
    except (OSError, RuntimeError, ValueError) as exc:
        raise _commit_failure(f"成品目标无法解析: {exc}") from exc
    if resolved.parent != directory or not _is_inside(root, resolved):
        raise _commit_failure("成品目标超出下载位置")
    return resolved


def _fingerprint(path: Path) -> OutputFingerprint:
    try:
        details = path.lstat()
    except OSError as exc:
        raise _commit_failure(f"无法记录新成品: {exc}") from exc
    if stat.S_ISLNK(details.st_mode) or not stat.S_ISREG(details.st_mode):
        raise _commit_failure("新成品不是普通文件")
    return OutputFingerprint(
        path=path,
        device=int(details.st_dev),
        inode=int(details.st_ino),
        size=int(details.st_size),
        mtime_ns=int(details.st_mtime_ns),
    )


def _matches_fingerprint(fingerprint: OutputFingerprint) -> bool:
    try:
        details = fingerprint.path.lstat()
    except OSError:
        return False
    if stat.S_ISLNK(details.st_mode) or not stat.S_ISREG(details.st_mode):
        return False
    return (
        int(details.st_dev) == fingerprint.device
        and int(details.st_ino) == fingerprint.inode
        and int(details.st_size) == fingerprint.size
        and int(details.st_mtime_ns) == fingerprint.mtime_ns
    )


def _fsync_directory(directory: Path) -> None:
    descriptor: int | None = None
    try:
        descriptor = os.open(str(directory), os.O_RDONLY)
        os.fsync(descriptor)
    except OSError:
        return
    finally:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass


def _unlink_published_hidden(hidden: Path) -> None:
    try:
        hidden.unlink()
    except FileNotFoundError:
        return
    except OSError as exc:
        logger.warning("已发布成品的隐藏副本稍后清理: %s", exc)


def _windows_move_no_replace(hidden: Path, target: Path) -> None:
    if target.exists() or target.is_symlink():
        raise FileExistsError(str(target))
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    move_file_ex = kernel32.MoveFileExW
    move_file_ex.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint32]
    move_file_ex.restype = ctypes.c_int
    movefile_write_through = 0x00000008
    if move_file_ex(str(hidden), str(target), movefile_write_through):
        return
    error_code = ctypes.get_last_error()
    if error_code in {80, 183}:
        raise FileExistsError(str(target))
    raise OSError(error_code, "MoveFileExW failed")


def _macos_rename_no_replace(hidden: Path, target: Path) -> None:
    if target.exists() or target.is_symlink():
        raise FileExistsError(str(target))
    libc = ctypes.CDLL(None, use_errno=True)
    try:
        renamex_np = libc.renamex_np
    except AttributeError as exc:
        raise OutputVerificationFailed(_UNSUPPORTED_PUBLICATION) from exc
    renamex_np.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
    renamex_np.restype = ctypes.c_int
    rename_excl = 0x00000004
    if renamex_np(
        os.fsencode(hidden),
        os.fsencode(target),
        rename_excl,
    ) == 0:
        return
    error_code = ctypes.get_errno()
    if error_code == errno.EEXIST:
        raise FileExistsError(str(target))
    raise OSError(error_code, "renamex_np failed")


def publish_no_replace(hidden: Path, target: Path) -> None:
    """Atomically make hidden visible at target, failing if target exists."""
    hidden_path = Path(hidden)
    target_path = Path(target)
    if target_path.exists() or target_path.is_symlink():
        raise FileExistsError(str(target_path))
    try:
        os.link(hidden_path, target_path)
    except FileExistsError:
        raise
    except OSError as exc:
        fallback_errors = {
            errno.EACCES,
            errno.EINVAL,
            errno.EPERM,
            errno.EXDEV,
            errno.ENOSYS,
            getattr(errno, "ENOTSUP", errno.EPERM),
            getattr(errno, "EOPNOTSUPP", errno.EPERM),
        }
        if exc.errno not in fallback_errors:
            raise
    else:
        _unlink_published_hidden(hidden_path)
        return

    if sys.platform == "win32":
        _windows_move_no_replace(hidden_path, target_path)
        return
    if sys.platform == "darwin":
        _macos_rename_no_replace(hidden_path, target_path)
        return
    raise OutputVerificationFailed(_UNSUPPORTED_PUBLICATION)


def cleanup_stale_hidden_files(
    directory: Path,
    *,
    older_than_seconds: int = 86_400,
    now: Callable[[], float] = time.time,
) -> int:
    """Remove only aged Downany-owned hidden output copies in one directory."""
    folder = Path(directory)
    try:
        entries = list(folder.iterdir())
    except OSError:
        return 0
    removed = 0
    current_time = float(now())
    for path in entries:
        if not _HIDDEN_NAME_RE.fullmatch(path.name):
            continue
        try:
            details = path.lstat()
            if stat.S_ISLNK(details.st_mode) or not stat.S_ISREG(details.st_mode):
                continue
            if current_time - float(details.st_mtime) < older_than_seconds:
                continue
            path.unlink()
            removed += 1
        except OSError as exc:
            logger.warning("陈旧隐藏成品清理失败: %s", exc)
    return removed


def _stage_hidden_copy(
    source: Path,
    target: Path,
    copy_file: Callable[[Path, Path], object],
) -> Path:
    try:
        source_path = Path(source).resolve(strict=True)
        if not source_path.is_file() or source_path.stat().st_size <= 0:
            raise OSError("source is not a regular non-empty file")
    except (OSError, RuntimeError, ValueError) as exc:
        raise _commit_failure(f"暂存来源不可用: {exc}") from exc

    hidden = target.parent / f".{target.name}.downany-{uuid4().hex}.tmp"
    try:
        copy_file(source_path, hidden)
        with hidden.open("r+b") as handle:
            handle.flush()
            os.fsync(handle.fileno())
        source_size = source_path.stat().st_size
        hidden_size = hidden.stat().st_size
        if source_size != hidden_size:
            raise OSError("copied size differs from source")
    except OutputVerificationFailed:
        raise
    except (OSError, RuntimeError, ValueError) as exc:
        raise _commit_failure(f"隐藏成品副本无法写入: {exc}") from exc
    return hidden


def _cleanup_attempt_hidden(paths: list[Path]) -> None:
    for path in paths:
        try:
            if path.exists() or path.is_symlink():
                path.unlink()
        except OSError as exc:
            logger.warning("冲突尝试的隐藏副本清理失败: %s", exc)


def _rollback_fingerprints(fingerprints: list[OutputFingerprint]) -> None:
    affected_directories: set[Path] = set()
    for fingerprint in reversed(fingerprints):
        if not _matches_fingerprint(fingerprint):
            continue
        try:
            fingerprint.path.unlink()
            affected_directories.add(fingerprint.path.parent)
        except OSError as exc:
            logger.warning("已发布成品回滚失败: %s", exc)
    for directory in affected_directories:
        _fsync_directory(directory)


def rollback_committed_output(committed: CommittedOutput) -> None:
    """Remove only unchanged paths proven to have been created by this commit."""
    _rollback_fingerprints(list(committed.created_fingerprints))


def _targets_exist(plan: FinalPathPlan) -> bool:
    return any(
        path.exists() or path.is_symlink()
        for path in (plan.main_file, *plan.subtitle_files)
    )


def commit_output_bundle(
    *,
    download_root: Path,
    playlist_folder: str,
    result: DownloadResult,
    copy_file: Callable[[Path, Path], object] = shutil.copyfile,
    publisher: Callable[[Path, Path], None] = publish_no_replace,
) -> CommittedOutput:
    """Publish a complete bundle without replacing an existing target."""
    requested_root = Path(download_root).expanduser().resolve(strict=False)
    lock = _root_lock(requested_root)
    subtitle_specs = tuple(
        (artifact.language, artifact.extension) for artifact in result.subtitles
    )
    source_paths = [artifact.path for artifact in result.subtitles]
    source_paths.append(result.main_file)

    with lock:
        for copy_index in count(1):
            plan = build_final_path_plan(
                requested_root,
                playlist_folder,
                result.rendered_leaf,
                result.source_key,
                subtitle_specs,
                copy_index=copy_index,
            )
            directory = _prepare_directory(plan)
            root = plan.root.resolve(strict=True)
            targets = [*plan.subtitle_files, plan.main_file]
            targets = [
                _validated_target(root, target, directory) for target in targets
            ]
            if _targets_exist(plan):
                continue

            cleanup_stale_hidden_files(directory)
            hidden_paths: list[Path] = []
            created: list[OutputFingerprint] = []
            try:
                for source, target in zip(source_paths, targets, strict=True):
                    hidden_paths.append(_stage_hidden_copy(source, target, copy_file))

                for hidden, target in zip(hidden_paths, targets, strict=True):
                    publisher(hidden, target)
                    if hidden.exists() or hidden.is_symlink():
                        try:
                            hidden.unlink()
                        except OSError as exc:
                            logger.warning("已发布隐藏副本清理失败: %s", exc)
                    created.append(_fingerprint(target))
            except FileExistsError:
                _rollback_fingerprints(created)
                _cleanup_attempt_hidden(hidden_paths)
                continue
            except Exception as exc:
                _rollback_fingerprints(created)
                if isinstance(exc, OutputVerificationFailed):
                    raise
                raise _commit_failure(f"原子发布不可用: {exc}") from exc

            _fsync_directory(directory)
            return CommittedOutput(
                main_file=plan.main_file,
                subtitle_files=plan.subtitle_files,
                created_fingerprints=tuple(created),
            )
