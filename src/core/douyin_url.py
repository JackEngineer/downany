"""抖音 URL 归一化：把 modal_id 精选/发现页改写成 yt-dlp 可识别的 /video/{id}。"""
from __future__ import annotations

from urllib.parse import parse_qs, urlparse


def is_douyin_url(url: str) -> bool:
    host = (urlparse(url or "").hostname or "").lower()
    return host == "douyin.com" or host.endswith(".douyin.com")


def normalize_douyin_url(url: str) -> str:
    """
    将带 modal_id 的抖音 SPA 页改写为 https://www.douyin.com/video/{id}。
    短链 v.douyin.com 保持原样（需跳转解析）。
    非抖音 URL 原样返回。
    """
    text = (url or "").strip()
    if not text or not is_douyin_url(text):
        return text

    parsed = urlparse(text)
    host = (parsed.hostname or "").lower()
    # 短链不改写
    if host == "v.douyin.com":
        return text

    path = parsed.path or ""
    video_id = ""
    if path.startswith("/video/"):
        rest = path[len("/video/") :].split("/", 1)[0]
        if rest.isdigit():
            video_id = rest
    if not video_id:
        qs = parse_qs(parsed.query or "")
        modal = (qs.get("modal_id") or [None])[0]
        if modal and str(modal).isdigit():
            video_id = str(modal)

    if not video_id:
        return text

    return f"https://www.douyin.com/video/{video_id}"
