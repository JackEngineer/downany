"""VideoInfoExtractor：yt-dlp 失败时 Twitter FxTwitter 元数据回退。"""
from unittest.mock import MagicMock, patch

from src.core.download_task import Platform, VideoInfo
from src.core.video_info_extractor import VideoInfoExtractor


def test_extract_uses_fxtwitter_when_ydl_fails_on_twitter():
    fallback = VideoInfo(
        url="https://x.com/u/status/1",
        title="Fx 标题",
        platform=Platform.TWITTER,
    )
    with patch("src.core.video_info_extractor.yt_dlp.YoutubeDL") as mock_cls, patch(
        "src.core.twitter_fallback.resolve_twitter_media",
        return_value=(fallback, "https://video.twimg.com/x.mp4"),
    ) as mock_fx:
        mock_ydl = MagicMock()
        mock_ydl.__enter__.return_value = mock_ydl
        mock_ydl.__exit__.return_value = False
        mock_ydl.extract_info.side_effect = Exception("No video could be found")
        mock_cls.return_value = mock_ydl

        info = VideoInfoExtractor.extract("https://x.com/u/status/1/video/1")

    assert info is fallback
    assert info.title == "Fx 标题"
    mock_fx.assert_called_once()


def test_extract_non_twitter_failure_returns_none():
    with patch("src.core.video_info_extractor.yt_dlp.YoutubeDL") as mock_cls:
        mock_ydl = MagicMock()
        mock_ydl.__enter__.return_value = mock_ydl
        mock_ydl.__exit__.return_value = False
        mock_ydl.extract_info.side_effect = Exception("boom")
        mock_cls.return_value = mock_ydl

        assert VideoInfoExtractor.extract("https://example.com/v") is None
