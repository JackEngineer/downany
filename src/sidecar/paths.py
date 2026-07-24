"""应用数据与日志路径（Sidecar / Electron 共用约定）。"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


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

    @classmethod
    def default(cls) -> "AppPaths":
        override = os.environ.get("VIDEODL_DATA_DIR")
        if override:
            data_dir = Path(override).expanduser().resolve()
            log_dir = data_dir / "logs"
            return cls(data_dir=data_dir, log_dir=log_dir)

        home = Path.home()
        data_dir = home / "Library" / "Application Support" / "VideoDownloader"
        log_dir = home / "Library" / "Logs" / "VideoDownloader"
        return cls(data_dir=data_dir, log_dir=log_dir)

    def ensure(self) -> "AppPaths":
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.log_dir.mkdir(parents=True, exist_ok=True)
        return self
