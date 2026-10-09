"""当前版本必须来自实际使用的 Python 引擎。"""
from yt_dlp.version import __version__ as imported_ytdlp_version

from src.sidecar.paths import AppPaths
from src.sidecar import ytdlp_updater as updater


def test_current_version_ignores_old_standalone(tmp_path):
    paths = AppPaths(data_dir=tmp_path / "data", log_dir=tmp_path / "logs")
    old_bin = paths.data_dir / "bin" / "yt-dlp"
    old_bin.parent.mkdir(parents=True)
    old_bin.write_text("#!/bin/sh\necho 2099.12.31\n", encoding="utf-8")
    old_bin.chmod(0o755)
    assert updater.current_version(paths) == imported_ytdlp_version


def test_current_version_does_not_launch_another_python(tmp_path, monkeypatch):
    paths = AppPaths(data_dir=tmp_path / "data", log_dir=tmp_path / "logs")

    def unexpected_subprocess(*_args, **_kwargs):
        raise AssertionError("version must describe this process")

    monkeypatch.setattr(updater.subprocess, "run", unexpected_subprocess)
    assert updater.current_version(paths) == imported_ytdlp_version


def test_current_version_uses_selected_runtime_metadata(tmp_path, monkeypatch):
    paths = AppPaths(data_dir=tmp_path / "data", log_dir=tmp_path / "logs")
    monkeypatch.setattr(updater, "current_engine", lambda: {
        "version": "2026.09.01", "source": "updated", "selection": "test-sha256",
    })
    assert updater.current_version(paths) == "2026.09.01"
