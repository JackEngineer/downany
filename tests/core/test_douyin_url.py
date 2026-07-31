"""抖音 URL 归一化：modal_id / 精选页 → /video/{id}。"""
from src.core.douyin_url import is_douyin_url, normalize_douyin_url


def test_jingxuan_modal_id_becomes_video_page():
    url = "https://www.douyin.com/jingxuan?modal_id=7661234567890123456&extra=1"
    assert is_douyin_url(url)
    assert normalize_douyin_url(url) == (
        "https://www.douyin.com/video/7661234567890123456"
    )


def test_discover_and_follow_modal_id():
    assert normalize_douyin_url(
        "https://www.douyin.com/discover?modal_id=111"
    ) == "https://www.douyin.com/video/111"
    assert normalize_douyin_url(
        "https://www.douyin.com/follow?modal_id=222"
    ) == "https://www.douyin.com/video/222"


def test_video_path_kept_and_query_stripped():
    assert normalize_douyin_url(
        "https://www.douyin.com/video/333?is_v=1"
    ) == "https://www.douyin.com/video/333"


def test_non_douyin_unchanged():
    url = "https://www.youtube.com/watch?v=abc"
    assert not is_douyin_url(url)
    assert normalize_douyin_url(url) == url


def test_short_link_unchanged():
    url = "https://v.douyin.com/AbCdEf/"
    assert is_douyin_url(url)
    assert normalize_douyin_url(url) == url
