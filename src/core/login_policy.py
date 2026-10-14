"""Per-task login policy; anonymous choices never reload browser credentials."""
from dataclasses import replace
from urllib.parse import urlsplit
from src.core.download_task import DownloadOptions

LOGIN_MODES = frozenset({"auto", "inherit", "none"})
_PUBLIC_HEADERS = frozenset({"accept", "accept-language", "accept-encoding", "user-agent", "referer", "origin", "range"})

def validate_login_mode(value: object) -> str:
    if not isinstance(value, str) or value not in LOGIN_MODES:
        raise ValueError("login_mode must be auto, inherit or none")
    return value

def prefers_public_download(options: DownloadOptions, url: str) -> bool:
    if options.login_mode == "none":
        return True
    if options.login_mode != "auto":
        return False
    try:
        host = urlsplit(url).hostname or ""
    except ValueError:
        return False
    return host in {"x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com", "video.twimg.com", "www.douyin.com", "douyin.com", "v.douyin.com"}


def effective_login_options(options: DownloadOptions, mode: str | None = None, *, url: str = "") -> DownloadOptions:
    selected = validate_login_mode(options.login_mode if mode is None else mode)
    public = prefers_public_download(replace(options, login_mode=selected), url)
    headers = dict(options.http_headers) if options.http_headers else None
    if public and headers:
        headers = {key: value for key, value in headers.items() if key.lower() in _PUBLIC_HEADERS} or None
    return replace(options, login_mode=selected, http_headers=headers,
                   postprocessing_pipeline=list(options.postprocessing_pipeline),
                   cookies_from_browser="" if public else options.cookies_from_browser,
                   cookiefile="" if public else options.cookiefile)
