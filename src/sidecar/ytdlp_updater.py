"""yt-dlp 独立更新：检查、下载、自检、失败回退。"""
from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import sys
import urllib.request
from pathlib import Path
from typing import Any, Dict, Optional

from src.sidecar.bin_paths import resolve_bundled_ytdlp_path
from src.sidecar.paths import AppPaths
from src.utils.logger import setup_logger

logger = setup_logger("YtDlpUpdater")

RELEASE_API = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest"


def release_asset_name() -> str:
    if sys.platform == "win32":
        return "yt-dlp.exe"
    if sys.platform == "darwin":
        return "yt-dlp_macos"
    return "yt-dlp"


def ytdlp_bin_dir(paths: AppPaths) -> Path:
    return paths.data_dir / "bin"


def ytdlp_path(paths: AppPaths) -> Path:
    name = "yt-dlp.exe" if sys.platform == "win32" else "yt-dlp"
    return ytdlp_bin_dir(paths) / name


def resolve_ytdlp_executable(paths: AppPaths) -> str:
    """优先用户更新版，其次打包保底二进制，否则空（走 Python 模块）。"""
    candidate = ytdlp_path(paths)
    if candidate.is_file() and os.access(candidate, os.X_OK):
        return str(candidate)
    bundled = resolve_bundled_ytdlp_path()
    if bundled is not None:
        return str(bundled)
    return ""


def _run_version(executable: str) -> str:
    if executable:
        proc = subprocess.run(
            [executable, "--version"],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    else:
        proc = subprocess.run(
            ["python", "-m", "yt_dlp", "--version"],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or "无法读取 yt-dlp 版本")
    return (proc.stdout or "").strip().splitlines()[0].strip()


def current_version(paths: AppPaths) -> str:
    exe = resolve_ytdlp_executable(paths)
    try:
        if exe:
            return _run_version(exe)
        # 回退到环境中的 yt-dlp 模块
        proc = subprocess.run(
            [os.environ.get("DOWNANY_PYTHON") or os.environ.get("VIDEODL_PYTHON") or "python3", "-m", "yt_dlp", "--version"],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        if proc.returncode != 0:
            return "unknown"
        return (proc.stdout or "").strip().splitlines()[0].strip()
    except Exception:
        return "unknown"


def check_update(paths: AppPaths, *, opener=urllib.request.urlopen) -> Dict[str, Any]:
    current = current_version(paths)
    req = urllib.request.Request(
        RELEASE_API,
        headers={"User-Agent": "Downany/0.1", "Accept": "application/vnd.github+json"},
    )
    with opener(req, timeout=30) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    tag = str(data.get("tag_name") or "").lstrip("v")
    assets = data.get("assets") or []
    download_url = ""
    for asset in assets:
        if asset.get("name") == release_asset_name():
            download_url = asset.get("browser_download_url") or ""
            break
    if not download_url:
        # universal binary name fallback
        for asset in assets:
            name = str(asset.get("name") or "")
            if name == "yt-dlp" or name.endswith("_macos"):
                download_url = asset.get("browser_download_url") or ""
                if download_url:
                    break
    return {
        "currentVersion": current,
        "latestVersion": tag or "unknown",
        "updateAvailable": bool(tag) and tag != current and bool(download_url),
        "downloadUrl": download_url,
    }


def update_ytdlp(
    paths: AppPaths,
    *,
    download_url: Optional[str] = None,
    opener=urllib.request.urlopen,
) -> Dict[str, Any]:
    paths.ensure()
    info = check_update(paths, opener=opener)
    url = download_url or info.get("downloadUrl")
    if not url:
        raise RuntimeError("未找到可下载的 yt-dlp 发布资源")

    bin_dir = ytdlp_bin_dir(paths)
    bin_dir.mkdir(parents=True, exist_ok=True)
    target = ytdlp_path(paths)
    backup = bin_dir / "yt-dlp.bak"
    tmp = bin_dir / "yt-dlp.download"

    if target.is_file():
        shutil.copy2(target, backup)

    req = urllib.request.Request(url, headers={"User-Agent": "Downany/0.1"})
    try:
        with opener(req, timeout=120) as resp, tmp.open("wb") as out:
            shutil.copyfileobj(resp, out)
        tmp.chmod(tmp.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        # 自检
        version = _run_version(str(tmp))
        os.replace(tmp, target)
        if backup.is_file():
            backup.unlink(missing_ok=True)
        return {
            "ok": True,
            "version": version,
            "path": str(target),
        }
    except Exception as exc:
        if tmp.is_file():
            tmp.unlink(missing_ok=True)
        if backup.is_file() and not target.is_file():
            shutil.copy2(backup, target)
        logger.error("yt-dlp 更新失败，已回退: %s", exc)
        raise RuntimeError(f"更新失败并已回退: {exc}") from exc
