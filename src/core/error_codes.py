"""下载失败结构化 error_code 分类。"""
from __future__ import annotations

import re
from typing import Union

NEED_LOGIN = "need_login"
GEO_BLOCKED = "geo_blocked"
PRIVATE = "private"
REMOVED = "removed"
NETWORK = "network"
YTDLP_OUTDATED = "ytdlp_outdated"
NEED_PO_TOKEN = "need_po_token"
UNSUPPORTED = "unsupported"
UNKNOWN = "unknown"

ALL_ERROR_CODES = frozenset(
    {
        NEED_LOGIN,
        GEO_BLOCKED,
        PRIVATE,
        REMOVED,
        NETWORK,
        YTDLP_OUTDATED,
        NEED_PO_TOKEN,
        UNSUPPORTED,
        UNKNOWN,
    }
)

_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    (NEED_PO_TOKEN, re.compile(r"po[\s_-]?token|gvs[\s_-]?po", re.I)),
    (YTDLP_OUTDATED, re.compile(r"outdated|please update|no longer supported|update yt-dlp", re.I)),
    # members.?only 优先归 need_login（可导入 Cookie），早于 private
    (NEED_LOGIN, re.compile(
        r"sign in|login required|cookies|use --cookies|authentication|members.?only|age.?restricted",
        re.I,
    )),
    (GEO_BLOCKED, re.compile(r"not available in your country|unavailable in your country|geo.?restrict|region.?block|country.?block", re.I)),
    (PRIVATE, re.compile(r"\bprivate video\b|video is private", re.I)),
    # generic 抽取器失败 = 站点/链接不受支持，须早于 404→removed
    (UNSUPPORTED, re.compile(
        r"unsupported url|no suitable extractor|unsupported site|unable to extract|\[generic\]",
        re.I,
    )),
    (NETWORK, re.compile(
        r"timeout|timed out|connection|network|errno|http error 403|http error 429|http error 5|forbidden|ssl:|certificate",
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
    if isinstance(exc_or_message, BaseException):
        text = str(exc_or_message)
        cause = exc_or_message.__cause__ or exc_or_message.__context__
        if cause is not None:
            text = f"{text} {cause}"
    else:
        text = str(exc_or_message or "")
    normalized = text.strip()
    if not normalized:
        return UNKNOWN
    for code, pattern in _PATTERNS:
        if pattern.search(normalized):
            return code
    return UNKNOWN
