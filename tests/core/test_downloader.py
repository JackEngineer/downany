"""Downloader 单元测试（mock yt-dlp）。"""
from unittest.mock import MagicMock, patch

import pytest

from src.core.downloader import (
    DownloadCancelled,
    DownloadError,
    Downloader,
    resolve_output_path,
)


def test_resolve_output_path_prefers_merged_mp4_over_format_fragment(tmp_path):
    """yt-dlp 合并前 progress 常停在 .f140.m4a；最终文件是同名 .mp4。"""
    final = tmp_path / "Rick Astley - Never Gonna Give You Up.mp4"
    final.write_bytes(b"fake-mp4")
    fragment = tmp_path / "Rick Astley - Never Gonna Give You Up.f140.m4a"
    # 分片可能已被删，或不存在
    assert resolve_output_path(str(fragment)) == str(final)


def test_resolve_output_path_uses_info_filepath(tmp_path):
    final = tmp_path / "video.mp4"
    final.write_bytes(b"x")
    assert (
        resolve_output_path(
            str(tmp_path / "video.f140.m4a"),
            {"filepath": str(final)},
        )
        == str(final)
    )


def test_download_success_returns_filename(tmp_path):
    downloader = Downloader(str(tmp_path))
    final = tmp_path / "video.mp4"
    final.write_bytes(b"x")

    with patch("src.core.downloader.yt_dlp.YoutubeDL") as mock_ydl_cls:
        mock_ydl = MagicMock()
        mock_ydl.__enter__.return_value = mock_ydl
        mock_ydl.__exit__.return_value = False
        mock_ydl.extract_info.return_value = {
            "title": "video",
            "filepath": str(final),
        }
        mock_ydl.prepare_filename.return_value = str(final)
        mock_ydl_cls.return_value = mock_ydl

        path = downloader.download("https://example.com/v")

    assert path.endswith("video.mp4")
    opts = mock_ydl_cls.call_args[0][0]
    assert opts["quiet"] is True
    assert opts["noprogress"] is True
    assert opts["no_warnings"] is True
    assert opts["logger"] is not None
    assert downloader.last_ydl_info["title"] == "video"


def test_download_error_is_reraised(tmp_path):
    downloader = Downloader(str(tmp_path))
    errors = []
    downloader.set_callbacks(error=errors.append)

    with patch("src.core.downloader.yt_dlp.YoutubeDL") as mock_ydl_cls:
        mock_ydl = MagicMock()
        mock_ydl.__enter__.return_value = mock_ydl
        mock_ydl.__exit__.return_value = False
        mock_ydl.extract_info.side_effect = RuntimeError("network down")
        mock_ydl_cls.return_value = mock_ydl

        with pytest.raises(DownloadError):
            downloader.download("https://example.com/v")

    assert errors and "network down" in errors[0]


def test_download_cancelled_propagates(tmp_path):
    downloader = Downloader(str(tmp_path))

    with patch("src.core.downloader.yt_dlp.YoutubeDL") as mock_ydl_cls:
        mock_ydl = MagicMock()
        mock_ydl.__enter__.return_value = mock_ydl
        mock_ydl.__exit__.return_value = False
        mock_ydl.extract_info.side_effect = DownloadCancelled("任务已取消")
        mock_ydl_cls.return_value = mock_ydl

        with pytest.raises(DownloadCancelled):
            downloader.download("https://example.com/v")
