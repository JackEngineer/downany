import yt_dlp
import os
from typing import Callable, Optional, Dict, Any
from src.utils.logger import setup_logger

logger = setup_logger("CoreDownloader")

class Downloader:
    """
    基于 yt-dlp 的下载器核心类。
    负责处理下载逻辑、进度回调和配置管理。
    """

    def __init__(self, download_dir: str = "downloads"):
        """
        初始化下载器。

        Args:
            download_dir: 下载保存目录，默认为当前目录下的 downloads 文件夹
        """
        self.download_dir = download_dir
        if not os.path.exists(self.download_dir):
            os.makedirs(self.download_dir)
        
        self.progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None
        self.finished_callback: Optional[Callable[[], None]] = None
        self.error_callback: Optional[Callable[[str], None]] = None

    def set_callbacks(self, 
                      progress: Optional[Callable] = None, 
                      finished: Optional[Callable] = None,
                      error: Optional[Callable] = None):
        """
        设置回调函数。

        Args:
            progress: 进度回调，接收一个字典参数
            finished: 完成回调，无参数
            error: 错误回调，接收一个字符串参数 (错误信息)
        """
        self.progress_callback = progress
        self.finished_callback = finished
        self.error_callback = error

    def _progress_hook(self, d: Dict[str, Any]):
        """
        yt-dlp 的进度钩子函数。
        """
        if d['status'] == 'downloading':
            if self.progress_callback:
                self.progress_callback(d)
        elif d['status'] == 'finished':
            logger.info(f"下载完成: {d.get('filename')}")
            # 注意：yt-dlp 的 finished 状态是在下载完成后，但在后处理（如合并）之前
            # 真正的“全部完成”通常需要等待 process 结束，或者在这里只通知下载阶段结束

    def download(self, url: str, opts: Optional[Dict[str, Any]] = None):
        """
        执行下载任务。

        Args:
            url: 视频链接
            opts: 额外的 yt-dlp 配置选项
        """
        # 基础配置
        # --- 自动检测本地 ffmpeg ---
        project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        local_ffmpeg = os.path.join(project_root, 'bin', 'ffmpeg')
        
        ffmpeg_location = None
        if os.path.exists(local_ffmpeg) and os.access(local_ffmpeg, os.X_OK):
            ffmpeg_location = local_ffmpeg
            logger.info(f"使用本地 FFmpeg: {local_ffmpeg}")
        # -------------------------

        ydl_opts = {
            'format': 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',  # 优先下载 MP4
            'outtmpl': os.path.join(self.download_dir, '%(title)s.%(ext)s'),
            'progress_hooks': [self._progress_hook],
            'noplaylist': True,  # 默认不下载列表
            'http_headers': {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
            },
            # 'quiet': True,
            # 'no_warnings': True,
        }

        if ffmpeg_location:
            ydl_opts['ffmpeg_location'] = ffmpeg_location

        # 合并传入的配置
        if opts:
            ydl_opts.update(opts)

        logger.info(f"开始下载: {url}")
        
        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                ydl.download([url])
            
            if self.finished_callback:
                self.finished_callback()
                
        except Exception as e:
            error_msg = f"下载出错: {str(e)}"
            logger.error(error_msg)
            if self.error_callback:
                self.error_callback(str(e))
