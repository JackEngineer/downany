"""下载任务 URL 的边界修复。"""
from __future__ import annotations

import re
from urllib.parse import parse_qs, urlsplit, urlunsplit


_ABSOLUTE_URL_RE = re.compile(r"https?://", re.IGNORECASE)
_YOUTUBE_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com"}
_YOUTUBE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{6,}$")


def normalize_download_url(url: str) -> str:
    """修复客户端重复拼接 YouTube URL 后形成的明确坏形态。"""
    text = (url or "").strip()
    matches = list(_ABSOLUTE_URL_RE.finditer(text))
    if len(matches) != 2:
        return text

    outer_text = text[: matches[1].start()].rstrip("/")
    inner_text = text[matches[1].start() :]
    outer = urlsplit(outer_text)
    inner = urlsplit(inner_text)
    if (
        not outer.scheme
        or not outer.netloc
        or outer.scheme.lower() != inner.scheme.lower()
        or outer.netloc.lower() != inner.netloc.lower()
        or (inner.hostname or "").lower() not in _YOUTUBE_HOSTS
        or inner.path.lower() != "/watch"
    ):
        return text

    raw_video_id = (parse_qs(inner.query, keep_blank_values=True).get("v") or [""])[0]
    video_id = raw_video_id.split("/", 1)[0].strip()
    if "/" not in raw_video_id or not _YOUTUBE_ID_RE.fullmatch(video_id):
        return text

    return urlunsplit((inner.scheme, inner.netloc, inner.path, f"v={video_id}", ""))
