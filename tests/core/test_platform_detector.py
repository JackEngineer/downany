"""平台识别单测。"""
from src.core.download_task import Platform
from src.core.platform_detector import PlatformDetector, normalize_thumbnail_url


def test_pornhub_cn_and_cdn():
    assert (
        PlatformDetector.detect("https://cn.pornhub.com/view_video.php?viewkey=abc")
        == Platform.PORNHUB
    )
    assert (
        PlatformDetector.detect(
            "https://ev.phncdn.com/videos/202604/30/47103015/240P_1000K_47103015.mp4"
        )
        == Platform.PORNHUB
    )
    assert (
        PlatformDetector.detect("https://www.pornhub.com/view_video.php?viewkey=x")
        == Platform.PORNHUB
    )


def test_detect_with_referer_for_cdn():
    assert (
        PlatformDetector.detect_with_context(
            "https://ev.phncdn.com/x.mp4",
            referer="https://cn.pornhub.com/view_video.php?viewkey=1",
        )
        == Platform.PORNHUB
    )


def test_normalize_thumbnail_upgrades_http():
    assert (
        normalize_thumbnail_url("http://i0.hdslb.com/bfs/archive/abc.jpg")
        == "https://i0.hdslb.com/bfs/archive/abc.jpg"
    )
    assert normalize_thumbnail_url("https://example.com/a.jpg") == "https://example.com/a.jpg"
    assert normalize_thumbnail_url("") == ""
