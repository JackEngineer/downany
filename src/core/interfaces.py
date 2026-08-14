"""核心对外部依赖的最小接口声明（Qt 无关）。"""
from __future__ import annotations

from typing import Optional, Protocol

from src.data.models import DownloadRecord
from src.core.download_task import DownloadTask


class DownloadConfig(Protocol):
    """下载核心需要的配置读取能力。"""

    def get_concurrent_downloads(self) -> int: ...

    def get_proxy_for_download(self) -> Optional[str]: ...


class HistoryWriter(Protocol):
    """下载核心需要的历史写入能力。"""

    def add_download_record(self, record: DownloadRecord) -> None: ...


class OutputReadySink(Protocol):
    """Receives the final file after download/post-processing completes."""

    def mark_processing(self, task: DownloadTask, owner_id: str, lease_expires_at: str) -> None: ...

    def mark_processing_failed(
        self,
        task: DownloadTask,
        owner_id: str,
        error_message: str,
    ) -> Optional[dict]: ...

    def renew_processing(self, task_id: str, owner_id: str, lease_expires_at: str) -> None: ...

    def mark_ready(self, task: DownloadTask, owner_id: Optional[str] = None, *, refresh_config: bool = False) -> Optional[dict]: ...
