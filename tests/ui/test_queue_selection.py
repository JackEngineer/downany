"""队列增量刷新保留选中态。"""
from unittest.mock import MagicMock

from src.core.download_manager import DownloadManager
from src.core.download_task import DownloadOptions, DownloadTask, TaskStatus, VideoInfo
from src.ui.qt_manager_adapter import QtDownloadManager
from src.ui.tabs.queue_tab import QueueTab


def test_queue_refresh_preserves_selection(qtbot):
    config = MagicMock()
    config.get_concurrent_downloads.return_value = 1
    core = DownloadManager(config=config, db=MagicMock())
    mgr = QtDownloadManager(core)

    t1 = DownloadTask(video_info=VideoInfo(url="u1", title="one"), options=DownloadOptions())
    t2 = DownloadTask(video_info=VideoInfo(url="u2", title="two"), options=DownloadOptions())
    t1.status = TaskStatus.PENDING
    t2.status = TaskStatus.PENDING
    core.tasks[t1.id] = t1
    core.tasks[t2.id] = t2

    tab = QueueTab(mgr)
    qtbot.addWidget(tab)
    tab.refresh_table()
    tab.task_table.selectRow(0)
    selected = tab.get_selected_task_id()
    assert selected

    t1.progress = 42
    t1.speed = "1 MB/s"
    tab.refresh_table()
    assert tab.get_selected_task_id() == selected
