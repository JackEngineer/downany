"""Bounded anonymous public Douyin metadata, with exact work identity."""
from __future__ import annotations

import json
import re
import ssl
import urllib.error
import urllib.parse
import urllib.request

import certifi

from src.core.download_task import Platform, VideoInfo
from src.core.douyin_url import normalize_douyin_url
from src.core.error_codes import ACCESS_DENIED, NETWORK, SITE_RESPONSE_UNAVAILABLE, OutputContractError


class PublicDouyinUnavailable(OutputContractError):
    error_code = SITE_RESPONSE_UNAVAILABLE


class PublicDouyinDenied(PublicDouyinUnavailable):
    error_code = ACCESS_DENIED


class PublicDouyinNetwork(PublicDouyinUnavailable):
    error_code = NETWORK


def public_douyin_id(url: str) -> str:
    try:
        original = urllib.parse.urlsplit(url)
        if original.username or original.password or original.port:
            return ""
        parsed = urllib.parse.urlsplit(normalize_douyin_url(url))
    except ValueError:
        return ""
    match = re.fullmatch(r"/video/(\d+)", parsed.path)
    if parsed.scheme != "https" or parsed.hostname != "www.douyin.com" or parsed.username or parsed.password or parsed.port or not match:
        return ""
    return match.group(1)


def _media_address(value: object) -> str:
    if not isinstance(value, str):
        return ""
    try:
        parsed = urllib.parse.urlsplit(value)
        host = parsed.hostname or ""
        allowed = (host == "video-web-cn.douyin.com" or host in {"api-play.amemv.com", "api.amemv.com", "aweme.snssdk.com"}
                   or bool(re.fullmatch(r"v\d+-(?:web[a-z]?|dy)\.douyinvod\.com", host))
                   or bool(re.fullmatch(r"v\d+-default\.365yg\.com", host)))
        return value if parsed.scheme == "https" and allowed and not parsed.username and not parsed.password and not parsed.port else ""
    except ValueError:
        return ""


def parse_public_douyin(payload: object, url: str, quality: str = "best") -> tuple[VideoInfo, str]:
    target = public_douyin_id(url)
    if not target or not isinstance(payload, dict) or payload.get("status_code") != 0:
        raise PublicDouyinUnavailable("抖音公开响应没有可验证的作品信息")
    # Filtered/verification responses are terminal. Never take a recommendation.
    for key in ("filter_list", "verification_filter_list"):
        filters = payload.get(key) or []
        if not isinstance(filters, list) or any(not isinstance(f, dict) or str(f.get("aweme_id", "")) == target for f in filters):
            raise PublicDouyinUnavailable("抖音公开响应未提供原作品媒体；不使用推荐作品")
    details = payload.get("aweme_details")
    if not isinstance(details, list):
        raise PublicDouyinUnavailable("抖音公开响应缺少作品详情")
    matched = [d for d in details if isinstance(d, dict) and str(d.get("aweme_id", "")) == target]
    if len(matched) != 1:
        raise PublicDouyinUnavailable("抖音公开响应没有唯一匹配的原作品")
    detail = matched[0]
    video = detail.get("video")
    title = detail.get("desc")
    if not isinstance(video, dict) or detail.get("images") or not isinstance(title, str) or not title.strip():
        raise PublicDouyinUnavailable("抖音公开响应没有可验证的视频和标题")
    choices = []
    addresses = [video.get("play_addr_h264"), video.get("play_addr"), video.get("download_addr")]
    rates = video.get("bit_rate") or []
    if isinstance(rates, list):
        addresses.extend(r.get("play_addr") for r in rates if isinstance(r, dict))
    for address in addresses:
        if not isinstance(address, dict) or not isinstance(address.get("url_list"), list):
            continue
        height = address.get("height") if isinstance(address.get("height"), (int, float)) else 0
        size = address.get("data_size") if isinstance(address.get("data_size"), (int, float)) else 0
        for raw in address["url_list"]:
            media = _media_address(raw)
            if media:
                choices.append((height, size, media))
                break  # Never cycle through a denied CDN response.
    if not choices:
        raise PublicDouyinUnavailable("抖音公开响应没有可信的 HTTPS 媒体地址")
    limit = int(quality[:-1]) if re.fullmatch(r"\d+p", quality or "") else None
    eligible = [c for c in choices if c[0] and (limit is None or c[0] <= limit)]
    if not eligible:
        lowest = min(c[0] for c in choices)
        eligible = [c for c in choices if c[0] == lowest]
    # Highest requested resolution, then smallest equivalent transport.
    chosen = sorted(eligible, key=lambda c: (-c[0], c[1] if c[1] > 0 else float("inf")))[0]
    author = detail.get("author") if isinstance(detail.get("author"), dict) else {}
    cover = video.get("cover") if isinstance(video.get("cover"), dict) else {}
    covers = cover.get("url_list") if isinstance(cover.get("url_list"), list) else []
    duration = video.get("duration") if isinstance(video.get("duration"), (int, float)) else 0
    info = VideoInfo(url=f"https://www.douyin.com/video/{target}", title=title.strip()[:500],
                     duration=round(duration / 1000), uploader=str(author.get("nickname") or ""),
                     thumbnail_url=next((c for c in covers if isinstance(c, str) and c.startswith("https://")), ""),
                     platform=Platform.DOUYIN, file_size=int(chosen[1]))
    return info, chosen[2]


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def resolve_public_douyin(url: str, *, proxy: str | None = None, timeout: float = 15, quality: str = "best") -> tuple[VideoInfo, str]:
    target = public_douyin_id(url)
    if not target:
        raise PublicDouyinUnavailable("抖音链接缺少有效原作品 ID")
    endpoint = f"https://www.iesdouyin.com/web/api/v2/aweme/slidesinfo/?aweme_ids=%5B{target}%5D"
    handlers = [_NoRedirect(), urllib.request.HTTPSHandler(context=ssl.create_default_context(cafile=certifi.where()))]
    if proxy:
        handlers.append(urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
    opener = urllib.request.build_opener(*handlers)
    request = urllib.request.Request(endpoint, headers={"Accept": "application/json"})
    try:
        with opener.open(request, timeout=min(max(timeout, .1), 15)) as response:
            body = response.read(2 * 1024 * 1024 + 1)
            if len(body) > 2 * 1024 * 1024:
                raise PublicDouyinUnavailable("抖音公开响应过大，未开始下载")
            payload = json.loads(body)
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            raise PublicDouyinDenied("HTTP Error 403: 抖音拒绝了公开媒体解析；未继续请求") from None
        raise PublicDouyinUnavailable("抖音公开接口没有返回可用信息") from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise PublicDouyinNetwork("抖音公开接口连接失败") from None
    except (ValueError, UnicodeError):
        raise PublicDouyinUnavailable("抖音公开接口没有返回有效 JSON") from None
    return parse_public_douyin(payload, url, quality)
