"""Per-task login policy; anonymous choices never reload browser credentials."""
from dataclasses import replace
from src.core.download_task import DownloadOptions

LOGIN_MODES = frozenset({"inherit", "none"})
_PUBLIC_HEADERS = frozenset({"accept", "accept-language", "accept-encoding", "user-agent", "referer", "origin", "range"})

def validate_login_mode(value: object) -> str:
    if not isinstance(value, str) or value not in LOGIN_MODES:
        raise ValueError("login_mode must be inherit or none")
    return value

def effective_login_options(options: DownloadOptions, mode: str | None = None) -> DownloadOptions:
    selected = validate_login_mode(options.login_mode if mode is None else mode)
    headers = dict(options.http_headers) if options.http_headers else None
    if selected == "none" and headers:
        headers = {key: value for key, value in headers.items() if key.lower() in _PUBLIC_HEADERS} or None
    return replace(options, login_mode=selected, http_headers=headers,
                   postprocessing_pipeline=list(options.postprocessing_pipeline),
                   cookies_from_browser="" if selected == "none" else options.cookies_from_browser,
                   cookiefile="" if selected == "none" else options.cookiefile)
