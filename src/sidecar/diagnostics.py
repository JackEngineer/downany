"""Build a zip diagnostics bundle for support / debugging."""
from __future__ import annotations

import json
import platform
import re
import subprocess
import sys
import tempfile
import zipfile
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from src.core.download_task import Platform, TaskStatus
from src.core.error_codes import ALL_ERROR_CODES, UNKNOWN
from src.sidecar.bin_paths import resolve_ffmpeg_path
from src.sidecar.paths import AppPaths
from src.sidecar.protocol import APP_NAME, APP_VERSION
from src.sidecar.ytdlp_updater import resolve_ytdlp_executable


_LOG_LEVEL_RE = re.compile(r"\s-\s(DEBUG|INFO|WARNING|ERROR|CRITICAL)\s-\s")
_VERSION_TOKEN_RE = re.compile(r"^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$")
_FFMPEG_VERSION_RE = re.compile(r"^ffmpeg version\s+([^\s]+)", re.IGNORECASE)
_PLATFORM_VALUES = frozenset(item.value for item in Platform)
_PRIVACY_SUMMARY: Dict[str, Any] = {
    "schema_version": 1,
    "raw_content_included": False,
    "included": ["应用与运行环境版本", "失败类型统计", "日志级别统计"],
    "excluded": [
        "下载链接",
        "内容标题",
        "错误正文",
        "日志正文",
        "Cookie 与 Token",
        "本机路径",
    ],
}


def _run_version(cmd: List[str]) -> str:
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        out = (proc.stdout or proc.stderr or "").strip()
        return out.splitlines()[0] if out else f"(exit {proc.returncode})"
    except Exception:  # noqa: BLE001 — diagnostics must not raise
        return "unavailable"


def _safe_version_token(value: str) -> str:
    token = str(value or "").strip()
    return token if _VERSION_TOKEN_RE.fullmatch(token) else "unavailable"


def _safe_ffmpeg_version(value: str) -> str:
    match = _FFMPEG_VERSION_RE.match(str(value or "").strip())
    return _safe_version_token(match.group(1)) if match else "unavailable"


def collect_environment(paths: AppPaths) -> Dict[str, Any]:
    ytdlp = resolve_ytdlp_executable(paths)
    ffmpeg = resolve_ffmpeg_path()
    if ytdlp:
        ytdlp_source = "bundled"
        ytdlp_version = _safe_version_token(_run_version([ytdlp, "--version"]))
    else:
        ytdlp_source = "python_module"
        ytdlp_version = _safe_version_token(
            _run_version([sys.executable, "-m", "yt_dlp", "--version"])
        )
    return {
        "app": APP_NAME,
        "app_version": APP_VERSION,
        "python": platform.python_version(),
        "platform": platform.platform(),
        "machine": platform.machine(),
        "ytdlp_source": ytdlp_source,
        "ytdlp_version": ytdlp_version,
        "ffmpeg_available": ffmpeg is not None,
        "ffmpeg_version": (
            _safe_ffmpeg_version(_run_version([str(ffmpeg), "-version"]))
            if ffmpeg
            else "missing"
        ),
        "collected_at": datetime.now(timezone.utc).isoformat(),
    }


def _recent_log_files(log_dir: Path, *, max_files: int) -> List[Path]:
    if not log_dir.is_dir():
        return []
    candidates: List[tuple[float, Path]] = []
    try:
        entries = list(log_dir.iterdir())
    except OSError:
        return []
    for path in entries:
        try:
            if path.is_symlink() or not path.is_file():
                continue
            candidates.append((path.stat().st_mtime, path))
        except OSError:
            continue
    candidates.sort(key=lambda item: item[0], reverse=True)
    return [path for _, path in candidates[:max_files]]


def _summarize_recent_logs(log_dir: Path, *, max_files: int = 5) -> Dict[str, Any]:
    files = _recent_log_files(log_dir, max_files=max_files)
    levels: Counter[str] = Counter()
    files_read = 0
    line_count = 0
    for path in files:
        try:
            with path.open("r", encoding="utf-8", errors="replace") as handle:
                for line in handle:
                    line_count += 1
                    match = _LOG_LEVEL_RE.search(line)
                    levels[match.group(1).lower() if match else "other"] += 1
            files_read += 1
        except OSError:
            continue
    return {
        "files_seen": len(files),
        "files_read": files_read,
        "lines": line_count,
        "levels": dict(sorted(levels.items())),
    }


def _failed_task_summary(manager: Any) -> Dict[str, Any]:
    by_error_code: Counter[str] = Counter()
    by_platform: Counter[str] = Counter()
    for task in manager.get_all_tasks().values():
        if task.status != TaskStatus.FAILED:
            continue
        raw_error_code = str(getattr(task, "error_code", "") or "").strip()
        error_code = raw_error_code if raw_error_code in ALL_ERROR_CODES else UNKNOWN
        platform_value = getattr(getattr(task, "video_info", None), "platform", None)
        raw_platform = str(getattr(platform_value, "value", "") or "").strip()
        platform_name = raw_platform if raw_platform in _PLATFORM_VALUES else Platform.UNKNOWN.value
        by_error_code[error_code] += 1
        by_platform[platform_name] += 1
    return {
        "total": sum(by_error_code.values()),
        "by_error_code": dict(sorted(by_error_code.items())),
        "by_platform": dict(sorted(by_platform.items())),
    }


def export_diagnostics(
    paths: AppPaths,
    manager: Any,
    *,
    output_dir: Optional[Path] = None,
) -> Dict[str, Any]:
    """Write a zip under output_dir (default: data_dir/diagnostics) and return metadata."""
    paths.ensure()
    out_root = Path(output_dir) if output_dir else paths.data_dir / "diagnostics"
    out_root.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    zip_path = out_root / f"diagnostics-{stamp}.zip"

    env = collect_environment(paths)
    failed = _failed_task_summary(manager)
    log_summary = _summarize_recent_logs(paths.log_dir)

    with tempfile.TemporaryDirectory(prefix="downany-diag-") as tmp:
        tmp_path = Path(tmp)
        (tmp_path / "environment.json").write_text(
            json.dumps(env, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        (tmp_path / "failed_tasks.json").write_text(
            json.dumps(failed, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        logs_dir = tmp_path / "logs"
        logs_dir.mkdir(parents=True, exist_ok=True)
        (logs_dir / "summary.json").write_text(
            json.dumps(log_summary, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        (tmp_path / "privacy.json").write_text(
            json.dumps(_PRIVACY_SUMMARY, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for path in tmp_path.rglob("*"):
                if path.is_file():
                    zf.write(path, arcname=str(path.relative_to(tmp_path)))

    return {
        "ok": True,
        "path": str(zip_path),
        "log_files": [],
        "log_summary": log_summary,
        "failed_task_count": failed["total"],
        "environment": env,
    }
