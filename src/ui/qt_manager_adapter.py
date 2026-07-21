"""把 Qt 无关的 DownloadManager 适配为带 pyqtSignal 的对象，供现有界面使用。"""
from __future__ import annotations

from typing import Any, Dict, Optional

from PyQt6.QtCore import QObject, pyqtSignal

from src.core.download_manager import DownloadManager
from src.core.download_task import DownloadTask
from src.data.config_manager import ConfigManager
from src.data.database import HistoryDB


class QtDownloadManager(QObject):
    """信号与方法签名同旧版 DownloadManager，内部委托核心管理器。"""

    task_added = pyqtSignal(str)
    task_started = pyqtSignal(str)
    task_progress = pyqtSignal(str, dict)
    task_completed = pyqtSignal(str)
    task_failed = pyqtSignal(str, str)
    task_paused = pyqtSignal(str)
    task_cancelled = pyqtSignal(str)

    def __init__(self, manager: DownloadManager, parent: Optional[QObject] = None):
        super().__init__(parent)
        self._manager = manager
        self._unsubscribe = manager.events.subscribe(self._on_core_event)

    def _on_core_event(self, event: str, payload: Dict[str, Any]) -> None:
        task_id = payload.get("task_id", "")
        if event == "task_added":
            self.task_added.emit(task_id)
        elif event == "task_started":
            self.task_started.emit(task_id)
        elif event == "task_progress":
            self.task_progress.emit(task_id, payload.get("progress", {}))
        elif event == "task_completed":
            self.task_completed.emit(task_id)
        elif event == "task_failed":
            self.task_failed.emit(task_id, payload.get("error", ""))
        elif event == "task_paused":
            self.task_paused.emit(task_id)
        elif event == "task_cancelled":
            self.task_cancelled.emit(task_id)

    def start(self) -> None:
        self._manager.start()

    def stop(self, join_timeout: float = 5.0) -> None:
        self._manager.stop(join_timeout=join_timeout)

    def add_task(self, task: DownloadTask) -> None:
        self._manager.add_task(task)

    def pause_task(self, task_id: str) -> None:
        self._manager.pause_task(task_id)

    def resume_task(self, task_id: str) -> None:
        self._manager.resume_task(task_id)

    def cancel_task(self, task_id: str) -> None:
        self._manager.cancel_task(task_id)

    def retry_task(self, task_id: str) -> None:
        self._manager.retry_task(task_id)

    def get_task(self, task_id: str) -> Optional[DownloadTask]:
        return self._manager.get_task(task_id)

    def get_all_tasks(self) -> Dict[str, DownloadTask]:
        return self._manager.get_all_tasks()

    def remove_task(self, task_id: str) -> bool:
        return self._manager.remove_task(task_id)


def create_default_manager() -> QtDownloadManager:
    """PyQt 应用的默认装配：真实配置 + 真实历史库。"""
    core = DownloadManager(config=ConfigManager(), db=HistoryDB())
    return QtDownloadManager(core)
