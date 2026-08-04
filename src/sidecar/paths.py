"""应用数据与日志路径（Sidecar / Electron 共用约定）。"""
from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path


def _env_with_legacy(new_key: str, legacy_key: str) -> str:
    """Prefer DOWNANY_*; fall back to VIDEODL_* once with a stderr warning."""
    value = (os.environ.get(new_key) or "").strip()
    if value:
        return value
    legacy = (os.environ.get(legacy_key) or "").strip()
    if legacy:
        sys.stderr.write(
            f"警告: {legacy_key} 已弃用，请改用 {new_key}\n"
        )
        return legacy
    return ""


@dataclass(frozen=True)
class AppPaths:
    data_dir: Path
    log_dir: Path

    @property
    def config_path(self) -> Path:
        return self.data_dir / "config.json"

    @property
    def history_db_path(self) -> Path:
        return self.data_dir / "history.db"

    @property
    def temp_dir(self) -> Path:
        return self.data_dir / "tmp"

    @classmethod
    def default(cls) -> "AppPaths":
        override = _env_with_legacy("DOWNANY_DATA_DIR", "VIDEODL_DATA_DIR")
        if override:
            data_dir = Path(override).expanduser().resolve()
            log_dir = data_dir / "logs"
            return cls(data_dir=data_dir, log_dir=log_dir)

        home = Path.home()
        data_dir = home / "Library" / "Application Support" / "Downany"
        log_dir = home / "Library" / "Logs" / "Downany"
        return cls(data_dir=data_dir, log_dir=log_dir)

    def ensure(self) -> "AppPaths":
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.log_dir.mkdir(parents=True, exist_ok=True)
        self.temp_dir.mkdir(parents=True, exist_ok=True)
        return self
