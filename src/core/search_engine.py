"""
搜索引擎，支持在平台内搜索视频。
"""
from typing import List, Optional

import yt_dlp

from src.core.download_task import Platform, VideoInfo
from src.core.http_headers import DEFAULT_HTTP_HEADERS
from src.core.ytdlp_opts import REMOTE_COMPONENTS
from src.utils.logger import setup_logger

logger = setup_logger("SearchEngine")


class SearchError(Exception):
    """搜索失败（区别于空结果）。"""


class SearchEngine:
    """搜索引擎类"""

    SEARCH_PREFIXES = {
        Platform.YOUTUBE: "ytsearch",
        Platform.BILIBILI: "bilisearch",
        Platform.PORNHUB: "phsearch",
    }

    @staticmethod
    def supports(platform: Platform) -> bool:
        return platform in SearchEngine.SEARCH_PREFIXES

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
    def search(
        platform: Platform,
        query: str,
        max_results: int = 20,
        proxy: Optional[str] = None,
    ) -> List[VideoInfo]:
        if platform not in SearchEngine.SEARCH_PREFIXES:
            raise SearchError(f"平台 {platform.value} 不支持搜索")

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

        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                result = ydl.extract_info(search_query, download=False)

            if not result or "entries" not in result:
                return []

            videos = []
            for entry in result["entries"] or []:
                if not entry:
                    continue

                duration = entry.get("duration")
                if duration is None:
                    duration = 0

                url = entry.get("webpage_url") or entry.get("url") or ""
                if url and not url.startswith("http"):
                    # 扁平提取（extract_flat）常只返回平台内 ID，补全为完整 URL 以便直接入队
                    if platform == Platform.YOUTUBE:
                        url = f"https://www.youtube.com/watch?v={url}"
                    elif platform == Platform.BILIBILI:
                        url = f"https://www.bilibili.com/video/{url}"
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
