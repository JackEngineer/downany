"""本地抽帧封面单测。"""
from pathlib import Path
from unittest.mock import patch

from src.core.local_thumbnail import (
    ensure_local_thumbnail,
    extract_video_thumbnail,
    find_adjacent_thumbnail,
    thumbnail_url_for_task,
)


def test_thumbnail_url_scheme():
    assert thumbnail_url_for_task("abc-123") == "downany-thumb://abc-123"
    assert thumbnail_url_for_task("") == ""


def test_find_adjacent_thumbnail(tmp_path: Path):
    video = tmp_path / "clip.mp4"
    video.write_bytes(b"not-a-real-video")
    assert find_adjacent_thumbnail(str(video)) == ""
    thumb = tmp_path / "clip.jpg"
    thumb.write_bytes(b"jpeg")
    assert find_adjacent_thumbnail(str(video)).endswith("clip.jpg")


def test_ensure_local_thumbnail_copies_adjacent(tmp_path: Path):
    video = tmp_path / "a.mp4"
    video.write_bytes(b"mp4")
    (tmp_path / "a.jpg").write_bytes(b"jpeg-bytes")
    data = tmp_path / "data"
    url = ensure_local_thumbnail("task1", str(video), data_dir=data)
    assert url == "downany-thumb://task1"
    assert (data / "thumbnails" / "task1.jpg").read_bytes() == b"jpeg-bytes"


def test_ensure_local_thumbnail_ffmpeg_fallback(tmp_path: Path):
    video = tmp_path / "b.mp4"
    video.write_bytes(b"mp4")
    data = tmp_path / "data"

    def fake_extract(src, dest, **_kwargs):
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(b"frame")
        return True

    with patch(
        "src.core.local_thumbnail.extract_video_thumbnail",
        side_effect=fake_extract,
    ):
        url = ensure_local_thumbnail("task2", str(video), data_dir=data)
    assert url == "downany-thumb://task2"
    assert (data / "thumbnails" / "task2.jpg").read_bytes() == b"frame"


def test_extract_video_thumbnail_missing_file(tmp_path: Path):
    assert not extract_video_thumbnail(
        str(tmp_path / "missing.mp4"),
        tmp_path / "out.jpg",
    )
