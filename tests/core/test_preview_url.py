from src.ui.tabs.search_tab import SearchTab


def test_normalize_video_url_youtube_id_to_watch_url():
    youtube_id = "dQw4w9WgXcQ"
    result = SearchTab._normalize_video_url(None, youtube_id)
    assert result == f"https://www.youtube.com/watch?v={youtube_id}"


def test_normalize_video_url_bilibili_bv_to_video_url():
    bv_id = "BV1xx411c7mD"
    result = SearchTab._normalize_video_url(None, bv_id)
    assert result == f"https://www.bilibili.com/video/{bv_id}"


def test_normalize_video_url_http_https_returns_as_is():
    url = "https://example.com/video/123"
    result = SearchTab._normalize_video_url(None, url)
    assert result == url
