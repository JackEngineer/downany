"""yt-dlp 更新器单测（mock 网络）。"""
import io
import json

import pytest

from src.sidecar.paths import AppPaths
from src.sidecar import ytdlp_updater as updater


class _FakeResp:
    def __init__(self, data: bytes):
        self._buf = io.BytesIO(data)

    def read(self, size: int = -1):
        return self._buf.read(size)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def test_check_update_parses_release(tmp_path, monkeypatch):
    paths = AppPaths(data_dir=tmp_path / "data", log_dir=tmp_path / "logs").ensure()
    monkeypatch.setattr(updater, "current_version", lambda _p: "2024.01.01")

    payload = {
        "tag_name": "2024.12.01",
        "assets": [
            {
                "name": "yt-dlp_macos",
                "browser_download_url": "https://example.com/yt-dlp_macos",
            }
        ],
    }

    def fake_open(req, timeout=30):
        return _FakeResp(json.dumps(payload).encode("utf-8"))

    info = updater.check_update(paths, opener=fake_open)
    assert info["updateAvailable"] is True
    assert info["latestVersion"] == "2024.12.01"
    assert info["downloadUrl"].endswith("yt-dlp_macos")


def test_update_rolls_back_on_bad_binary(tmp_path, monkeypatch):
    paths = AppPaths(data_dir=tmp_path / "data", log_dir=tmp_path / "logs").ensure()
    bin_dir = updater.ytdlp_bin_dir(paths)
    bin_dir.mkdir(parents=True)
    good = updater.ytdlp_path(paths)
    good.write_text("#!/bin/sh\necho 1.0.0\n", encoding="utf-8")
    good.chmod(0o755)

    monkeypatch.setattr(
        updater,
        "check_update",
        lambda _p, opener=None: {
            "downloadUrl": "https://example.com/bad",
            "currentVersion": "1.0.0",
            "latestVersion": "2.0.0",
            "updateAvailable": True,
        },
    )

    def fake_open(req, timeout=120):
        return _FakeResp(b"not-a-binary")

    def boom(_exe):
        raise RuntimeError("bad binary")

    monkeypatch.setattr(updater, "_run_version", boom)

    with pytest.raises(RuntimeError):
        updater.update_ytdlp(paths, opener=fake_open)

    assert good.is_file()
