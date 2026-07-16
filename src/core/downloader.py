import os
from typing import Callable, Optional, Dict, Any

import yt_dlp

from src.core.http_headers import DEFAULT_HTTP_HEADERS
from src.utils.logger import setup_logger

logger = setup_logger("CoreDownloader")


class DownloadCancelled(Exception):
    """用户取消或暂停导致的下载中断。"""


class DownloadError(Exception):
    """下载失败。"""


class Downloader:
    """
    基于 yt-dlp 的下载器核心类。
    负责处理下载逻辑、进度回调和配置管理。
    """

    def __init__(self, download_dir: str = "downloads"):
        self.download_dir = download_dir
        os.makedirs(self.download_dir, exist_ok=True)

        self.progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None
        self.finished_callback: Optional[Callable[[], None]] = None
        self.error_callback: Optional[Callable[[str], None]] = None
        self.last_filename: str = ""

    def set_callbacks(
        self,
        progress: Optional[Callable] = None,
        finished: Optional[Callable] = None,
        error: Optional[Callable] = None,
    ):
        self.progress_callback = progress
        self.finished_callback = finished
        self.error_callback = error

    def _progress_hook(self, d: Dict[str, Any]):
        status = d.get("status")
        if status == "downloading":
            filename = d.get("filename") or d.get("tmpfilename")
            if filename:
                self.last_filename = filename
            if self.progress_callback:
                self.progress_callback(d)
        elif status == "finished":
            filename = d.get("filename")
            if filename:
                self.last_filename = filename
            logger.info(f"下载完成: {filename}")

    def download(self, url: str, opts: Optional[Dict[str, Any]] = None) -> str:
        """
        执行下载任务。

        Returns:
            最终文件路径（若可确定），否则为空字符串。

        Raises:
            DownloadCancelled: 用户取消/暂停
            DownloadError: 其它下载失败
        """
        project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        local_ffmpeg = os.path.join(project_root, "bin", "ffmpeg")

        ffmpeg_location = None
        if os.path.exists(local_ffmpeg) and os.access(local_ffmpeg, os.X_OK):
            ffmpeg_location = local_ffmpeg
            logger.info(f"使用本地 FFmpeg: {local_ffmpeg}")

        ydl_opts = {
            "format": "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
            "outtmpl": os.path.join(self.download_dir, "%(title)s.%(ext)s"),
            "progress_hooks": [self._progress_hook],
            "noplaylist": True,
            "no_color": True,
            "http_headers": dict(DEFAULT_HTTP_HEADERS),
        }

        if ffmpeg_location:
            ydl_opts["ffmpeg_location"] = ffmpeg_location

        if opts:
            ydl_opts.update(opts)

        logger.info(f"开始下载: {url}")
        self.last_filename = ""

        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                ydl.download([url])

            if self.finished_callback:
                self.finished_callback()

            return self.last_filename
        except DownloadCancelled:
            raise
        except Exception as e:
            error_msg = f"下载出错: {str(e)}"
            logger.error(error_msg)
            if self.error_callback:
                self.error_callback(str(e))
            if isinstance(e, DownloadCancelled):
                raise
            # yt-dlp 可能把 hook 里抛出的异常包一层
            cause = e.__cause__ or e.__context__
            if isinstance(e, DownloadCancelled) or isinstance(cause, DownloadCancelled):
                raise DownloadCancelled(str(e)) from e
            if "任务已取消" in str(e) or "任务已暂停" in str(e):
                raise DownloadCancelled(str(e)) from e
            raise DownloadError(str(e)) from e
