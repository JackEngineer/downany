"""Opt-in queue harness: real managers/SQLite/files, deterministic network boundary."""
import hashlib
import threading
from collections import Counter
from pathlib import Path
from types import MappingProxyType
from unittest.mock import MagicMock

import pytest

from src.core.download_manager import DownloadManager
from src.core.download_task import DownloadTask, VideoInfo
from src.core.downloader import DownloadResult, SourceFacts
from src.core.media_verifier import MediaVerification
from src.data.json_config import JsonConfig
from src.data.queue_store import QueueStore
from src.sidecar.bin_paths import MediaToolchain


class QueueDownloadHarness:
    def __init__(self, root):
        self.root = root
        self.condition = threading.Condition()
        self.starts = Counter()
        self.live = Counter()
        self.peak_total = 0
        self.peak_per_id = Counter()
        self.plans = []
        self.before_download = lambda *_: None
        self.managers = []

    def manager(self, name="queue"):
        directory = self.root / name
        directory.mkdir(parents=True, exist_ok=True)
        config = JsonConfig(str(directory / "config.json"))
        config.set_download_dir(str(directory / "output"))
        manager = DownloadManager(config=config, db=MagicMock(),
                                  queue_store=QueueStore(str(directory / "queue.db")),
                                  temp_dir=str(directory / "staging"))
        manager.events.subscribe(self._notify)
        self.managers.append(manager)
        return manager

    def task(self, manager, task_id, **kwargs):
        return DownloadTask(id=task_id, video_info=VideoInfo(
            url=f"https://example.invalid/{task_id}.mp4", title=task_id,
            thumbnail_url="https://example.invalid/thumbnail.jpg",
        ), options=manager.config.build_download_options(), **kwargs)

    def _notify(self, *_args):
        with self.condition:
            self.condition.notify_all()

    def wait_for(self, predicate, timeout=10):
        with self.condition:
            assert self.condition.wait_for(predicate, timeout=timeout), "queue did not reach the expected state"

    def download(self, url, plan, staging_dir, progress):
        task_id = Path(staging_dir).name
        with self.condition:
            self.starts[task_id] += 1
            attempt = self.starts[task_id]
            self.live[task_id] += 1
            self.peak_total = max(self.peak_total, sum(self.live.values()))
            self.peak_per_id[task_id] = max(self.peak_per_id[task_id], self.live[task_id])
            self.plans.append(plan.to_ydl_options())
            self.condition.notify_all()
        try:
            self.before_download(task_id, attempt, progress)
            if progress:
                progress({"status": "downloading", "_percent_str": "99%",
                          "downloaded_bytes": 99, "total_bytes": 100})
            staging = Path(staging_dir)
            staging.mkdir(parents=True, exist_ok=True)
            output = staging / f"{task_id}.mp4"
            output.write_bytes(b"local-media:" + task_id.encode())
            return DownloadResult(output, (), MappingProxyType({"title": task_id}),
                                  output.name, hashlib.sha256(url.encode()).hexdigest(), True,
                                  SourceFacts((), False, False, False, True))
        finally:
            with self.condition:
                self.live[task_id] -= 1
                self.condition.notify_all()


@pytest.fixture
def queue_download_harness(tmp_path, monkeypatch):
    harness = QueueDownloadHarness(tmp_path)

    class ControlledDownloader:
        last_info = None

        def __init__(self):
            self.progress = None

        def set_callbacks(self, *, progress):
            self.progress = progress

        def download(self, url, plan, *, toolchain, staging_dir):
            return harness.download(url, plan, staging_dir, self.progress)

    monkeypatch.setattr("src.core.download_manager.Downloader", ControlledDownloader)
    monkeypatch.setattr("src.core.download_manager.VideoInfoExtractor.extract", lambda *_args, **_kwargs: None)
    monkeypatch.setattr("src.core.download_manager.resolve_media_toolchain", lambda **_: MediaToolchain(
        ffmpeg=tmp_path / "ffmpeg", ffprobe=tmp_path / "ffprobe", ffmpeg_location=tmp_path, source="test",
    ))
    monkeypatch.setattr("src.core.download_manager.verify_media", lambda *_args, **_kwargs:
                        MediaVerification("mp4", ("video",), (), False, False, 0))
    monkeypatch.setattr("src.core.download_manager.ensure_local_thumbnail", lambda *_args: "")
    monkeypatch.setattr("src.data.json_config.detect_system_proxy", lambda: None)
    monkeypatch.setenv("DOWNANY_DATA_DIR", str(tmp_path / "app-data"))
    yield harness
    for manager in harness.managers:
        manager.stop(join_timeout=5)
    assert not any(thread.is_alive() for manager in harness.managers for thread in manager.active_tasks.values())
