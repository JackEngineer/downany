"""yt-dlp 运行时健康检查（版本、JS 运行时等）。"""
from __future__ import annotations

import shutil
from typing import Any, Dict

from src.core.ytdlp_opts import ensure_js_runtime_path
from src.sidecar.paths import AppPaths
from src.sidecar.ytdlp_updater import current_version


def check_ytdlp_health(paths: AppPaths) -> Dict[str, Any]:
    """返回 version / deno_available / ok 摘要。"""
    ensure_js_runtime_path()
    version = current_version(paths)
    deno_available = bool(shutil.which("deno"))
    ok = version not in {"", "unknown"}
    return {
        "version": version,
        "deno_available": deno_available,
        "ok": ok,
    }
