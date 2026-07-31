import os
import re
from pathlib import Path
from typing import Any, Callable, Dict, Optional

import yt_dlp

from src.core.download_task import VideoInfo
from src.core.http_headers import DEFAULT_HTTP_HEADERS
from src.core.twitter_fallback import is_twitter_url, resolve_twitter_media
from src.core.ytdlp_opts import REMOTE_COMPONENTS
from src.sidecar.bin_paths import resolve_ffmpeg_path
from src.utils.logger import setup_logger

logger = setup_logger("CoreDownloader")


class _YtDlpQuietLogger:
    """把 yt-dlp 诊断输出转到 stderr logger，避免污染 Sidecar stdout。"""

    def debug(self, msg: str) -> None:
        if msg.startswith("[debug] "):
            return
        logger.debug("%s", msg)

    def info(self, msg: str) -> None:
        logger.info("%s", msg)

    def warning(self, msg: str) -> None:
        logger.warning("%s", msg)

    def error(self, msg: str) -> None:
        logger.error("%s", msg)


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
        # Twitter FxTwitter 回退解析到的元数据（供 DownloadManager 回填标题）
        self.last_info: Optional[VideoInfo] = None

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
        project_root = Path(__file__).resolve().parents[2]
        ffmpeg_path = resolve_ffmpeg_path(project_root=project_root)
        ffmpeg_location = str(ffmpeg_path) if ffmpeg_path is not None else None
        if ffmpeg_location:
            logger.info(f"使用本地 FFmpeg: {ffmpeg_location}")

        ydl_opts = {
            "format": "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
            "outtmpl": os.path.join(self.download_dir, "%(title)s.%(ext)s"),
            "progress_hooks": [self._progress_hook],
            "noplaylist": True,
            "no_color": True,
            # Sidecar 协议占用 stdout：禁止进度条与常规输出写到 stdout
            "quiet": True,
            "no_warnings": True,
            "noprogress": True,
            "logger": _YtDlpQuietLogger(),
            "http_headers": dict(DEFAULT_HTTP_HEADERS),
            # YouTube JS challenge（nsig/signature）求解，缺了只剩低画质格式
            "remote_components": REMOTE_COMPONENTS,
        }

        if ffmpeg_location:
            ydl_opts["ffmpeg_location"] = ffmpeg_location

        if opts:
            ydl_opts.update(opts)

        logger.info(f"开始下载: {url}")
        self.last_filename = ""
        self.last_info = None

        try:
            self._download_with_ydl(url, ydl_opts)
            if self.finished_callback:
                self.finished_callback()
            return self.last_filename
        except DownloadCancelled:
            raise
        except Exception as e:
            if is_twitter_url(url):
                try:
                    info, direct = resolve_twitter_media(url)
                    self.last_info = info
                    logger.info("Twitter 下载改用 FxTwitter 直链")
                    # 直链用简单格式，避免合并策略失败；用推文标题命名文件
                    fallback_opts = dict(ydl_opts)
                    fallback_opts["format"] = "best"
                    safe = re.sub(r'[\\/:*?"<>|]', " ", info.title).strip()
                    safe = re.sub(r"\s+", " ", safe)[:80] or "twitter"
                    fallback_opts["outtmpl"] = os.path.join(
                        self.download_dir, f"{safe}.%(ext)s"
                    )
                    self._download_with_ydl(direct, fallback_opts)
                    if self.finished_callback:
                        self.finished_callback()
                    return self.last_filename
                except DownloadCancelled:
                    raise
                except Exception as fallback_exc:
                    logger.error("Twitter FxTwitter 下载回退失败: %s", fallback_exc)
                    e = fallback_exc

            error_msg = f"下载出错: {str(e)}"
            logger.error(error_msg)
            if self.error_callback:
                self.error_callback(str(e))
            if isinstance(e, DownloadCancelled):
                raise
            cause = e.__cause__ or e.__context__
            if isinstance(e, DownloadCancelled) or isinstance(cause, DownloadCancelled):
                raise DownloadCancelled(str(e)) from e
            if "任务已取消" in str(e) or "任务已暂停" in str(e):
                raise DownloadCancelled(str(e)) from e
            raise DownloadError(str(e)) from e

    def _download_with_ydl(self, url: str, ydl_opts: Dict[str, Any]) -> None:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])
