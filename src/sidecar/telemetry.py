"""本地 opt-in 失败统计（仅写 telemetry.jsonl，不上报网络）。"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Any

from src.utils.logger import setup_logger

logger = setup_logger("Telemetry")


def _telemetry_path(config: Any) -> str:
    config_path = str(getattr(config, "path", "") or "")
    if config_path:
        return os.path.join(os.path.dirname(config_path), "telemetry.jsonl")
    return os.path.join(os.path.expanduser("~"), "telemetry.jsonl")


def maybe_report_failure(config: Any, error_code: str, platform: str) -> None:
    """若 config.telemetry_enabled 为真，追加一条本地记录。"""
    enabled = getattr(config, "is_telemetry_enabled", lambda: False)()
    if not enabled:
        return
    code = str(error_code or "unknown").strip() or "unknown"
    plat = str(platform or "unknown").strip() or "unknown"
    record = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "error_code": code,
        "platform": plat,
    }
    path = _telemetry_path(config)
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    try:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")
    except OSError as exc:
        logger.warning("写入 telemetry 失败: %s", exc)


def report_failure(config: Any, error_code: str, platform: str) -> None:
    """显式上报（仍受 telemetry_enabled 约束）。"""
    maybe_report_failure(config, error_code, platform)
