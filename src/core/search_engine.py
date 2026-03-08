"""
搜索引擎，支持在平台内搜索视频。
"""
import yt_dlp
from typing import List, Optional
from src.core.download_task import VideoInfo, Platform
from src.core.platform_detector import PlatformDetector
from src.utils.logger import setup_logger

logger = setup_logger("SearchEngine")


class SearchEngine:
    """搜索引擎类"""

    # 平台搜索前缀
    SEARCH_PREFIXES = {
        Platform.YOUTUBE: "ytsearch",
        Platform.BILIBILI: "bilisearch",
    }

    @staticmethod
    def search(platform: Platform, query: str, max_results: int = 20, proxy: Optional[str] = None) -> List[VideoInfo]:
        """
        在指定平台搜索视频。

        Args:
            platform: 平台枚举
            query: 搜索关键词
            max_results: 最大结果数
            proxy: 代理地址 (可选)

        Returns:
            VideoInfo 列表
        """
        # 检查平台是否支持搜索
        if platform not in SearchEngine.SEARCH_PREFIXES:
            logger.warning(f"平台 {platform.value} 不支持搜索")
            return []

        # 构建搜索查询
        search_prefix = SearchEngine.SEARCH_PREFIXES[platform]
        search_query = f"{search_prefix}{max_results}:{query}"

        ydl_opts = {
            'quiet': True,
            'no_warnings': True,
            'extract_flat': True,  # 只提取基本信息，不下载
            'no_color': True,  # 禁用颜色输出
            'http_headers': {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate',
                'DNT': '1',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1',
            },
        }

        if proxy:
            ydl_opts['proxy'] = proxy

        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                result = ydl.extract_info(search_query, download=False)

            if not result or 'entries' not in result:
                return []

            videos = []
            for entry in result['entries']:
                if not entry:
                    continue

                video_info = VideoInfo(
                    url=entry.get('url', '') or entry.get('webpage_url', ''),
                    title=entry.get('title', 'Unknown'),
                    duration=entry.get('duration', 0),
                    thumbnail_url=entry.get('thumbnail', ''),
                    uploader=entry.get('uploader', 'Unknown'),
                    platform=platform,
                )
                videos.append(video_info)

            logger.info(f"搜索完成: {platform.value} - {query} - 找到 {len(videos)} 个结果")
            return videos

        except Exception as e:
            logger.error(f"搜索失败: {str(e)}")
            return []
