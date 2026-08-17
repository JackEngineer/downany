"""
搜索引擎，支持在平台内搜索视频。
"""
import html
import json
import re
import urllib.parse
import urllib.request
from typing import List, Optional

import yt_dlp

from src.core.download_task import Platform, VideoInfo
from src.core.http_headers import DEFAULT_HTTP_HEADERS
from src.core.ytdlp_opts import REMOTE_COMPONENTS
from src.utils.logger import setup_logger

logger = setup_logger("SearchEngine")

_HTML_TAG_RE = re.compile(r"<[^>]+>")


class SearchError(Exception):
    """搜索失败（区别于空结果）。"""


class SearchEngine:
    """搜索引擎类"""

    SEARCH_PREFIXES = {
        Platform.YOUTUBE: "ytsearch",
    }
    SEARCHABLE_PLATFORMS = frozenset({Platform.YOUTUBE, Platform.BILIBILI})

    @staticmethod
    def supports(platform: Platform) -> bool:
        return platform in SearchEngine.SEARCHABLE_PLATFORMS

    @staticmethod
    def _build_fallback_thumbnail(platform: Platform, entry: dict) -> str:
        thumbnail = entry.get("thumbnail") or ""
        if thumbnail:
            return thumbnail

        if platform == Platform.YOUTUBE:
            video_id = (entry.get("id") or "").strip()
            if video_id:
                return f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"
        return ""

    @staticmethod
    def _duration_seconds(value: object) -> int:
        if isinstance(value, (int, float)):
            return max(0, int(value))
        try:
            parts = [int(part) for part in str(value or "").split(":")]
        except ValueError:
            return 0
        if not parts or any(part < 0 for part in parts):
            return 0
        total = 0
        for part in parts:
            total = total * 60 + part
        return total

    @staticmethod
    def _search_bilibili(
        query: str,
        max_results: int,
        proxy: Optional[str],
    ) -> List[VideoInfo]:
        limit = max(0, max_results)
        if limit == 0:
            return []

        opener = urllib.request.build_opener()
        if proxy:
            opener.add_handler(
                urllib.request.ProxyHandler({"http": proxy, "https": proxy})
            )

        videos: List[VideoInfo] = []
        page_count = (limit + 19) // 20
        for page in range(1, page_count + 1):
            params = urllib.parse.urlencode(
                {
                    "Search_key": query,
                    "keyword": query,
                    "page": page,
                    "context": "",
                    "duration": 0,
                    "tids_2": "",
                    "__refresh__": "true",
                    "search_type": "video",
                    "tids": 0,
                    "highlight": 1,
                }
            )
            request = urllib.request.Request(
                "https://api.bilibili.com/x/web-interface/search/type?" + params,
                headers={
                    "User-Agent": DEFAULT_HTTP_HEADERS["User-Agent"],
                    "Accept": "application/json",
                    "Accept-Language": DEFAULT_HTTP_HEADERS.get(
                        "Accept-Language", "en-US,en;q=0.9"
                    ),
                    "Referer": "https://search.bilibili.com/",
                },
            )
            with opener.open(request, timeout=6) as response:
                payload = json.loads(
                    response.read().decode("utf-8", errors="replace")
                )
            if not isinstance(payload, dict) or str(payload.get("code")) != "0":
                message = (
                    str(payload.get("message") or "Bilibili 搜索失败")
                    if isinstance(payload, dict)
                    else "Bilibili 搜索响应无效"
                )
                raise SearchError(message)
            data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
            entries = data.get("result") if isinstance(data.get("result"), list) else []
            if not entries:
                break

            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                bvid = str(entry.get("bvid") or "").strip()
                aid = str(entry.get("aid") or entry.get("id") or "").strip()
                url = (
                    f"https://www.bilibili.com/video/{bvid}"
                    if bvid
                    else str(entry.get("arcurl") or "").strip()
                )
                if not url and aid:
                    url = f"https://www.bilibili.com/video/av{aid}"
                if url.startswith("http://"):
                    url = "https://" + url.removeprefix("http://")
                if not url:
                    continue

                title = html.unescape(
                    _HTML_TAG_RE.sub("", str(entry.get("title") or ""))
                ).strip()
                thumbnail = str(entry.get("pic") or "").strip()
                if thumbnail.startswith("//"):
                    thumbnail = "https:" + thumbnail
                elif thumbnail.startswith("http://"):
                    thumbnail = "https://" + thumbnail.removeprefix("http://")
                videos.append(
                    VideoInfo(
                        url=url,
                        title=title or "未命名视频",
                        duration=SearchEngine._duration_seconds(
                            entry.get("duration")
                        ),
                        thumbnail_url=thumbnail,
                        uploader=str(entry.get("author") or "未知").strip(),
                        platform=Platform.BILIBILI,
                    )
                )
                if len(videos) >= limit:
                    return videos
        return videos

    @staticmethod
    def search(
        platform: Platform,
        query: str,
        max_results: int = 20,
        proxy: Optional[str] = None,
    ) -> List[VideoInfo]:
        if not SearchEngine.supports(platform):
            raise SearchError(f"平台 {platform.value} 不支持搜索")

        try:
            if platform == Platform.BILIBILI:
                videos = SearchEngine._search_bilibili(
                    query, max_results, proxy
                )
                logger.info(
                    "搜索完成: %s - %s - 找到 %d 个结果",
                    platform.value,
                    query,
                    len(videos),
                )
                return videos

            search_prefix = SearchEngine.SEARCH_PREFIXES[platform]
            search_query = f"{search_prefix}{max_results}:{query}"
            headers = dict(DEFAULT_HTTP_HEADERS)
            headers.update(
                {
                    "Accept-Encoding": "gzip, deflate",
                    "DNT": "1",
                    "Connection": "keep-alive",
                    "Upgrade-Insecure-Requests": "1",
                }
            )
            ydl_opts = {
                "quiet": True,
                "no_warnings": True,
                "extract_flat": True,
                "no_color": True,
                "http_headers": headers,
                "remote_components": REMOTE_COMPONENTS,
            }
            if proxy:
                ydl_opts["proxy"] = proxy
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                result = ydl.extract_info(search_query, download=False)

            if not result or "entries" not in result:
                return []

            entries = [entry for entry in result["entries"] or [] if entry]
            videos = []
            for entry in entries:
                duration = entry.get("duration")
                if duration is None:
                    duration = 0

                url = entry.get("webpage_url") or entry.get("url") or ""
                if url and not url.startswith("http"):
                    # 扁平提取（extract_flat）常只返回平台内 ID，补全为完整 URL 以便直接入队
                    url = f"https://www.youtube.com/watch?v={url}"
                video_info = VideoInfo(
                    url=url,
                    title=entry.get("title") or "未命名视频",
                    duration=int(duration) if duration else 0,
                    thumbnail_url=SearchEngine._build_fallback_thumbnail(platform, entry),
                    uploader=entry.get("uploader") or "未知",
                    platform=platform,
                )
                if not video_info.url:
                    continue
                videos.append(video_info)

            logger.info(f"搜索完成: {platform.value} - {query} - 找到 {len(videos)} 个结果")
            return videos

        except SearchError:
            raise
        except Exception as e:
            logger.error(f"搜索失败: {str(e)}")
            raise SearchError(str(e)) from e
