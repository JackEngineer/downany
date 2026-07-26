"""Downloader 单元测试（mock yt-dlp）。"""
from unittest.mock import MagicMock, patch

import pytest

from src.core.downloader import DownloadCancelled, DownloadError, Downloader


def test_download_success_returns_filename(tmp_path):
    downloader = Downloader(str(tmp_path))

    def fake_download(urls):
        downloader.last_filename = str(tmp_path / "video.mp4")

    with patch("src.core.downloader.yt_dlp.YoutubeDL") as mock_ydl_cls:
        mock_ydl = MagicMock()
        mock_ydl.__enter__.return_value = mock_ydl
        mock_ydl.__exit__.return_value = False
        mock_ydl.download.side_effect = fake_download
        mock_ydl_cls.return_value = mock_ydl

        path = downloader.download("https://example.com/v")

    assert path.endswith("video.mp4")
    opts = mock_ydl_cls.call_args[0][0]
    assert opts["quiet"] is True
    assert opts["noprogress"] is True
    assert opts["no_warnings"] is True
    assert opts["logger"] is not None


def test_download_error_is_reraised(tmp_path):
    downloader = Downloader(str(tmp_path))
    errors = []
    downloader.set_callbacks(error=errors.append)

    with patch("src.core.downloader.yt_dlp.YoutubeDL") as mock_ydl_cls:
        mock_ydl = MagicMock()
        mock_ydl.__enter__.return_value = mock_ydl
        mock_ydl.__exit__.return_value = False
        mock_ydl.download.side_effect = RuntimeError("network down")
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
        mock_ydl.download.side_effect = DownloadCancelled("任务已取消")
        mock_ydl_cls.return_value = mock_ydl

        with pytest.raises(DownloadCancelled):
            downloader.download("https://example.com/v")
