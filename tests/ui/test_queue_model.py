"""队列表格模型测试。"""
from src.core.download_task import DownloadTask, VideoInfo
from src.ui.tabs.queue_model import QueueTableModel, format_bytes, progress_label


class DummyManager:
    def __init__(self, tasks=None):
        self._tasks = tasks or {}

    def get_all_tasks(self):
        return dict(self._tasks)

    def get_task(self, task_id):
        return self._tasks.get(task_id)


def test_format_bytes():
    assert format_bytes(0) == "0 B"
    assert "KB" in format_bytes(2048)


def test_download_task_bytes_in_progress_label():
    task = DownloadTask(
        video_info=VideoInfo(url="https://example.com"),
        progress=50.0,
        downloaded_bytes=512,
        total_bytes=1024,
    )
    label = progress_label(task)
    assert "50%" in label
    assert "/" in label


def test_queue_table_model_refresh_structure():
    task = DownloadTask(video_info=VideoInfo(url="https://example.com/v"))
    manager = DummyManager({task.id: task})
    model = QueueTableModel(manager)
    model.refresh_structure()
    assert model.rowCount() == 1
    assert model.task_id_at(0) == task.id
