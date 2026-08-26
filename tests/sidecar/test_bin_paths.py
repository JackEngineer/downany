"""bin 路径解析单测。"""
import os
import sys
from pathlib import Path

from src.sidecar import bin_paths
from src.sidecar.bin_paths import (
    resolve_bundled_ytdlp_path,
    resolve_ffmpeg_path,
    resolve_ffprobe_path,
    resolve_media_toolchain,
)


def executable_name(base: str) -> str:
    return f"{base}.exe" if sys.platform == "win32" else base


def make_executable(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"MZ" if path.suffix == ".exe" else b"#!/bin/sh\nexit 0\n")
    path.chmod(0o755)
    return path


def clear_tool_sources(monkeypatch) -> None:
    monkeypatch.delenv("DOWNANY_BIN_DIR", raising=False)
    monkeypatch.delenv("VIDEODL_BIN_DIR", raising=False)
    monkeypatch.setenv("PATH", "")
    monkeypatch.delattr(bin_paths.sys, "frozen", raising=False)


def test_resolve_ffmpeg_from_env(tmp_path, monkeypatch):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    ffmpeg = bin_dir / "ffmpeg"
    ffmpeg.write_text("#!/bin/sh\necho ok\n", encoding="utf-8")
    ffmpeg.chmod(0o755)
    monkeypatch.setenv("DOWNANY_BIN_DIR", str(bin_dir))
    assert resolve_ffmpeg_path() == ffmpeg.resolve()


def test_resolve_ffmpeg_from_project_root(tmp_path, monkeypatch):
    clear_tool_sources(monkeypatch)
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
    monkeypatch.setenv("PATH", "")
    assert resolve_ffmpeg_path() is None
    assert resolve_ffprobe_path() is None
    assert resolve_media_toolchain() is None
    assert resolve_bundled_ytdlp_path() is None


def test_resolve_ffmpeg_exe_on_windows(tmp_path, monkeypatch):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    ffmpeg = bin_dir / "ffmpeg.exe"
    ffmpeg.write_bytes(b"MZ")
    ffmpeg.chmod(0o755)
    monkeypatch.setenv("DOWNANY_BIN_DIR", str(bin_dir))
    assert resolve_ffmpeg_path() == ffmpeg.resolve()


def test_resolve_bundled_ytdlp_exe(tmp_path, monkeypatch):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    ytdlp = bin_dir / "yt-dlp.exe"
    ytdlp.write_bytes(b"MZ")
    ytdlp.chmod(0o755)
    monkeypatch.setenv("DOWNANY_BIN_DIR", str(bin_dir))
    assert resolve_bundled_ytdlp_path() == ytdlp.resolve()


def test_env_requires_both_tools_from_the_same_directory(tmp_path, monkeypatch):
    clear_tool_sources(monkeypatch)
    bin_dir = tmp_path / "env-bin"
    ffmpeg = make_executable(bin_dir / executable_name("ffmpeg"))
    monkeypatch.setenv("DOWNANY_BIN_DIR", str(bin_dir))

    assert resolve_media_toolchain(project_root=tmp_path) is None
    assert resolve_ffmpeg_path(project_root=tmp_path) == ffmpeg.resolve()

    ffprobe = make_executable(bin_dir / executable_name("ffprobe"))
    pair = resolve_media_toolchain(project_root=tmp_path)

    assert pair is not None
    assert pair.ffmpeg == ffmpeg.resolve()
    assert pair.ffprobe == ffprobe.resolve()
    assert pair.ffmpeg.parent == pair.ffprobe.parent == bin_dir.resolve()
    assert pair.ffmpeg_location == bin_dir.resolve()
    assert pair.source == "environment"


def test_resolves_packaged_resources_pair(tmp_path, monkeypatch):
    clear_tool_sources(monkeypatch)
    resources = tmp_path / "bundle" / "resources"
    executable = resources / "sidecar" / "DownanySidecar" / executable_name(
        "DownanySidecar"
    )
    ffmpeg = make_executable(resources / "bin" / executable_name("ffmpeg"))
    ffprobe = make_executable(resources / "bin" / executable_name("ffprobe"))
    monkeypatch.setattr(bin_paths.sys, "frozen", True, raising=False)
    monkeypatch.setattr(bin_paths.sys, "executable", str(executable))

    pair = resolve_media_toolchain(project_root=tmp_path / "repo")

    assert pair is not None
    assert pair.ffmpeg == ffmpeg.resolve()
    assert pair.ffprobe == ffprobe.resolve()
    assert pair.ffmpeg_location == (resources / "bin").resolve()
    assert pair.source == "packaged"


def test_desktop_resources_pair_precedes_project_bin(tmp_path, monkeypatch):
    clear_tool_sources(monkeypatch)
    root = tmp_path / "repo"
    desktop_dir = root / "desktop" / "resources" / "bin"
    project_dir = root / "bin"
    desktop_ffmpeg = make_executable(desktop_dir / executable_name("ffmpeg"))
    desktop_ffprobe = make_executable(desktop_dir / executable_name("ffprobe"))
    make_executable(project_dir / executable_name("ffmpeg"))
    make_executable(project_dir / executable_name("ffprobe"))

    pair = resolve_media_toolchain(project_root=root)

    assert pair is not None
    assert pair.ffmpeg == desktop_ffmpeg.resolve()
    assert pair.ffprobe == desktop_ffprobe.resolve()
    assert pair.ffmpeg_location == desktop_dir.resolve()
    assert pair.source == "development_resources"


def test_project_bin_pair_is_used_after_desktop_resources(tmp_path, monkeypatch):
    clear_tool_sources(monkeypatch)
    root = tmp_path / "repo"
    project_dir = root / "bin"
    ffmpeg = make_executable(project_dir / executable_name("ffmpeg"))
    ffprobe = make_executable(project_dir / executable_name("ffprobe"))

    pair = resolve_media_toolchain(project_root=root)

    assert pair is not None
    assert pair.ffmpeg == ffmpeg.resolve()
    assert pair.ffprobe == ffprobe.resolve()
    assert pair.ffmpeg_location == project_dir.resolve()
    assert pair.source == "development_bin"


def test_path_pair_allows_tools_from_different_directories(tmp_path, monkeypatch):
    clear_tool_sources(monkeypatch)
    ffmpeg = make_executable(tmp_path / "ffmpeg-bin" / executable_name("ffmpeg"))
    ffprobe = make_executable(tmp_path / "ffprobe-bin" / executable_name("ffprobe"))

    def fake_which(name: str):
        return {
            "ffmpeg": str(ffmpeg),
            "ffprobe": str(ffprobe),
        }.get(name.removesuffix(".exe"))

    monkeypatch.setattr(bin_paths.shutil, "which", fake_which)

    pair = resolve_media_toolchain(project_root=tmp_path / "missing-repo")

    assert pair is not None
    assert pair.ffmpeg == ffmpeg.resolve()
    assert pair.ffprobe == ffprobe.resolve()
    assert pair.ffmpeg_location is None
    assert pair.source == "path"


def test_single_tool_resolvers_remain_independent(tmp_path, monkeypatch):
    clear_tool_sources(monkeypatch)
    bin_dir = tmp_path / "env-bin"
    ffprobe = make_executable(bin_dir / executable_name("ffprobe"))
    monkeypatch.setenv("DOWNANY_BIN_DIR", str(bin_dir))

    assert resolve_ffmpeg_path(project_root=tmp_path) is None
    assert resolve_ffprobe_path(project_root=tmp_path) == ffprobe.resolve()
    assert resolve_media_toolchain(project_root=tmp_path) is None
