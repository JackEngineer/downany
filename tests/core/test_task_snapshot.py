"""TaskSnapshot 不可变性与内容测试。"""
import dataclasses
from unittest.mock import MagicMock

import pytest

from src.core.download_manager import DownloadManager
from src.core.download_task import (
    DownloadOptions,
    DownloadTask,
    Platform,
    TaskStatus,
    VideoInfo,
)


def _make_task():
    return DownloadTask(
        video_info=VideoInfo(
            url="https://example.com/v",
            title="示例视频",
            platform=Platform.YOUTUBE,
        ),
        options=DownloadOptions(output_path="/tmp"),
        status=TaskStatus.DOWNLOADING,
        progress=42.5,
        downloaded_bytes=1000,
        total_bytes=2000,
    )


def test_to_snapshot_copies_fields():
    task = _make_task()
    task.group_id = "g1"
    task.group_title = "合集"
    task.playlist_index = 3
    snap = task.to_snapshot()
    assert snap.id == task.id
    assert snap.url == "https://example.com/v"
    assert snap.title == "示例视频"
    assert snap.platform == "youtube"
    assert snap.status == "downloading"
    assert snap.progress == 42.5
    assert snap.downloaded_bytes == 1000
    assert snap.total_bytes == 2000
    assert snap.group_id == "g1"
    assert snap.group_title == "合集"
    assert snap.playlist_index == 3


def test_snapshot_is_immutable():
    snap = _make_task().to_snapshot()
    with pytest.raises(dataclasses.FrozenInstanceError):
        snap.progress = 99.0


def test_manager_get_snapshot_returns_all_tasks():
    config = MagicMock()
    config.get_concurrent_downloads.return_value = 1
    manager = DownloadManager(config=config, db=MagicMock())
    task = _make_task()
    with manager._lock:
        manager.tasks[task.id] = task
    snaps = manager.get_snapshot()
    assert len(snaps) == 1
    assert snaps[0].id == task.id
