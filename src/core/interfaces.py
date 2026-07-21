"""核心对外部依赖的最小接口声明（Qt 无关）。"""
from __future__ import annotations

from typing import Protocol

from src.data.models import DownloadRecord


class DownloadConfig(Protocol):
    """下载核心需要的配置读取能力。"""

    def get_concurrent_downloads(self) -> int: ...


class HistoryWriter(Protocol):
    """下载核心需要的历史写入能力。"""

    def add_download_record(self, record: DownloadRecord) -> None: ...
