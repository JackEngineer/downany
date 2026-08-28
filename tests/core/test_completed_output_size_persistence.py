"""Final output sizes survive reopening the real history and queue stores."""
from pathlib import Path
from types import MappingProxyType, SimpleNamespace

import pytest

from src.core import download_manager as manager_module
from src.core.download_manager import DownloadManager
from src.core.download_task import DownloadOptions, DownloadTask, TaskStatus, VideoInfo
from src.core.downloader import DownloadResult, SourceFacts
from src.core.media_verifier import MediaVerification
from src.data.database import HistoryDB
from src.data.queue_store import QueueStore
from src.sidecar.bin_paths import MediaToolchain


class _Config:
    def get_concurrent_downloads(self):
        return 1

    def get_proxy_for_download(self):
        return None


@pytest.mark.parametrize(
    ("mode", "expected_size"),
    [("audio", 22), ("script", 19)],
    ids=["converted_audio", "script_changes_size"],
)
def test_final_output_size_survives_database_reopen(tmp_path, monkeypatch, mode, expected_size):
    monkeypatch.setenv("DOWNANY_DATA_DIR", str(tmp_path / "app-data"))
    monkeypatch.setattr(HistoryDB, "_instance", None)
    database_path = str(tmp_path / "history.db")
    history = HistoryDB(db_path=database_path)
    suffix = ".mp3" if mode == "audio" else ".mp4"
    task = DownloadTask(
        id="size-persistence",
        video_info=VideoInfo(
            url=f"https://example.invalid/fixture{suffix}",
            title="大小持久化验收",
            file_size=7,
        ),
        options=DownloadOptions(
            output_path=str(tmp_path / "downloads"),
            embed_metadata=False,
            audio_only=mode == "audio",
            postprocessing="script" if mode == "script" else "none",
            postprocess_script="test-output {file}" if mode == "script" else "",
        ),
        downloaded_bytes=5,
        total_bytes=9,
    )

    class FixtureDownloader:
        last_info = None

        def set_callbacks(self, **_kwargs):
            pass

        def download(self, _url, _plan, *, toolchain, staging_dir):
            staging = Path(staging_dir)
            staging.mkdir(parents=True, exist_ok=True)
            media = staging / f"fixture{suffix}"
            media.write_bytes(b"before" if mode == "script" else b"final-output-is-larger")
            return DownloadResult(
                main_file=media,
                subtitles=(),
                info=MappingProxyType({"title": "大小持久化验收", "filepath": str(media)}),
                rendered_leaf=f"fixture{suffix}",
                source_key="size-fixture",
                downloaded_this_run=True,
                source_facts=SourceFacts((), False, False, False, True),
            )

    toolchain = MediaToolchain(
        ffmpeg=tmp_path / "ffmpeg",
        ffprobe=tmp_path / "ffprobe",
        ffmpeg_location=tmp_path,
        source="test",
    )
    def run_script(command, **_kwargs):
        assert mode == "script" and isinstance(command, str)
        assert command.startswith("test-output ")
        Path(task.file_path).write_bytes(b"after-script-output")
        return SimpleNamespace(returncode=0, stderr="")

    # Both cases reject every external command except the explicit script stub.
    monkeypatch.setattr(manager_module.subprocess, "run", run_script)
    monkeypatch.setattr(manager_module, "Downloader", FixtureDownloader)
    monkeypatch.setattr(manager_module, "resolve_media_toolchain", lambda **_kwargs: toolchain)
    monkeypatch.setattr(manager_module, "ensure_local_thumbnail", lambda *_args, **_kwargs: "")
    monkeypatch.setattr(
        manager_module.VideoInfoExtractor, "extract", lambda *_args, **_kwargs: None
    )
    monkeypatch.setattr(
        manager_module,
        "verify_media",
        lambda *_args, **_kwargs: MediaVerification(
            "mp3" if mode == "audio" else "mp4",
            ("audio",) if mode == "audio" else ("video",),
            (), False, False, 0,
        ),
    )

    manager = DownloadManager(
        config=_Config(), db=history,
        queue_store=QueueStore(database_path),
        temp_dir=str(tmp_path / "staging"),
    )
    manager.add_task(task)
    manager._download_task(task)
    assert task.status is TaskStatus.COMPLETED, task.error_message
    assert Path(task.file_path).stat().st_size == expected_size

    monkeypatch.setattr(HistoryDB, "_instance", None)
    reopened_history = HistoryDB(db_path=database_path)
    assert reopened_history is not history
    reopened_manager = DownloadManager(
        config=_Config(), db=reopened_history,
        queue_store=QueueStore(database_path),
        temp_dir=str(tmp_path / "staging"),
    )
    reopened_manager.restore_tasks()
    record = reopened_history.get_download_record(task.id)
    assert record is not None
    assert record.status == "completed"
    assert record.file_size == expected_size
    assert record.file_path == task.file_path
    restored = reopened_manager.get_task(task.id)
    assert restored is not None and restored is not task
    assert restored.status is TaskStatus.COMPLETED
    assert restored.file_path == task.file_path
    assert restored.downloaded_bytes == expected_size
    assert restored.total_bytes == expected_size
    assert restored.video_info.file_size == expected_size
    snapshot = reopened_manager.get_snapshot()[0]
    assert snapshot.status == "completed"
    assert snapshot.downloaded_bytes == expected_size
    assert snapshot.total_bytes == expected_size
    assert snapshot.file_path == task.file_path
