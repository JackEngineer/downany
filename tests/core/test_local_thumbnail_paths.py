import sys
from pathlib import Path

from src.core.local_thumbnail import default_data_dir


def test_default_data_dir_windows(tmp_path, monkeypatch):
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "LA"))
    monkeypatch.delenv("DOWNANY_DATA_DIR", raising=False)
    monkeypatch.delenv("VIDEODL_DATA_DIR", raising=False)
    assert default_data_dir() == (tmp_path / "LA" / "Downany").resolve()
