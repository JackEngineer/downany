"""bin 路径解析单测。"""
import os
from pathlib import Path

from src.sidecar.bin_paths import resolve_bundled_ytdlp_path, resolve_ffmpeg_path


def test_resolve_ffmpeg_from_env(tmp_path, monkeypatch):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    ffmpeg = bin_dir / "ffmpeg"
    ffmpeg.write_text("#!/bin/sh\necho ok\n", encoding="utf-8")
    ffmpeg.chmod(0o755)
    monkeypatch.setenv("DOWNANY_BIN_DIR", str(bin_dir))
    assert resolve_ffmpeg_path() == ffmpeg.resolve()


def test_resolve_ffmpeg_from_project_root(tmp_path, monkeypatch):
    monkeypatch.delenv("DOWNANY_BIN_DIR", raising=False)
    root = tmp_path / "repo"
    bin_dir = root / "bin"
    bin_dir.mkdir(parents=True)
    ffmpeg = bin_dir / "ffmpeg"
    ffmpeg.write_text("#!/bin/sh\necho ok\n", encoding="utf-8")
    ffmpeg.chmod(0o755)
    assert resolve_ffmpeg_path(project_root=root) == ffmpeg


def test_resolve_bundled_ytdlp(tmp_path, monkeypatch):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    ytdlp = bin_dir / "yt-dlp"
    ytdlp.write_text("#!/bin/sh\necho 1\n", encoding="utf-8")
    ytdlp.chmod(0o755)
    monkeypatch.setenv("DOWNANY_BIN_DIR", str(bin_dir))
    assert resolve_bundled_ytdlp_path() == ytdlp.resolve()


def test_missing_bin_returns_none(monkeypatch):
    monkeypatch.setenv("DOWNANY_BIN_DIR", "/tmp/downany-missing-bin-dir-xyz")
    assert resolve_ffmpeg_path() is None
    assert resolve_bundled_ytdlp_path() is None
