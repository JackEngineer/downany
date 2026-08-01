"""Build a zip diagnostics bundle for support / debugging."""
from __future__ import annotations

import json
import platform
import shutil
import subprocess
import sys
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from src.core.download_task import TaskStatus
from src.sidecar.bin_paths import resolve_ffmpeg_path
from src.sidecar.paths import AppPaths
from src.sidecar.protocol import APP_NAME, APP_VERSION
from src.sidecar.ytdlp_updater import resolve_ytdlp_executable


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
    except Exception as exc:  # noqa: BLE001 — diagnostics must not raise
        return f"error: {exc}"


def collect_environment(paths: AppPaths) -> Dict[str, Any]:
    ytdlp = resolve_ytdlp_executable(paths)
    ffmpeg = resolve_ffmpeg_path()
    if ytdlp:
        ytdlp_version = _run_version([ytdlp, "--version"])
    else:
        ytdlp_version = _run_version([sys.executable, "-m", "yt_dlp", "--version"])
    return {
        "app": APP_NAME,
        "app_version": APP_VERSION,
        "python": sys.version,
        "platform": platform.platform(),
        "machine": platform.machine(),
        "ytdlp_executable": ytdlp or f"{sys.executable} -m yt_dlp",
        "ytdlp_version": ytdlp_version,
        "ffmpeg_path": str(ffmpeg) if ffmpeg else "",
        "ffmpeg_version": _run_version([str(ffmpeg), "-version"]) if ffmpeg else "missing",
        "collected_at": datetime.now(timezone.utc).isoformat(),
    }


def _copy_recent_logs(log_dir: Path, dest: Path, *, max_files: int = 5) -> List[str]:
    dest.mkdir(parents=True, exist_ok=True)
    if not log_dir.is_dir():
        return []
    files = sorted(
        [p for p in log_dir.iterdir() if p.is_file()],
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )[:max_files]
    names: List[str] = []
    for src in files:
        target = dest / src.name
        try:
            shutil.copy2(src, target)
            names.append(src.name)
        except OSError:
            continue
    return names


def _failed_task_summaries(manager: Any) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    for task in manager.get_all_tasks().values():
        if task.status != TaskStatus.FAILED:
            continue
        rows.append(
            {
                "id": task.id,
                "url": task.video_info.url,
                "title": task.video_info.title,
                "platform": task.video_info.platform.value,
                "error_message": task.error_message,
                "error_code": getattr(task, "error_code", "") or "",
                "created_at": task.created_at.isoformat() if task.created_at else None,
            }
        )
    return rows


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
    failed = _failed_task_summaries(manager)

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
        log_names = _copy_recent_logs(paths.log_dir, tmp_path / "logs")
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for path in tmp_path.rglob("*"):
                if path.is_file():
                    zf.write(path, arcname=str(path.relative_to(tmp_path)))

    return {
        "ok": True,
        "path": str(zip_path),
        "log_files": log_names,
        "failed_task_count": len(failed),
        "environment": env,
    }
