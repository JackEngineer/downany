"""下载失败结构化 error_code 分类。"""
from __future__ import annotations

import re
from typing import Union

from yt_dlp.cookies import CookieLoadError

NEED_LOGIN = "need_login"
COOKIE_UNAVAILABLE = "cookie_unavailable"
SITE_RESPONSE_UNAVAILABLE = "site_response_unavailable"
GEO_BLOCKED = "geo_blocked"
PRIVATE = "private"
REMOVED = "removed"
NETWORK = "network"
YTDLP_OUTDATED = "ytdlp_outdated"
NEED_PO_TOKEN = "need_po_token"
UNSUPPORTED = "unsupported"
OUTPUT_PATH_INVALID = "output_path_invalid"
MEDIA_TOOLS_MISSING = "media_tools_missing"
OUTPUT_VERIFICATION_FAILED = "output_verification_failed"
EMBEDDED_SESSION_REQUIRED = "embedded_session_required"
UNKNOWN = "unknown"

ALL_ERROR_CODES = frozenset(
    {
        NEED_LOGIN,
        COOKIE_UNAVAILABLE,
        SITE_RESPONSE_UNAVAILABLE,
        GEO_BLOCKED,
        PRIVATE,
        REMOVED,
        NETWORK,
        YTDLP_OUTDATED,
        NEED_PO_TOKEN,
        UNSUPPORTED,
        OUTPUT_PATH_INVALID,
        MEDIA_TOOLS_MISSING,
        OUTPUT_VERIFICATION_FAILED,
        EMBEDDED_SESSION_REQUIRED,
        UNKNOWN,
    }
)


class OutputContractError(RuntimeError):
    """带稳定产品错误码的成品合同异常。"""

    error_code = UNKNOWN


class EmbeddedSessionRequired(OutputContractError):
    error_code = EMBEDDED_SESSION_REQUIRED


class OutputPathInvalid(OutputContractError):
    error_code = OUTPUT_PATH_INVALID


class MediaToolsMissing(OutputContractError):
    error_code = MEDIA_TOOLS_MISSING


class OutputVerificationFailed(OutputContractError):
    error_code = OUTPUT_VERIFICATION_FAILED

_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    (NEED_PO_TOKEN, re.compile(r"po[\s_-]?token|gvs[\s_-]?po", re.I)),
    (YTDLP_OUTDATED, re.compile(r"outdated|please update|no longer supported|update yt-dlp", re.I)),
    # 明确的凭证读取失败不同于网站要求登录；无类型的锁库/解密文字不作推断。
    (COOKIE_UNAVAILABLE, re.compile(
        r"\bcould not (?:find|copy) [a-z0-9_-]+ cookies? database\b", re.I,
    )),
    # 抖音提取器未得到可用详情时抛出此句，不能据此断言未登录或凭证过期。
    (SITE_RESPONSE_UNAVAILABLE, re.compile(
        r"\bFresh cookies \(not necessarily logged in\) are needed\b", re.I,
    )),
    # members.?only 优先归 need_login（可导入 Cookie），早于 private
    (NEED_LOGIN, re.compile(
        r"sign in|login required|cookies|use --cookies|authentication|members.?only|age.?restricted",
        re.I,
    )),
    (GEO_BLOCKED, re.compile(r"not available in your country|unavailable in your country|geo.?restrict|region.?block|country.?block", re.I)),
    (PRIVATE, re.compile(r"\bprivate video\b|video is private", re.I)),
    (NETWORK, re.compile(
        r"timeout|timed out|connection|network|errno|http error 403|http error 429|http error 5|forbidden|ssl:|certificate",
        re.I,
    )),
    # generic 抽取器失败 = 站点/链接不受支持，须早于 404→removed；
    # 但明确的网络错误必须先由 NETWORK 接住。
    (UNSUPPORTED, re.compile(
        r"unsupported url|no suitable extractor|unsupported site|unable to extract|\[generic\]",
        re.I,
    )),
    (REMOVED, re.compile(
        r"unavailable|has been removed|video has been deleted|no longer available|"
        r"404|not found|closed their|account.*(terminated|closed)|uploader.*(terminated|closed)",
        re.I,
    )),
)


def classify_download_error(exc_or_message: Union[BaseException, str]) -> str:
    """把异常或错误文本映射为稳定 error_code 字符串。"""
    if isinstance(exc_or_message, OutputContractError):
        return exc_or_message.error_code
    cookie_load_failed = False
    if isinstance(exc_or_message, BaseException):
        text = str(exc_or_message)
        cause = exc_or_message.__cause__ or exc_or_message.__context__
        if cause is not None:
            text = f"{text} {cause}"
        # CookieLoadError 可被 yt-dlp 和 Downloader 多层包装；其他错误
        # 仍按原有两层文字分类，避免深层上下文改变既有优先级。
        seen: set[int] = set()
        error: BaseException | None = exc_or_message
        while error is not None and id(error) not in seen:
            seen.add(id(error))
            cookie_load_failed |= isinstance(error, CookieLoadError)
            error = error.__cause__ or error.__context__
    else:
        text = str(exc_or_message or "")
    normalized = text.strip()
    if not normalized and not cookie_load_failed:
        return UNKNOWN
    for code, pattern in _PATTERNS:
        if (code == COOKIE_UNAVAILABLE and cookie_load_failed) or pattern.search(normalized):
            return code
    return UNKNOWN
