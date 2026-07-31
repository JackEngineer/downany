from __future__ import annotations

import zipfile
from pathlib import Path

from src.core.download_manager import DownloadManager
from src.core.download_task import DownloadTask, TaskStatus, VideoInfo
from src.sidecar.diagnostics import export_diagnostics
from src.sidecar.paths import AppPaths


def test_export_diagnostics_creates_zip(tmp_path: Path):
    paths = AppPaths(data_dir=tmp_path / "data", log_dir=tmp_path / "logs")
    paths.ensure()
    (paths.log_dir / "app.log").write_text("hello log\n", encoding="utf-8")

    manager = DownloadManager.__new__(DownloadManager)
    failed = DownloadTask(
        video_info=VideoInfo(url="https://example.com/x", title="fail"),
        status=TaskStatus.FAILED,
    )
    failed.error_message = "boom"
    manager._tasks = {failed.id: failed}  # noqa: SLF001
    manager.get_all_tasks = lambda: manager._tasks  # type: ignore[method-assign]

    result = export_diagnostics(paths, manager, output_dir=tmp_path / "out")
    assert result["ok"] is True
    zip_path = Path(result["path"])
    assert zip_path.is_file()
    assert result["failed_task_count"] == 1
    with zipfile.ZipFile(zip_path) as zf:
        names = set(zf.namelist())
    assert "environment.json" in names
    assert "failed_tasks.json" in names
    assert "logs/app.log" in names
