"""Qt 适配器信号转发测试。"""
from unittest.mock import MagicMock

import pytest
from PyQt6.QtCore import QCoreApplication

from src.core.download_manager import DownloadManager
from src.ui.qt_manager_adapter import QtDownloadManager


@pytest.fixture(scope="module")
def qapp():
    app = QCoreApplication.instance()
    if app is None:
        app = QCoreApplication([])
    return app


@pytest.fixture
def core_manager():
    config = MagicMock()
    config.get_concurrent_downloads.return_value = 1
    return DownloadManager(config=config, db=MagicMock())


def test_events_forwarded_as_signals(qapp, core_manager):
    adapter = QtDownloadManager(core_manager)
    received = {}
    adapter.task_added.connect(lambda tid: received.setdefault("added", tid))
    adapter.task_progress.connect(lambda tid, d: received.setdefault("progress", (tid, d)))
    adapter.task_failed.connect(lambda tid, err: received.setdefault("failed", (tid, err)))

    core_manager.events.emit("task_added", {"task_id": "t1"})
    core_manager.events.emit("task_progress", {"task_id": "t1", "progress": {"p": 1}})
    core_manager.events.emit("task_failed", {"task_id": "t1", "error": "boom"})
    QCoreApplication.processEvents()

    assert received["added"] == "t1"
    assert received["progress"] == ("t1", {"p": 1})
    assert received["failed"] == ("t1", "boom")


def test_methods_delegate_to_core(qapp, core_manager):
    adapter = QtDownloadManager(core_manager)
    assert adapter.get_all_tasks() == {}
    assert adapter.get_task("missing") is None
    assert adapter.remove_task("missing") is False
