"""Anonymous public metadata only: no OAuth, cookie jar, account or API key."""
from dataclasses import dataclass
import json
import math
import re
import urllib.error
import urllib.parse
import urllib.request
from typing import Callable, Optional

from src.core.download_task import Platform, VideoInfo
from src.core.http_headers import DEFAULT_HTTP_HEADERS


class DailymotionPublicError(Exception):
    pass


@dataclass(frozen=True)
class PublicSearchPage:
    items: list[VideoInfo]
    page: int
    has_more: bool


def dailymotion_id(url: str) -> Optional[str]:
    try:
        value = urllib.parse.urlsplit(url)
        if value.scheme not in {"http", "https"} or value.username or value.password:
            return None
        if value.hostname in {"dailymotion.com", "www.dailymotion.com"}:
            match = re.fullmatch(r"/video/(x[A-Za-z0-9]+)(?:_[^/]*)?/?", value.path)
        elif value.hostname == "dai.ly":
            match = re.fullmatch(r"/(x[A-Za-z0-9]+)/?", value.path)
        else:
            return None
        return match.group(1) if match else None
    except ValueError:
        return None


def _json(url: str, proxy: Optional[str] = None) -> dict:
    opener = urllib.request.build_opener()
    if proxy:
        opener.add_handler(urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
    request = urllib.request.Request(url, headers={
        "User-Agent": DEFAULT_HTTP_HEADERS["User-Agent"], "Accept": "application/json",
    })
    try:
        with opener.open(request, timeout=10) as response:
            raw = response.read(2 * 1024 * 1024 + 1)
        if len(raw) > 2 * 1024 * 1024:
            raise DailymotionPublicError("公开响应过大")
        data = json.loads(raw)
    except urllib.error.HTTPError as exc:
        raise DailymotionPublicError(f"Dailymotion HTTP {exc.code}") from exc
    except (TimeoutError, OSError) as exc:
        raise DailymotionPublicError("Dailymotion 请求超时或网络不可用") from exc
    except (ValueError, UnicodeError) as exc:
        raise DailymotionPublicError("Dailymotion 响应无效") from exc
    if not isinstance(data, dict) or data.get("error"):
        raise DailymotionPublicError("Dailymotion 未提供公开结果")
    return data


def _https(value: object, hosts: tuple[str, ...]) -> str:
    if not isinstance(value, str):
        return ""
    try:
        url = urllib.parse.urlsplit(value)
        if url.scheme == "https" and not url.username and not url.password and any(
            url.hostname == host or (url.hostname or "").endswith("." + host) for host in hosts
        ):
            return value
    except ValueError:
        pass
    return ""


def _duration(value: object) -> int:
    try:
        number = float(value)
        return max(0, int(number)) if math.isfinite(number) else 0
    except (ValueError, TypeError, OverflowError):
        return 0


def search_dailymotion_page(query: str, *, page: int = 1, count: int = 12,
                           proxy: Optional[str] = None,
                           cancelled: Optional[Callable[[], bool]] = None) -> PublicSearchPage:
    query = query.strip()
    if not query or len(query) > 300 or not 1 <= page <= 100 or not 1 <= count <= 30:
        raise DailymotionPublicError("搜索参数无效")
    if cancelled and cancelled():
        raise DailymotionPublicError("search_cancelled")
    params = urllib.parse.urlencode({"search": query, "fields": "id,title,duration,thumbnail_url,owner.screenname,url", "limit": count, "page": page})
    data = _json("https://api.dailymotion.com/videos?" + params, proxy)
    if cancelled and cancelled():
        raise DailymotionPublicError("search_cancelled")
    if not isinstance(data.get("list"), list) or data.get("page") != page:
        raise DailymotionPublicError("Dailymotion 分页响应无效")
    items = []
    seen = set()
    for entry in data["list"][:count]:
        if not isinstance(entry, dict):
            continue
        video_id = entry.get("id")
        if not isinstance(video_id, str) or not re.fullmatch(r"x[A-Za-z0-9]+", video_id) or video_id in seen:
            continue
        seen.add(video_id)
        title = str(entry.get("title") or "").strip()[:500]
        if not title:
            continue
        items.append(VideoInfo(url=f"https://www.dailymotion.com/video/{video_id}", title=title,
            duration=_duration(entry.get("duration")),
            thumbnail_url=_https(entry.get("thumbnail_url"), ("dmcdn.net", "dailymotion.com")),
            uploader=str(entry.get("owner.screenname") or "")[:160], platform=Platform.DAILYMOTION))
    return PublicSearchPage(items, page, bool(items) and data.get("has_more") is True and page < 100)


def resolve_public_dailymotion(url: str, *, proxy: Optional[str] = None) -> tuple[VideoInfo, str]:
    video_id = dailymotion_id(url)
    if not video_id:
        raise DailymotionPublicError("不是可识别的 Dailymotion 作品链接")
    data = _json(f"https://www.dailymotion.com/player/metadata/video/{video_id}", proxy)
    if data.get("id") != video_id or data.get("private") or data.get("is_password_protected") or data.get("protected_delivery") or data.get("mode") != "vod":
        raise DailymotionPublicError("作品未提供公开、未加密的点播媒体")
    qualities = data.get("qualities") or {}
    media = ""
    for entries in qualities.values() if isinstance(qualities, dict) else []:
        for entry in entries if isinstance(entries, list) else []:
            if isinstance(entry, dict) and entry.get("type") in {"application/x-mpegURL", "application/vnd.apple.mpegurl", "video/mp4"}:
                media = _https(entry.get("url"), ("dailymotion.com", "dmcdn.net", "dailymotioncdn.com"))
                if media:
                    break
        if media:
            break
    if not media:
        raise DailymotionPublicError("作品没有可用的公开媒体链接")
    thumbnails = data.get("thumbnails") or {}
    thumb = next((_https(v, ("dmcdn.net", "dailymotion.com")) for v in thumbnails.values() if isinstance(v, str)), "") if isinstance(thumbnails, dict) else ""
    owner = data.get("owner") if isinstance(data.get("owner"), dict) else {}
    info = VideoInfo(url=f"https://www.dailymotion.com/video/{video_id}",title=str(data.get("title") or "未命名视频")[:500],
        duration=_duration(data.get("duration")),thumbnail_url=thumb,uploader=str(owner.get("screenname") or owner.get("username") or ""),platform=Platform.DAILYMOTION,
        formats=[{"format_id":"best","ext":"mp4","resolution":"自动","vcodec":"unknown","acodec":"unknown"}])
    return info, media
