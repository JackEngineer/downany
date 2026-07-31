"""
视频信息提取器，使用 yt-dlp 提取视频元数据。
"""
from typing import Any, Dict, List, Optional

import yt_dlp

from src.core.download_task import VideoInfo
from src.core.douyin_url import is_douyin_url, normalize_douyin_url
from src.core.http_headers import DEFAULT_HTTP_HEADERS
from src.core.platform_detector import PlatformDetector, normalize_thumbnail_url, pick_thumbnail_from_ydl_info
from src.core.twitter_fallback import is_twitter_url
from src.core.ytdlp_opts import REMOTE_COMPONENTS
from src.utils.logger import setup_logger

logger = setup_logger("VideoInfoExtractor")


class VideoInfoExtractor:
    """视频信息提取器类"""

    @staticmethod
    def extract(
        url: str,
        proxy: Optional[str] = None,
        http_headers: Optional[Dict[str, str]] = None,
    ) -> Optional[VideoInfo]:
        if is_douyin_url(url):
            url = normalize_douyin_url(url)
        headers = dict(DEFAULT_HTTP_HEADERS)
        if http_headers:
            headers.update(http_headers)
        ydl_opts = {
            "quiet": True,
            "no_warnings": True,
            "extract_flat": False,
            "no_color": True,
            "http_headers": headers,
            # YouTube JS challenge 求解需要 EJS solver（见 ytdlp_opts）
            "remote_components": REMOTE_COMPONENTS,
        }

        if proxy:
            ydl_opts["proxy"] = proxy

        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)

            if not info:
                return None

            platform = PlatformDetector.detect(url)

            formats: List[Dict[str, Any]] = []
            for fmt in info.get("formats") or []:
                formats.append(
                    {
                        "format_id": fmt.get("format_id", ""),
                        "ext": fmt.get("ext", ""),
                        "resolution": fmt.get("resolution", "暂无"),
                        "filesize": fmt.get("filesize", 0),
                        "vcodec": fmt.get("vcodec", "none"),
                        "acodec": fmt.get("acodec", "none"),
                        "fps": fmt.get("fps", 0),
                    }
                )

            duration = info.get("duration")
            if duration is None:
                duration = 0

            video_info = VideoInfo(
                url=url,
                title=info.get("title") or "未命名视频",
                duration=int(duration) if duration else 0,
                thumbnail_url=pick_thumbnail_from_ydl_info(info)
                or normalize_thumbnail_url(info.get("thumbnail") or ""),
                uploader=info.get("uploader") or "未知",
                platform=platform,
                file_size=info.get("filesize", 0) or info.get("filesize_approx", 0) or 0,
                formats=formats,
            )

            logger.info(f"成功提取视频信息: {video_info.title}")
            return video_info

        except Exception as e:
            logger.error(f"提取视频信息失败: {str(e)}")
            # X/Twitter：yt-dlp GraphQL 常失败，用 FxTwitter 补元数据（标题/封面）
            if is_twitter_url(url):
                try:
                    from src.core.twitter_fallback import resolve_twitter_media

                    info, _direct = resolve_twitter_media(url, proxy=proxy)
                    logger.info("Twitter 元数据已由 FxTwitter 回退补齐: %s", info.title[:40])
                    return info
                except Exception as fallback_exc:
                    logger.error("Twitter 元数据回退失败: %s", fallback_exc)
            return None

    @staticmethod
    def get_format_description(fmt: Dict[str, Any]) -> str:
        parts = []

        resolution = fmt.get("resolution", "暂无")
        if resolution != "暂无":
            parts.append(resolution)

        ext = fmt.get("ext", "")
        if ext:
            parts.append(ext.upper())

        vcodec = fmt.get("vcodec", "none")
        acodec = fmt.get("acodec", "none")

        if vcodec != "none" and acodec != "none":
            parts.append("视频+音频")
        elif vcodec != "none":
            parts.append("仅视频")
        elif acodec != "none":
            parts.append("仅音频")

        filesize = fmt.get("filesize", 0) or 0
        if filesize > 0:
            size_mb = filesize / (1024 * 1024)
            parts.append(f"{size_mb:.1f}MB")

        return " | ".join(parts) if parts else "未知格式"
