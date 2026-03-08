"""
视频信息提取器，使用 yt-dlp 提取视频元数据。
"""
import yt_dlp
from typing import Optional, Dict, Any, List
from src.core.download_task import VideoInfo, Platform
from src.core.platform_detector import PlatformDetector
from src.utils.logger import setup_logger

logger = setup_logger("VideoInfoExtractor")


class VideoInfoExtractor:
    """视频信息提取器类"""

    @staticmethod
    def extract(url: str, proxy: Optional[str] = None) -> Optional[VideoInfo]:
        """
        提取视频信息。

        Args:
            url: 视频 URL
            proxy: 代理地址 (可选)

        Returns:
            VideoInfo 对象，失败返回 None
        """
        ydl_opts = {
            'quiet': True,
            'no_warnings': True,
            'extract_flat': False,
            'no_color': True,
            'http_headers': {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
            },
        }

        if proxy:
            ydl_opts['proxy'] = proxy

        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)

            if not info:
                return None

            # 检测平台
            platform = PlatformDetector.detect(url)

            # 提取格式列表
            formats = []
            if 'formats' in info:
                for fmt in info['formats']:
                    formats.append({
                        'format_id': fmt.get('format_id', ''),
                        'ext': fmt.get('ext', ''),
                        'resolution': fmt.get('resolution', 'N/A'),
                        'filesize': fmt.get('filesize', 0),
                        'vcodec': fmt.get('vcodec', 'none'),
                        'acodec': fmt.get('acodec', 'none'),
                        'fps': fmt.get('fps', 0),
                    })

            # 创建 VideoInfo 对象
            video_info = VideoInfo(
                url=url,
                title=info.get('title', 'Unknown'),
                duration=info.get('duration', 0),
                thumbnail_url=info.get('thumbnail', ''),
                uploader=info.get('uploader', 'Unknown'),
                platform=platform,
                file_size=info.get('filesize', 0) or info.get('filesize_approx', 0),
                formats=formats
            )

            logger.info(f"成功提取视频信息: {video_info.title}")
            return video_info

        except Exception as e:
            logger.error(f"提取视频信息失败: {str(e)}")
            return None

    @staticmethod
    def get_format_description(fmt: Dict[str, Any]) -> str:
        """
        获取格式描述字符串。

        Args:
            fmt: 格式字典

        Returns:
            格式描述字符串
        """
        parts = []

        resolution = fmt.get('resolution', 'N/A')
        if resolution != 'N/A':
            parts.append(resolution)

        ext = fmt.get('ext', '')
        if ext:
            parts.append(ext.upper())

        vcodec = fmt.get('vcodec', 'none')
        acodec = fmt.get('acodec', 'none')

        if vcodec != 'none' and acodec != 'none':
            parts.append('视频+音频')
        elif vcodec != 'none':
            parts.append('仅视频')
        elif acodec != 'none':
            parts.append('仅音频')

        filesize = fmt.get('filesize', 0)
        if filesize > 0:
            size_mb = filesize / (1024 * 1024)
            parts.append(f'{size_mb:.1f}MB')

        return ' | '.join(parts) if parts else 'Unknown'

