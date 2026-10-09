"""error_code 分类测试。"""
import pytest
from yt_dlp.cookies import CookieLoadError
from yt_dlp.utils import DownloadError

from src.core import error_codes as ec


@pytest.mark.parametrize(
    "message,expected",
    [
        ("Sign in to confirm your age", ec.NEED_LOGIN),
        ("Use --cookies-from-browser or --cookies", ec.NEED_LOGIN),
        ("members-only content", ec.NEED_LOGIN),
        ("could not find chrome cookies database in TEST_PROFILE", "cookie_unavailable"),
        ("could not find firefox cookies database in TEST_PROFILE", "cookie_unavailable"),
        ("Could not copy Chrome cookie database", "cookie_unavailable"),
        ("Fresh cookies (not necessarily logged in) are needed", "site_response_unavailable"),
        ("Video unavailable in your country", ec.GEO_BLOCKED),
        ("This video is private", ec.PRIVATE),
        ("Video has been removed", ec.REMOVED),
        ("The uploader has closed their YouTube account", ec.REMOVED),
        ("HTTP Error 503: Service Unavailable", ec.NETWORK),
        ("HTTP Error 403: Forbidden", ec.NETWORK),
        ("Connection timed out", ec.NETWORK),
        (
            "ERROR: [generic] https://cdn.example/video.m3u8: "
            "Unable to download webpage: Connection timed out",
            ec.NETWORK,
        ),
        (
            "ERROR: [generic] https://cdn.example/video.m3u8: "
            "Unable to download webpage: HTTP Error 503: Service Unavailable",
            ec.NETWORK,
        ),
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


@pytest.mark.parametrize(
    "message",
    [
        "Failed to decrypt with DPAPI",
        "Could not copy Chrome cookie database",
        "database is locked",
        "could not find firefox cookies database in TEST_PROFILE",
    ],
)
def test_nested_cookie_load_failure_reports_unavailable_credentials(message):
    # yt-dlp hides CookieLoadError behind a DownloadError; Downloader adds
    # another wrapper whose message repeats the original browser failure.
    browser_error = RuntimeError(message)
    cookie_error = CookieLoadError("failed to load cookies")
    cookie_error.__context__ = browser_error
    ytdlp_error = DownloadError(message)
    ytdlp_error.__context__ = cookie_error
    download_error = RuntimeError(message)
    download_error.__cause__ = ytdlp_error

    assert ec.classify_download_error(download_error) == "cookie_unavailable"


def test_cookie_load_error_does_not_depend_on_its_message():
    cookie_error = CookieLoadError("")
    wrapper = RuntimeError("download failed")
    wrapper.__cause__ = cookie_error

    assert ec.classify_download_error(cookie_error) == "cookie_unavailable"
    assert ec.classify_download_error(wrapper) == "cookie_unavailable"


@pytest.mark.parametrize(
    "message,expected",
    [
        ("GVS PO Token required", ec.NEED_PO_TOKEN),
        ("Please update yt-dlp", ec.YTDLP_OUTDATED),
        ("HTTP Error 503: Service Unavailable", "cookie_unavailable"),
        ("Fresh cookies (not necessarily logged in) are needed", "cookie_unavailable"),
    ],
)
def test_cookie_load_error_preserves_error_pattern_priority(message, expected):
    wrapper = RuntimeError(message)
    wrapper.__cause__ = CookieLoadError("failed to load cookies")

    assert ec.classify_download_error(wrapper) == expected


@pytest.mark.parametrize(
    "message,expected",
    [
        ("database is locked", ec.UNKNOWN),
        ("Failed to decrypt with DPAPI", ec.UNKNOWN),
        ("Connection timed out", ec.NETWORK),
    ],
)
def test_unrelated_failure_is_not_assumed_to_be_cookie_loading(message, expected):
    error = RuntimeError(message)
    wrapper = RuntimeError(message)
    wrapper.__cause__ = error

    assert ec.classify_download_error(message) == expected
    assert ec.classify_download_error(wrapper) == expected


def test_explicit_cause_takes_precedence_over_cookie_error_context():
    wrapper = RuntimeError("download failed")
    wrapper.__cause__ = TimeoutError("Connection timed out")
    wrapper.__context__ = CookieLoadError("failed to load cookies")

    assert ec.classify_download_error(wrapper) == ec.NETWORK


def test_non_cookie_deep_context_does_not_change_existing_classification():
    wrapper = RuntimeError("Connection timed out")
    wrapper.__cause__ = RuntimeError("retry exhausted")
    wrapper.__cause__.__context__ = RuntimeError("Please update yt-dlp")

    assert ec.classify_download_error(wrapper) == ec.NETWORK


@pytest.mark.parametrize("has_cookie_error", [False, True])
def test_exception_chain_cycles_terminate(has_cookie_error):
    first = RuntimeError("download failed")
    second = CookieLoadError("") if has_cookie_error else RuntimeError("failed")
    first.__cause__ = second
    second.__context__ = first

    expected = "cookie_unavailable" if has_cookie_error else ec.UNKNOWN
    assert ec.classify_download_error(first) == expected


def test_fresh_cookies_details_failure_survives_download_error_wrapping():
    error = DownloadError(
        "ERROR: [douyin] TEST_ID: Fresh cookies (not necessarily logged in) are needed; "
        "please report this issue"
    )
    wrapper = RuntimeError("download failed")
    wrapper.__cause__ = error

    assert ec.classify_download_error(wrapper) == "site_response_unavailable"


@pytest.mark.parametrize(
    "message,expected",
    [
        ("Fresh cookies are needed", ec.NEED_LOGIN),
        ("Use --cookies-from-browser or --cookies", ec.NEED_LOGIN),
        ("could not find application database in TEST_PROFILE", ec.UNKNOWN),
        ("Could not copy application database", ec.UNKNOWN),
        ("database is locked", ec.UNKNOWN),
        ("Failed to decrypt with DPAPI", ec.UNKNOWN),
    ],
)
def test_new_categories_do_not_guess_from_partial_or_unrelated_messages(message, expected):
    assert ec.classify_download_error(message) == expected


@pytest.mark.parametrize(
    "prefix,expected",
    [("GVS PO Token required", ec.NEED_PO_TOKEN), ("Please update yt-dlp", ec.YTDLP_OUTDATED)],
)
def test_explicit_tool_requirements_keep_priority_over_fresh_cookie_hint(prefix, expected):
    message = f"{prefix}; Fresh cookies (not necessarily logged in) are needed"
    assert ec.classify_download_error(message) == expected


def test_new_codes_are_in_the_stable_error_code_set():
    assert "cookie_unavailable" in ec.ALL_ERROR_CODES
    assert "site_response_unavailable" in ec.ALL_ERROR_CODES


@pytest.mark.parametrize(
    ("class_name", "message", "expected_code"),
    [
        ("OutputPathInvalid", "下载位置或文件名不可用", "output_path_invalid"),
        ("MediaToolsMissing", "媒体工具不完整，请重新安装", "media_tools_missing"),
        (
            "OutputVerificationFailed",
            "成品无法验证，请导出诊断后重试",
            "output_verification_failed",
        ),
    ],
)
def test_output_contract_exceptions_keep_stable_codes(
    class_name, message, expected_code
):
    exception_type = getattr(ec, class_name)
    exception = exception_type(message)
    exception.__cause__ = CookieLoadError("failed to load cookies")

    assert exception.error_code == expected_code
    assert str(exception) == message
    assert ec.classify_download_error(exception) == expected_code
    assert expected_code in ec.ALL_ERROR_CODES
