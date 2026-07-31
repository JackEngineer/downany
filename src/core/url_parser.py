"""可取消、带超时的 URL 解析。以子进程方式运行 yt-dlp，可被真正中断。"""
from __future__ import annotations

import json
import subprocess
import sys
import threading
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from src.core.download_task import VideoInfo
from src.core.douyin_url import is_douyin_url, normalize_douyin_url
from src.core.formats import summarize_formats
from src.core.platform_detector import PlatformDetector
from src.core.twitter_fallback import (
    is_twitter_url,
    normalize_twitter_url,
    resolve_twitter_media,
)
from src.utils.logger import setup_logger

logger = setup_logger("UrlParser")

DEFAULT_PARSE_TIMEOUT = 30.0


class ParseCancelled(Exception):
    """解析被用户取消。"""


class ParseTimeout(Exception):
    """解析超时。"""


class ParseFailed(Exception):
    """解析失败（无效链接、网络错误等）。"""


@dataclass
class ParseResult:
    """解析结果：单视频元数据 + 可选播放列表条目摘要。"""
    info: VideoInfo
    entries: List[Dict[str, str]] = field(default_factory=list)


def build_parse_command(
    url: str,
    proxy: Optional[str] = None,
    *,
    allow_playlist: bool = False,
) -> List[str]:
    cmd = [
        sys.executable,
        "-m",
        "yt_dlp",
        "--dump-single-json",
        "--no-warnings",
        "--no-color",
    ]
    if not allow_playlist:
        cmd.append("--no-playlist")
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
        *,
        allow_playlist: bool = False,
    ):
        cleaned = (url or "").strip()
        if is_twitter_url(cleaned):
            cleaned = normalize_twitter_url(cleaned)
        elif is_douyin_url(cleaned):
            cleaned = normalize_douyin_url(cleaned)
        self.url = cleaned
        self.proxy = proxy
        self.timeout = timeout
        self.allow_playlist = allow_playlist
        self._lock = threading.Lock()
        self._process: Optional[subprocess.Popen] = None
        self._cancelled = False

    def cancel(self) -> None:
        with self._lock:
            self._cancelled = True
            if self._process is not None and self._process.poll() is None:
                self._process.terminate()

    def run(self) -> ParseResult:
        """阻塞执行解析。由调用方决定放在哪个线程。"""
        try:
            return self._run_ytdlp()
        except ParseCancelled:
            raise
        except ParseTimeout:
            raise
        except ParseFailed as primary:
            if not is_twitter_url(self.url):
                raise
            if self._cancelled:
                raise ParseCancelled(self.url)
            try:
                info, _direct = resolve_twitter_media(self.url, proxy=self.proxy)
                logger.info("Twitter 解析改用 FxTwitter 回退: %s", self.url)
                return ParseResult(info=info)
            except Exception as fallback_exc:
                logger.warning(
                    "Twitter FxTwitter 回退失败: %s (%s)",
                    fallback_exc,
                    primary,
                )
                raise ParseFailed(
                    self._friendly_twitter_error(primary, fallback_exc)
                ) from fallback_exc

    def _friendly_twitter_error(self, primary: Exception, fallback: Exception) -> str:
        text = f"{primary}; 回退亦失败: {fallback}"
        lower = text.lower()
        if "unavailable" in lower or "no video" in lower or "没有可下载视频" in text:
            return "该推文没有可下载视频（可能已删除、受限，或需登录可见）"
        return text

    def _run_ytdlp(self) -> ParseResult:
        with self._lock:
            if self._cancelled:
                raise ParseCancelled(self.url)
            self._process = subprocess.Popen(
                build_parse_command(
                    self.url,
                    self.proxy,
                    allow_playlist=self.allow_playlist,
                ),
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
        if not isinstance(info, dict):
            raise ParseFailed("解析结果为空")
        return self._to_parse_result(info)

    def _summarize_entries(self, info: dict) -> List[Dict[str, str]]:
        entries: List[Dict[str, str]] = []
        for entry in info.get("entries") or []:
            if not isinstance(entry, dict):
                continue
            entry_url = (
                str(entry.get("url") or entry.get("webpage_url") or "").strip()
            )
            entries.append(
                {
                    "id": str(entry.get("id") or ""),
                    "title": str(entry.get("title") or ""),
                    "url": entry_url,
                }
            )
        return entries

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
            formats=summarize_formats(info.get("formats")),
        )

    def _to_parse_result(self, info: dict) -> ParseResult:
        entries = self._summarize_entries(info) if self.allow_playlist else []
        return ParseResult(info=self._to_video_info(info), entries=entries)
