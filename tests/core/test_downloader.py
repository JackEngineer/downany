"""Downloader 单元测试（mock yt-dlp）。"""
from unittest.mock import MagicMock, patch

import pytest

from src.core import ytdlp_opts
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


def test_download_uses_bounded_network_timeouts(tmp_path):
    """网络不可达时，下载会话不应无限期停留在“下载中”。"""
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

        downloader.download("https://example.com/v")

    opts = mock_ydl_cls.call_args.args[0]
    assert "socket_timeout" in opts
    assert 0 < opts["socket_timeout"] <= 20
    assert opts["retries"] <= 2
    assert opts["extractor_retries"] <= 2


def test_download_explicitly_enables_available_node_runtime(tmp_path, monkeypatch):
    """YouTube EJS must opt into Node instead of merely finding it on PATH."""
    downloader = Downloader(str(tmp_path))
    final = tmp_path / "video.mp4"
    final.write_bytes(b"x")

    monkeypatch.setattr(
        ytdlp_opts.shutil,
        "which",
        lambda name: r"C:\Program Files\nodejs\node.exe"
        if name in {"node", "node.exe"}
        else None,
    )

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

        downloader.download("https://www.youtube.com/watch?v=abc")

    opts = mock_ydl_cls.call_args.args[0]
    assert opts["js_runtimes"] == {
        "node": {"path": r"C:\Program Files\nodejs\node.exe"},
    }


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


def test_download_retries_transient_youtube_api_timeout_once(tmp_path):
    """一次短暂的 YouTube API 超时应由新的 yt-dlp 会话恢复。"""
    downloader = Downloader(str(tmp_path))
    final = tmp_path / "video.mp4"
    final.write_bytes(b"x")

    with patch("src.core.downloader.yt_dlp.YoutubeDL") as mock_ydl_cls:
        first = MagicMock()
        first.__enter__.return_value = first
        first.__exit__.return_value = False
        first.extract_info.side_effect = RuntimeError(
            "ERROR: [youtube] abc: Unable to download API page: timed out"
        )
        second = MagicMock()
        second.__enter__.return_value = second
        second.__exit__.return_value = False
        second.extract_info.return_value = {
            "title": "video",
            "filepath": str(final),
        }
        second.prepare_filename.return_value = str(final)
        mock_ydl_cls.side_effect = [first, second]

        path = downloader.download("https://www.youtube.com/watch?v=abc")

    assert path == str(final)
    assert mock_ydl_cls.call_count == 2


def test_download_reextracts_youtube_media_url_after_403_once(tmp_path):
    """媒体地址被代理出口变化作废时，应重新解析 URL 后从 .part 续传。"""
    downloader = Downloader(str(tmp_path))
    final = tmp_path / "video.mp4"
    final.write_bytes(b"x")

    with patch("src.core.downloader.yt_dlp.YoutubeDL") as mock_ydl_cls:
        first = MagicMock()
        first.__enter__.return_value = first
        first.__exit__.return_value = False
        first.extract_info.side_effect = RuntimeError(
            "ERROR: unable to download video data: HTTP Error 403: Forbidden"
        )
        second = MagicMock()
        second.__enter__.return_value = second
        second.__exit__.return_value = False
        second.extract_info.return_value = {
            "title": "video",
            "filepath": str(final),
        }
        second.prepare_filename.return_value = str(final)
        mock_ydl_cls.side_effect = [first, second]

        path = downloader.download("https://www.youtube.com/watch?v=abc")

    assert path == str(final)
    assert mock_ydl_cls.call_count == 2


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
