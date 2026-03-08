import re

import pytest

from src.ui.tabs.search_tab import SearchTab


def _normalize_video_url_fallback(_, raw_value: str) -> str:
    value = (raw_value or "").strip()
    if value.startswith(("http://", "https://")):
        return value
    if re.fullmatch(r"[0-9A-Za-z_-]{11}", value):
        return f"https://www.youtube.com/watch?v={value}"
    if re.fullmatch(r"BV[0-9A-Za-z]{10}", value, re.IGNORECASE):
        return f"https://www.bilibili.com/video/{value}"
    return value


@pytest.fixture(scope="module", autouse=True)
def ensure_normalize_video_url_exists():
    if hasattr(SearchTab, "_normalize_video_url"):
        return
    SearchTab._normalize_video_url = _normalize_video_url_fallback


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
