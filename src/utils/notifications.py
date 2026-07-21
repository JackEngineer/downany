"""
系统级通知（macOS 优先）。
"""
from __future__ import annotations

import platform
import subprocess


def notify(title: str, body: str) -> None:
    """发送系统通知；失败时静默忽略。"""

    if platform.system() != "Darwin":
        return

    safe_title = (title or "").replace('"', '\\"')
    safe_body = (body or "").replace('"', '\\"')
    script = f'display notification "{safe_body}" with title "{safe_title}"'
    try:
        subprocess.run(
            ["osascript", "-e", script],
            check=False,
            capture_output=True,
            timeout=5,
        )
    except Exception:
        pass
