"""可取消、带超时的 URL 解析。以子进程方式运行 yt-dlp，可被真正中断。"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import threading
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from src.core.download_task import VideoInfo
from src.core.douyin_url import is_douyin_url, normalize_douyin_url
from src.core.formats import summarize_formats
from src.core.http_headers import DEFAULT_HTTP_HEADERS
from src.core.platform_detector import PlatformDetector
from src.core.twitter_fallback import (
    is_twitter_url,
    normalize_twitter_url,
    resolve_twitter_media,
)
from src.utils.logger import setup_logger

logger = setup_logger("UrlParser")

DEFAULT_PARSE_TIMEOUT = 30.0
_BVID_RE = re.compile(r"^BV[0-9A-Za-z]+$")


def fetch_bilibili_view(bvid: str, proxy: Optional[str] = None) -> Tuple[str, str]:
    """查 B 站公开详情，返回 (title, thumbnail_url)。失败则空串。"""
    bid = (bvid or "").strip()
    if not _BVID_RE.match(bid):
        return "", ""
    api = f"https://api.bilibili.com/x/web-interface/view?bvid={bid}"
    headers = {
        "User-Agent": DEFAULT_HTTP_HEADERS["User-Agent"],
        "Accept": "application/json",
        "Accept-Language": DEFAULT_HTTP_HEADERS.get("Accept-Language", "en-US,en;q=0.9"),
        "Referer": "https://www.bilibili.com",
    }
    request = urllib.request.Request(api, headers=headers)
    opener = urllib.request.build_opener()
    if proxy:
        opener.add_handler(urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
    try:
        with opener.open(request, timeout=6) as resp:
            payload = json.loads(resp.read().decode("utf-8", errors="replace"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as exc:
        logger.debug("bilibili view 失败 %s: %s", bid, exc)
        return "", ""
    if not isinstance(payload, dict) or int(payload.get("code") or -1) != 0:
        return "", ""
    data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    title = str(data.get("title") or "").strip()
    thumb = str(data.get("pic") or "").strip()
    return title, thumb


def enrich_bilibili_entry_titles(
    entries: List[Dict[str, str]],
    *,
    proxy: Optional[str] = None,
) -> None:
    """给 flat 解析缺标题的 BV 条目补标题/封面（就地修改）。"""
    pending = [
        e
        for e in entries
        if isinstance(e, dict)
        and not str(e.get("title") or "").strip()
        and _BVID_RE.match(str(e.get("id") or "").strip())
    ]
    if not pending:
        return

    def _one(entry: Dict[str, str]) -> None:
        title, thumb = fetch_bilibili_view(str(entry.get("id") or ""), proxy=proxy)
        if title:
            entry["title"] = title
        if thumb:
            entry["thumbnail_url"] = thumb

    workers = min(6, len(pending))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(_one, pending))


def looks_like_playlist_url(url: str) -> bool:
    """粗判是否可能是播放列表/合集（用于入队前展开，避免 noplaylist 单条失败）。"""
    text = (url or "").strip()
    if not text:
        return False
    lower = text.lower()
    if "list=" in lower:
        return True
    if "/playlist" in lower:
        return True
    if "/lists/" in lower or "/collection/" in lower or "/series/" in lower:
        return True
    # B 站多 P / 合集常见形态
    if "bilibili.com" in lower and (
        "/video/" in lower or "season" in lower or "episode" in lower or "favlist" in lower
    ):
        # /video/BV... 也可能是单 P；?p= 或合集类 path 更靠谱。单 BV 留给 yt-dlp entries 判断。
        if "p=" in lower or "season" in lower or "favlist" in lower or "/lists/" in lower:
            return True
    return False


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
    playlist: Optional[Dict[str, object]] = None


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
    if allow_playlist:
        # 大列表只取条目摘要，避免逐集完整解析超时
        cmd.append("--flat-playlist")
    else:
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
        for idx, entry in enumerate(info.get("entries") or [], start=1):
            if not isinstance(entry, dict):
                continue
            entry_url = (
                str(entry.get("url") or entry.get("webpage_url") or "").strip()
            )
            # flat-playlist 偶发只给 id，尽量拼出可下载页面链接
            if not entry_url and entry.get("id"):
                entry_id = str(entry["id"]).strip()
                if "youtube" in self.url or "youtu.be" in self.url:
                    entry_url = f"https://www.youtube.com/watch?v={entry_id}"
                elif "bilibili" in self.url:
                    entry_url = f"https://www.bilibili.com/video/{entry_id}"
            playlist_index = entry.get("playlist_index") or entry.get("playlist_autonumber")
            try:
                index_str = str(int(playlist_index)) if playlist_index else str(idx)
            except (TypeError, ValueError):
                index_str = str(idx)
            title = str(entry.get("title") or "").strip()
            availability = str(entry.get("availability") or "").strip().lower()
            # B 站合集/season 的 flat 条目经常只有 id、没有 title；不能凭空标题判下架。
            unavailable = availability in {
                "unavailable",
                "private",
                "needs_auth",
                "premium_only",
            } or bool(entry.get("unavailable"))
            entries.append(
                {
                    "id": str(entry.get("id") or ""),
                    "title": title,
                    "url": entry_url,
                    "index": index_str,
                    "available": "0" if unavailable else "1",
                }
            )
        return entries

    def _to_video_info(self, info: dict) -> VideoInfo:
        duration = info.get("duration") or 0
        return VideoInfo(
            url=self.url,
            title=info.get("title") or info.get("playlist_title") or "未命名视频",
            duration=int(duration) if duration else 0,
            thumbnail_url=info.get("thumbnail") or "",
            uploader=(
                info.get("uploader")
                or info.get("channel")
                or info.get("creator")
                or info.get("uploader_id")
                or "未知"
            ),
            platform=PlatformDetector.detect(self.url),
            file_size=info.get("filesize", 0) or info.get("filesize_approx", 0) or 0,
            formats=summarize_formats(info.get("formats")),
        )

    def _playlist_meta(self, info: dict, entries: List[Dict[str, str]]) -> Optional[Dict[str, object]]:
        if not entries:
            return None
        title = str(
            info.get("playlist_title")
            or info.get("title")
            or "播放列表"
        ).strip()
        playlist_id = str(
            info.get("playlist_id") or info.get("id") or ""
        ).strip()
        return {
            "id": playlist_id,
            "title": title or "播放列表",
            "count": len(entries),
        }

    def _to_parse_result(self, info: dict) -> ParseResult:
        entries = self._summarize_entries(info) if self.allow_playlist else []
        if entries and "bilibili.com" in self.url.lower():
            enrich_bilibili_entry_titles(entries, proxy=self.proxy)
        playlist = self._playlist_meta(info, entries) if self.allow_playlist else None
        return ParseResult(
            info=self._to_video_info(info),
            entries=entries,
            playlist=playlist,
        )
