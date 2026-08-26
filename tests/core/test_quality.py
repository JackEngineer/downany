"""质量解析测试。"""
from src.core.quality import build_format_selector, normalize_quality, parse_quality_height


def test_parse_quality_height():
    assert parse_quality_height("1080p") == 1080
    assert parse_quality_height("720") == 720
    assert parse_quality_height("best") is None
    assert parse_quality_height("") is None
    # 含数字但不在白名单时由 normalize_quality 回退
    assert parse_quality_height("4K") == 4
    assert normalize_quality("4K") == "best"


def test_normalize_quality():
    assert normalize_quality("1080p") == "1080p"
    assert normalize_quality("BEST") == "best"
    assert normalize_quality("bogus") == "best"
    assert normalize_quality(None) == "best"


def test_build_format_selector():
    assert build_format_selector("best") == (
        "bestvideo[ext=mp4]+bestaudio[ext=m4a]/"
        "bestvideo+bestaudio/best[ext=mp4]/best"
    )
    limited = build_format_selector("1080p")
    assert all("height<=1080" in branch for branch in limited.split("/"))
    assert build_format_selector("best", format_id="22") == "22"
