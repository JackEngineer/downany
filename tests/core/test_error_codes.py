"""error_code 分类测试。"""
import pytest

from src.core import error_codes as ec


@pytest.mark.parametrize(
    "message,expected",
    [
        ("Sign in to confirm your age", ec.NEED_LOGIN),
        ("Use --cookies-from-browser or --cookies", ec.NEED_LOGIN),
        ("members-only content", ec.NEED_LOGIN),
        ("Video unavailable in your country", ec.GEO_BLOCKED),
        ("This video is private", ec.PRIVATE),
        ("Video has been removed", ec.REMOVED),
        ("The uploader has closed their YouTube account", ec.REMOVED),
        ("HTTP Error 503: Service Unavailable", ec.NETWORK),
        ("HTTP Error 403: Forbidden", ec.NETWORK),
        ("Connection timed out", ec.NETWORK),
        ("Please update yt-dlp", ec.YTDLP_OUTDATED),
        ("GVS PO Token required", ec.NEED_PO_TOKEN),
        ("Unsupported URL", ec.UNSUPPORTED),
        (
            "ERROR: [generic] not-a-video: Unable to download webpage: HTTP Error 404: Not Found",
            ec.UNSUPPORTED,
        ),
        ("ERROR: [youtube] xxxxxxxxxxx: Video unavailable", ec.REMOVED),
        ("something else entirely", ec.UNKNOWN),
        ("", ec.UNKNOWN),
    ],
)
def test_classify_download_error(message, expected):
    assert ec.classify_download_error(message) == expected


def test_classify_from_exception():
    exc = RuntimeError("Sign in to continue")
    assert ec.classify_download_error(exc) == ec.NEED_LOGIN
