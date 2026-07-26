"""Twitter/X 回退：yt-dlp GraphQL 失败时用 FxTwitter API 取元数据与直链。"""
from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from typing import Any, Dict, Optional, Tuple
from urllib.parse import urlparse

from src.core.download_task import Platform, VideoInfo
from src.core.http_headers import DEFAULT_USER_AGENT
from src.utils.logger import setup_logger

logger = setup_logger("TwitterFallback")

_STATUS_RE = re.compile(
    r"(?:https?://)?(?:www\.)?(?:twitter|x)\.com/[^/]+/status/(\d+)",
    re.IGNORECASE,
)
_FXTWITTER_STATUS = "https://api.fxtwitter.com/status/{status_id}"


def is_twitter_url(url: str) -> bool:
    host = (urlparse(url).hostname or "").lower()
    return host.endswith("twitter.com") or host.endswith("x.com")


def extract_tweet_id(url: str) -> Optional[str]:
    match = _STATUS_RE.search(url or "")
    return match.group(1) if match else None


def normalize_twitter_url(url: str) -> str:
    """去掉查询串与多余片段，保留 status 与可选 /video/N。"""
    text = (url or "").strip()
    if not text:
        return text
    # 去掉 ?s=20 等跟踪参数
    text = text.split("#", 1)[0]
    text = text.split("?", 1)[0]
    return text.rstrip("/")


def _http_get_json(url: str, *, proxy: Optional[str] = None, timeout: float = 20.0) -> Dict[str, Any]:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": DEFAULT_USER_AGENT,
            "Accept": "application/json",
        },
    )
    opener = urllib.request.build_opener()
    if proxy:
        opener.add_handler(urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
    with opener.open(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise RuntimeError("FxTwitter 返回无效 JSON")
    return data


def _pick_best_video(media_block: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    videos = media_block.get("videos") or []
    if not videos and isinstance(media_block.get("all"), list):
        videos = [m for m in media_block["all"] if (m or {}).get("type") == "video"]
    if not videos:
        return None

    def rank(item: Dict[str, Any]) -> Tuple[int, int]:
        w = int(item.get("width") or 0)
        h = int(item.get("height") or 0)
        return (w * h, w)

    return max(videos, key=rank)


def resolve_twitter_media(
    url: str,
    *,
    proxy: Optional[str] = None,
    opener_get_json=None,
) -> Tuple[VideoInfo, str]:
    """
    通过 FxTwitter 解析推文视频。

    Returns:
        (VideoInfo, direct_mp4_url)
    """
    status_id = extract_tweet_id(url)
    if not status_id:
        raise RuntimeError("无法识别 Twitter/X 状态 ID")

    fetch = opener_get_json or _http_get_json
    data = fetch(_FXTWITTER_STATUS.format(status_id=status_id), proxy=proxy)
    if int(data.get("code") or 0) not in (0, 200):
        raise RuntimeError(data.get("message") or "FxTwitter 请求失败")

    tweet = data.get("tweet") or {}
    if not isinstance(tweet, dict):
        raise RuntimeError("推文数据缺失")

    media = tweet.get("media") or {}
    if not isinstance(media, dict):
        media = {}
    best = _pick_best_video(media)
    if not best or not best.get("url"):
        raise RuntimeError("该推文没有可下载视频")

    author = tweet.get("author") or {}
    uploader = (
        (author.get("name") if isinstance(author, dict) else None)
        or (author.get("screen_name") if isinstance(author, dict) else None)
        or "未知"
    )
    title = (tweet.get("text") or "").strip() or f"Twitter {status_id}"
    # 标题过长时截断，便于 UI
    title = " ".join(title.split())
    if len(title) > 120:
        title = title[:117] + "…"

    duration = best.get("duration") or 0
    try:
        duration_i = int(float(duration))
    except (TypeError, ValueError):
        duration_i = 0

    info = VideoInfo(
        url=normalize_twitter_url(url),
        title=title,
        duration=duration_i,
        thumbnail_url=str(best.get("thumbnail_url") or ""),
        uploader=str(uploader),
        platform=Platform.TWITTER,
        file_size=0,
    )
    direct = str(best["url"])
    logger.info("FxTwitter 回退成功 status=%s title=%s", status_id, title[:40])
    return info, direct
