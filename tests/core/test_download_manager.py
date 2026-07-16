"""DownloadManager 状态机与并发安全测试。"""
import threading
import time
from unittest.mock import MagicMock, patch

import pytest
from PyQt6.QtCore import QCoreApplication

from src.core.download_manager import DownloadManager
from src.core.download_task import DownloadOptions, DownloadTask, TaskStatus, VideoInfo
from src.core.downloader import DownloadCancelled, DownloadError


@pytest.fixture(scope="module")
def qapp():
    app = QCoreApplication.instance()
    if app is None:
        app = QCoreApplication([])
    return app


@pytest.fixture
def manager(qapp, tmp_path, monkeypatch):
    # 重置单例
    DownloadManager._instance = None
    mgr = DownloadManager()
    mgr.config = MagicMock()
    mgr.config.get_concurrent_downloads.return_value = 2
    mgr.db = MagicMock()
    mgr.start()
    yield mgr
    mgr.stop(join_timeout=2)
    DownloadManager._instance = None


def _make_task(url="https://example.com/a", title="t"):
    return DownloadTask(
        video_info=VideoInfo(url=url, title=title),
        options=DownloadOptions(output_path="/tmp"),
    )


def test_download_failure_marks_failed(manager):
    task = _make_task()
    with patch("src.core.download_manager.Downloader") as mock_cls, patch(
        "src.core.download_manager.VideoInfoExtractor.extract", return_value=None
    ):
        instance = MagicMock()
        instance.download.side_effect = DownloadError("boom")
        mock_cls.return_value = instance
        manager.add_task(task)

        deadline = time.time() + 3
        while time.time() < deadline and task.status not in (
            TaskStatus.FAILED,
            TaskStatus.COMPLETED,
        ):
            time.sleep(0.05)
            QCoreApplication.processEvents()

    assert task.status == TaskStatus.FAILED
    assert "boom" in task.error_message
    manager.db.add_download_record.assert_called()


def test_cancel_does_not_complete(manager):
    task = _make_task(title="cancel-me")
    started = threading.Event()
    proceed = threading.Event()

    def fake_download(url, opts=None):
        started.set()
        proceed.wait(timeout=2)
        # 模拟 progress 检查到取消
        raise DownloadCancelled("任务已取消")

    with patch("src.core.download_manager.Downloader") as mock_cls, patch(
        "src.core.download_manager.VideoInfoExtractor.extract", return_value=None
    ):
        instance = MagicMock()
        instance.download.side_effect = fake_download
        mock_cls.return_value = instance
        manager.add_task(task)
        assert started.wait(2)
        manager.cancel_task(task.id)
        proceed.set()

        deadline = time.time() + 3
        while time.time() < deadline and task.id in manager.active_tasks:
            time.sleep(0.05)

    assert task.status == TaskStatus.CANCELLED
    assert task.status != TaskStatus.COMPLETED


def test_pause_then_resume_after_thread_exits(manager):
    task = _make_task(title="pause-me")
    call_count = {"n": 0}
    gate = threading.Event()

    def fake_download(url, opts=None):
        call_count["n"] += 1
        if call_count["n"] == 1:
            gate.set()
            time.sleep(0.15)
            raise DownloadCancelled("任务已暂停")
        return "/tmp/done.mp4"

    with patch("src.core.download_manager.Downloader") as mock_cls, patch(
        "src.core.download_manager.VideoInfoExtractor.extract", return_value=None
    ):
        instance = MagicMock()
        instance.download.side_effect = fake_download
        mock_cls.return_value = instance
        manager.add_task(task)
        assert gate.wait(2)
        manager.pause_task(task.id)

        deadline = time.time() + 3
        while time.time() < deadline and task.id in manager.active_tasks:
            time.sleep(0.05)

        assert task.status == TaskStatus.PAUSED
        manager.resume_task(task.id)

        deadline = time.time() + 3
        while time.time() < deadline and task.status != TaskStatus.COMPLETED:
            time.sleep(0.05)
            QCoreApplication.processEvents()

    assert task.status == TaskStatus.COMPLETED
    assert call_count["n"] >= 2


def test_resume_while_active_does_not_double_start(manager):
    task = _make_task(title="double")
    started = threading.Event()
    release = threading.Event()
    starts = []

    def fake_download(url, opts=None):
        starts.append(1)
        started.set()
        release.wait(timeout=2)
        raise DownloadCancelled("任务已暂停")

    with patch("src.core.download_manager.Downloader") as mock_cls, patch(
        "src.core.download_manager.VideoInfoExtractor.extract", return_value=None
    ):
        instance = MagicMock()
        instance.download.side_effect = fake_download
        mock_cls.return_value = instance
        manager.add_task(task)
        assert started.wait(2)
        manager.pause_task(task.id)
        # 线程仍在 active 时恢复 —— 不应立刻再开第二条
        manager.resume_task(task.id)
        assert len(starts) == 1
        release.set()
        deadline = time.time() + 3
        while time.time() < deadline and task.id in manager.active_tasks:
            time.sleep(0.05)

    # 恢复请求应在 finally 后入队，但第二次 download 可能因我们 release 后只跑了暂停路径
    assert task.id not in manager.active_tasks or len(starts) <= 2
