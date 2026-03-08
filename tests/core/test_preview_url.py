from src.ui.tabs.search_tab import SearchTab


def test_normalize_video_url_youtube_id_to_watch_url():
    youtube_id = "dQw4w9WgXcQ"
    result = SearchTab._normalize_video_url(None, youtube_id)
    assert result == f"https://www.youtube.com/watch?v={youtube_id}"


def test_normalize_video_url_bilibili_bv_to_video_url():
    bv_id = "BV1xx411c7mD"
    result = SearchTab._normalize_video_url(None, bv_id)
    assert result == f"https://www.bilibili.com/video/{bv_id}"


def test_normalize_video_url_https_returns_as_is():
    https_url = "https://example.com/video/123"
    result = SearchTab._normalize_video_url(None, https_url)
    assert result == https_url


def test_normalize_video_url_http_returns_as_is():
    http_url = "http://example.com/video/123"
    result = SearchTab._normalize_video_url(None, http_url)
    assert result == http_url
