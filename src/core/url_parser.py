"""可取消、带超时的 URL 解析。以子进程方式运行 yt-dlp，可被真正中断。"""
from __future__ import annotations

import json
import subprocess
import sys
import threading
from typing import List, Optional

from src.core.download_task import VideoInfo
from src.core.platform_detector import PlatformDetector
from src.utils.logger import setup_logger

logger = setup_logger("UrlParser")

DEFAULT_PARSE_TIMEOUT = 30.0


class ParseCancelled(Exception):
    """解析被用户取消。"""


class ParseTimeout(Exception):
    """解析超时。"""


class ParseFailed(Exception):
    """解析失败（无效链接、网络错误等）。"""


def build_parse_command(url: str, proxy: Optional[str] = None) -> List[str]:
    cmd = [
        sys.executable,
        "-m",
        "yt_dlp",
        "--dump-single-json",
        "--no-playlist",
        "--no-warnings",
        "--no-color",
    ]
    if proxy:
        cmd += ["--proxy", proxy]
    cmd.append(url)
    return cmd


class ParseSession:
    """单个 URL 的解析会话。cancel() 可从任意线程调用。"""

    def __init__(
        self,
        url: str,
        proxy: Optional[str] = None,
        timeout: float = DEFAULT_PARSE_TIMEOUT,
    ):
        self.url = url
        self.proxy = proxy
        self.timeout = timeout
        self._lock = threading.Lock()
        self._process: Optional[subprocess.Popen] = None
        self._cancelled = False

    def cancel(self) -> None:
        with self._lock:
            self._cancelled = True
            if self._process is not None and self._process.poll() is None:
                self._process.terminate()

    def run(self) -> VideoInfo:
        """阻塞执行解析。由调用方决定放在哪个线程。"""
        with self._lock:
            if self._cancelled:
                raise ParseCancelled(self.url)
            self._process = subprocess.Popen(
                build_parse_command(self.url, self.proxy),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            process = self._process

        try:
            stdout, stderr = process.communicate(timeout=self.timeout)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()
            raise ParseTimeout(f"解析超时（{self.timeout:.0f} 秒）: {self.url}")

        if self._cancelled:
            raise ParseCancelled(self.url)
        if process.returncode != 0:
            message = stderr.strip().splitlines()[-1] if stderr.strip() else "未知错误"
            raise ParseFailed(message)

        try:
            info = json.loads(stdout)
        except json.JSONDecodeError as exc:
            raise ParseFailed(f"解析输出无法读取: {exc}") from exc
        return self._to_video_info(info)

    def _to_video_info(self, info: dict) -> VideoInfo:
        duration = info.get("duration") or 0
        return VideoInfo(
            url=self.url,
            title=info.get("title") or "未命名视频",
            duration=int(duration) if duration else 0,
            thumbnail_url=info.get("thumbnail") or "",
            uploader=info.get("uploader") or "未知",
            platform=PlatformDetector.detect(self.url),
            file_size=info.get("filesize", 0) or info.get("filesize_approx", 0) or 0,
        )
