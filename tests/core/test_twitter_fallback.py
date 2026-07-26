"""Twitter FxTwitter 回退单测。"""
from src.core.download_task import Platform
from src.core.twitter_fallback import (
    extract_tweet_id,
    is_twitter_url,
    normalize_twitter_url,
    resolve_twitter_media,
)


def test_extract_and_normalize():
    url = "https://x.com/LillianB47947/status/2057757739775033790/video/1?s=20"
    assert is_twitter_url(url)
    assert extract_tweet_id(url) == "2057757739775033790"
    assert normalize_twitter_url(url) == (
        "https://x.com/LillianB47947/status/2057757739775033790/video/1"
    )


def test_resolve_twitter_media_picks_best(monkeypatch):
    payload = {
        "code": 200,
        "tweet": {
            "text": "测试推文标题",
            "author": {"name": "作者", "screen_name": "author"},
            "media": {
                "videos": [
                    {
                        "url": "https://video.twimg.com/low.mp4",
                        "thumbnail_url": "https://pbs.twimg.com/a.jpg",
                        "duration": 10.2,
                        "width": 640,
                        "height": 360,
                        "type": "video",
                    },
                    {
                        "url": "https://video.twimg.com/high.mp4",
                        "thumbnail_url": "https://pbs.twimg.com/b.jpg",
                        "duration": 10.2,
                        "width": 1280,
                        "height": 720,
                        "type": "video",
                    },
                ]
            },
        },
    }

    def fake_get(url, proxy=None):
        assert "2057757739775033790" in url
        return payload

    info, direct = resolve_twitter_media(
        "https://x.com/u/status/2057757739775033790/video/1",
        opener_get_json=fake_get,
    )
    assert direct.endswith("high.mp4")
    assert info.platform == Platform.TWITTER
    assert info.title == "测试推文标题"
    assert info.uploader == "作者"
    assert info.duration == 10
    assert info.thumbnail_url.endswith("b.jpg")
