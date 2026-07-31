"""
下载管理器，负责任务队列和并发控制。
"""
from __future__ import annotations

import os
import re
import shlex
import subprocess
import threading
import time
from datetime import datetime
from typing import Dict, List, Optional, Set

from src.core.download_task import (
    DownloadTask,
    Platform,
    TaskSnapshot,
    TaskStatus,
    VideoInfo,
)
from src.core.error_codes import classify_download_error
from src.core.douyin_url import is_douyin_url, normalize_douyin_url
from src.core.ytdlp_cookies import apply_cookie_sources
from src.core.downloader import DownloadCancelled, DownloadError, Downloader
from src.core.events import EventEmitter
from src.core.http_headers import DEFAULT_HTTP_HEADERS
from src.core.interfaces import DownloadConfig, HistoryWriter
from src.core.platform_detector import (
    PlatformDetector,
    normalize_thumbnail_url,
    pick_thumbnail_from_ydl_info,
)
from src.core.quality import build_format_selector
from src.core.title_utils import is_weak_title, pick_title_from_ydl_info
from src.core.video_info_extractor import VideoInfoExtractor
from src.data.models import DownloadRecord
from src.data.queue_store import QueueStore
from src.utils.logger import setup_logger

logger = setup_logger("DownloadManager")

_PLACEHOLDER_TITLES = {"正在获取信息...", "未命名视频", ""}

_MEDIA_URL_RE = re.compile(
    r"\.(m3u8|mpd|mp4|webm|mkv|mov|m4v|mp3|m4a|aac|flac|ogg|wav)(?:[?#]|$)",
    re.IGNORECASE,
)


def sanitize_filename(name: str, fallback: str = "video") -> str:
    """把任务标题转成安全文件名（去掉路径与保留字符，限长）。"""
    cleaned = re.sub(r'[\\/:*?"<>|]', " ", name).strip()
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned[:80] or fallback


class DownloadManager:
    """下载管理器（Qt 无关）。事件通过 self.events 分发。"""

    def __init__(
        self,
        config: DownloadConfig,
        db: HistoryWriter,
        queue_store: Optional[QueueStore] = None,
    ):
        self.config = config
        self.db = db
        self.queue_store = queue_store
        self.events = EventEmitter()
        self._last_progress_persist: Dict[str, float] = {}

        self._lock = threading.RLock()
        self.tasks: Dict[str, DownloadTask] = {}
        self.active_tasks: Dict[str, threading.Thread] = {}
        self._resume_requested: Set[str] = set()

        self.scheduler_thread: Optional[threading.Thread] = None
        self.running = False

        logger.info("下载管理器初始化完成")

    def restore_tasks(self) -> None:
        """从队列存储恢复任务。下载中降级为已暂停；等待中重新入队。"""
        if self.queue_store is None:
            return
        restored = self.queue_store.load_tasks()
        downgraded = []
        with self._lock:
            for task in restored:
                if task.status == TaskStatus.DOWNLOADING:
                    task.status = TaskStatus.PAUSED
                    downgraded.append(task)
                self.tasks[task.id] = task
        for task in downgraded:
            self._persist(task)
        if restored:
            logger.info(f"从数据库恢复 {len(restored)} 个任务")

    def start(self):
        """启动调度器"""
        with self._lock:
            if self.running:
                return
            self.running = True
            self.scheduler_thread = threading.Thread(target=self._scheduler_loop, daemon=True)
            self.scheduler_thread.start()
        logger.info("调度器已启动")

    def stop(self, join_timeout: float = 5.0):
        """停止调度器。下载中的任务中断并标记为已暂停（保留半成品，可续传）。"""
        paused_tasks = []
        with self._lock:
            self.running = False
            for task in self.tasks.values():
                if task.status == TaskStatus.DOWNLOADING:
                    task.status = TaskStatus.PAUSED
                    paused_tasks.append(task)
            threads = list(self.active_tasks.values())
            scheduler = self.scheduler_thread

        for task in paused_tasks:
            self._persist(task)

        if scheduler and scheduler.is_alive():
            scheduler.join(timeout=join_timeout)

        for thread in threads:
            if thread.is_alive():
                thread.join(timeout=join_timeout)

        logger.info("调度器已停止")

    def _persist(self, task: DownloadTask) -> None:
        """把任务当前状态写入队列存储；失败只记日志，不影响下载。"""
        if self.queue_store is None:
            return
        try:
            self.queue_store.upsert_task(task)
        except Exception as exc:
            logger.error(f"持久化任务失败 {task.id}: {exc}")

    def _persist_remove(self, task_id: str) -> None:
        if self.queue_store is None:
            return
        try:
            self.queue_store.remove_task(task_id)
        except Exception as exc:
            logger.error(f"删除持久化任务失败 {task_id}: {exc}")

    def add_task(self, task: DownloadTask):
        """添加任务到队列"""
        with self._lock:
            max_order = max((t.queue_order for t in self.tasks.values()), default=-1)
            task.queue_order = max_order + 1
            self.tasks[task.id] = task
        self._persist(task)
        self.events.emit("task_added", {"task_id": task.id})
        logger.info(f"添加任务: {task.video_info.title}")

    def pause_task(self, task_id: str):
        """暂停任务（中断当前下载；恢复时重新入队）。"""
        with self._lock:
            task = self.tasks.get(task_id)
            if not task or task.status != TaskStatus.DOWNLOADING:
                return
            task.status = TaskStatus.PAUSED
        self._persist(task)
        self.events.emit("task_paused", {"task_id": task_id})
        logger.info(f"暂停任务: {task.video_info.title}")

    def resume_task(self, task_id: str):
        """恢复暂停任务；若旧下载线程仍在收尾则等 finally 再入队。"""
        with self._lock:
            task = self.tasks.get(task_id)
            if not task or task.status != TaskStatus.PAUSED:
                return
            if task_id in self.active_tasks:
                self._resume_requested.add(task_id)
                logger.info(f"恢复任务等待旧线程退出: {task.video_info.title}")
                return
            task.status = TaskStatus.PENDING
            task.error_message = ""
            task.error_code = ""
        self._persist(task)
        logger.info(f"恢复任务: {task.video_info.title}")

    def cancel_task(self, task_id: str):
        """取消任务"""
        with self._lock:
            task = self.tasks.get(task_id)
            if not task:
                return
            if task.status in (TaskStatus.COMPLETED, TaskStatus.CANCELLED):
                return
            task.status = TaskStatus.CANCELLED
        self._persist(task)
        self.events.emit("task_cancelled", {"task_id": task_id})
        logger.info(f"取消任务: {task.video_info.title}")

    def retry_task(self, task_id: str):
        """重试失败的任务"""
        with self._lock:
            task = self.tasks.get(task_id)
            if not task or task.status != TaskStatus.FAILED:
                return
            if task_id in self.active_tasks:
                return
            task.status = TaskStatus.PENDING
            task.error_message = ""
            task.error_code = ""
            task.progress = 0.0
            task.downloaded_bytes = 0
            task.total_bytes = 0
        self._persist(task)
        logger.info(f"重试任务: {task.video_info.title}")

    def get_task(self, task_id: str) -> Optional[DownloadTask]:
        with self._lock:
            return self.tasks.get(task_id)

    def get_all_tasks(self) -> Dict[str, DownloadTask]:
        with self._lock:
            return dict(self.tasks)

    def get_snapshot(self) -> List[TaskSnapshot]:
        """所有任务的不可变快照（锁内构建，锁外安全使用）。"""
        with self._lock:
            return [task.to_snapshot() for task in self.tasks.values()]

    def remove_task(self, task_id: str) -> bool:
        """从列表移除已结束任务（不中断进行中的下载）。"""
        with self._lock:
            task = self.tasks.get(task_id)
            if not task:
                return False
            if task.status in (TaskStatus.DOWNLOADING, TaskStatus.PENDING, TaskStatus.PAUSED):
                return False
            if task_id in self.active_tasks:
                return False
            self.tasks.pop(task_id, None)
        self._persist_remove(task_id)
        return True

    def update_task(
        self,
        task_id: str,
        *,
        title: Optional[str] = None,
        format_id: Optional[str] = None,
        clear_format: bool = False,
        quality: Optional[str] = None,
        audio_only: Optional[bool] = None,
        postprocessing: Optional[str] = None,
        priority: Optional[int] = None,
    ) -> Optional[DownloadTask]:
        """
        更新任务选项 / 重命名。下载中的任务不允许改下载选项（可先暂停）。
        已完成任务重命名会同步改磁盘文件名。
        """
        with self._lock:
            task = self.tasks.get(task_id)
            if not task:
                return None

            touches_options = any(
                value is not None
                for value in (format_id, quality, audio_only, postprocessing)
            ) or clear_format
            if touches_options and task.status == TaskStatus.DOWNLOADING:
                raise ValueError("下载进行中，请先暂停再修改选项")

            if title is not None:
                new_title = title.strip() or task.video_info.title
                if task.status == TaskStatus.COMPLETED and task.file_path:
                    task.file_path = self._rename_output_file(task, new_title)
                task.video_info.title = new_title

            if touches_options:
                if clear_format:
                    task.options.format_id = None
                if format_id is not None:
                    task.options.format_id = format_id or None
                if quality is not None:
                    task.options.quality = quality
                if audio_only is not None:
                    task.options.audio_only = audio_only
                if postprocessing is not None:
                    task.options.postprocessing = postprocessing

            if priority is not None:
                task.priority = int(priority)

        self._persist(task)
        self.events.emit("task_updated", {"task_id": task.id})
        return task

    def reorder_tasks(self, ordered_ids: List[str]) -> bool:
        """按 ordered_ids 重写 queue_order；未列出的任务排在末尾。"""
        with self._lock:
            seen: Set[str] = set()
            for idx, task_id in enumerate(ordered_ids):
                task = self.tasks.get(task_id)
                if not task:
                    continue
                task.queue_order = idx
                seen.add(task_id)
            next_order = len(seen)
            for task in sorted(
                self.tasks.values(), key=lambda t: (t.queue_order, t.created_at)
            ):
                if task.id in seen:
                    continue
                task.queue_order = next_order
                next_order += 1
            tasks_to_persist = list(self.tasks.values())
        for task in tasks_to_persist:
            self._persist(task)
        self.events.emit("tasks_reordered", {})
        return True

    def _rename_output_file(self, task: DownloadTask, new_title: str) -> str:
        """已完成任务改名：同步重命名磁盘文件（保留扩展名）。"""
        old_path = task.file_path
        try:
            directory = os.path.dirname(old_path)
            ext = os.path.splitext(old_path)[1]
            candidate = os.path.join(directory, f"{sanitize_filename(new_title)}{ext}")
            if candidate == old_path:
                return old_path
            if os.path.exists(old_path) and not os.path.exists(candidate):
                os.rename(old_path, candidate)
                return candidate
        except OSError as exc:
            logger.error(f"重命名输出文件失败 {old_path}: {exc}")
        return old_path

    def _run_postprocess_script(self, task: DownloadTask) -> None:
        """执行用户自定义后处理脚本；失败只记日志，不影响任务结果。"""
        script = (task.options.postprocess_script or "").strip()
        if not script:
            logger.warning("任务配置了脚本后处理但脚本为空: %s", task.id)
            return
        quoted = shlex.quote(task.file_path)
        command = script.format(file=quoted) if "{file}" in script else f"{script} {quoted}"
        logger.info(f"执行后处理脚本: {command}")
        try:
            result = subprocess.run(
                command,
                shell=True,
                timeout=600,
                capture_output=True,
                text=True,
            )
            if result.returncode != 0:
                logger.error(
                    f"后处理脚本退出码 {result.returncode}: {result.stderr.strip()[:500]}"
                )
        except Exception as exc:
            logger.error(f"后处理脚本执行失败: {exc}")

    def _pick_next_pending_locked(self) -> Optional[DownloadTask]:
        """锁内调用：queue_order 升序，再 priority 降序，再创建时间早优先。"""
        candidates = [
            task
            for task in self.tasks.values()
            if task.status == TaskStatus.PENDING and task.id not in self.active_tasks
        ]
        if not candidates:
            return None
        candidates.sort(key=lambda t: (t.queue_order, -t.priority, t.created_at))
        return candidates[0]

    def _scheduler_loop(self):
        while True:
            thread: Optional[threading.Thread] = None
            with self._lock:
                if not self.running:
                    break
                max_concurrent = self.config.get_concurrent_downloads()
                if len(self.active_tasks) < max_concurrent:
                    task = self._pick_next_pending_locked()
                    if task is not None:
                        thread = threading.Thread(
                            target=self._download_task,
                            args=(task,),
                            daemon=True,
                        )
                        self.active_tasks[task.id] = thread
            if thread is not None:
                thread.start()
            else:
                threading.Event().wait(0.3)

    def _download_task(self, task: DownloadTask):
        try:
            with self._lock:
                if task.status in (TaskStatus.CANCELLED, TaskStatus.PAUSED):
                    return
                task.status = TaskStatus.DOWNLOADING
                task.started_at = datetime.now()
            self._persist(task)
            self.events.emit("task_started", {"task_id": task.id})

            # 抖音精选/发现页 modal_id → /video/{id}，供 yt-dlp DouyinIE 识别
            if is_douyin_url(task.video_info.url):
                normalized = normalize_douyin_url(task.video_info.url)
                if normalized != task.video_info.url:
                    with self._lock:
                        task.video_info.url = normalized
                    self._persist(task)

            # 补齐元数据（失败不阻断下载；X 失败时 VideoInfoExtractor 内会走 FxTwitter）
            # 扩展常带真实标题但无封面：页面链接仍需预拉 thumbnail
            needs_full_meta = is_weak_title(task.video_info.title)
            needs_thumb = not (task.video_info.thumbnail_url or "").strip()
            is_direct_media = bool(_MEDIA_URL_RE.search(task.video_info.url))
            if needs_full_meta or (needs_thumb and not is_direct_media):
                proxy = task.options.proxy or None
                info = VideoInfoExtractor.extract(
                    task.video_info.url,
                    proxy=proxy,
                    http_headers=task.options.http_headers,
                )
                if info:
                    with self._lock:
                        if needs_full_meta:
                            if task.video_info.thumbnail_url and not info.thumbnail_url:
                                info.thumbnail_url = task.video_info.thumbnail_url
                            task.video_info = info
                        else:
                            if info.thumbnail_url:
                                task.video_info.thumbnail_url = info.thumbnail_url
                            if not task.video_info.uploader and info.uploader:
                                task.video_info.uploader = info.uploader
                            if not (task.video_info.duration or 0) and info.duration:
                                task.video_info.duration = info.duration
                            if info.formats and not task.video_info.formats:
                                task.video_info.formats = info.formats
                            if is_weak_title(task.video_info.title) and not is_weak_title(
                                info.title
                            ):
                                task.video_info.title = info.title
                    self._persist(task)
                    self.events.emit("task_updated", {"task_id": task.id})

            with self._lock:
                if task.status in (TaskStatus.CANCELLED, TaskStatus.PAUSED):
                    raise DownloadCancelled(
                        "任务已取消" if task.status == TaskStatus.CANCELLED else "任务已暂停"
                    )

            downloader = Downloader(task.options.output_path)

            def progress_callback(d):
                with self._lock:
                    if task.status == TaskStatus.CANCELLED:
                        raise DownloadCancelled("任务已取消")
                    if task.status == TaskStatus.PAUSED:
                        raise DownloadCancelled("任务已暂停")

                downloaded = int(d.get("downloaded_bytes") or 0)
                total = int(d.get("total_bytes") or d.get("total_bytes_estimate") or 0)
                task.downloaded_bytes = downloaded
                task.total_bytes = total

                try:
                    percent_str = d.get("_percent_str", "0%")
                    percent_str = re.sub(r"\x1b\[[0-9;]*m", "", str(percent_str))
                    task.progress = float(percent_str.replace("%", "").strip() or 0)
                except (ValueError, AttributeError, TypeError):
                    if total:
                        task.progress = min(100.0, downloaded * 100.0 / total)

                task.speed = d.get("_speed_str", "0 B/s")
                task.eta = d.get("_eta_str", "暂无")
                slim = {
                    "status": d.get("status"),
                    "_percent_str": d.get("_percent_str"),
                    "_speed_str": d.get("_speed_str"),
                    "_eta_str": d.get("_eta_str"),
                    "filename": d.get("filename"),
                    "downloaded_bytes": downloaded,
                    "total_bytes": total,
                    "progress": task.progress,
                }
                if self.queue_store is not None:
                    now = time.monotonic()
                    last = self._last_progress_persist.get(task.id, 0.0)
                    if now - last >= 2.0:
                        self._last_progress_persist[task.id] = now
                        try:
                            self.queue_store.update_progress(
                                task.id, task.progress, downloaded, total
                            )
                        except Exception as exc:
                            logger.error(f"持久化进度失败 {task.id}: {exc}")
                self.events.emit("task_progress", {"task_id": task.id, "progress": slim})

            downloader.set_callbacks(progress=progress_callback)

            opts: Dict = {}
            options = task.options
            extract_audio = options.audio_only or options.postprocessing == "mp3"
            postprocessors: List[Dict] = []

            if extract_audio:
                opts["format"] = "bestaudio/best"
                postprocessors.append(
                    {
                        "key": "FFmpegExtractAudio",
                        "preferredcodec": "mp3",
                        "preferredquality": "192",
                    }
                )
            else:
                format_selector = build_format_selector(
                    options.quality, options.format_id
                )
                if format_selector:
                    opts["format"] = format_selector

                # 直链媒体：generic extractor 的 format 元数据不可靠
                # （X 的 HLS 清单报 "Requested format is not available"），
                # 改用宽松选择器；master 清单取最高码率，DASH 分离流合并
                if _MEDIA_URL_RE.search(task.video_info.url) and not options.format_id:
                    opts["format"] = "bestvideo+bestaudio/best"

                if options.postprocessing == "mp4":
                    postprocessors.append(
                        {"key": "FFmpegVideoConvertor", "preferedformat": "mp4"}
                    )

            if options.embed_metadata:
                opts["writethumbnail"] = True
                opts["embedthumbnail"] = True
                opts["embedmetadata"] = True
                opts["embedchapters"] = True

            subtitle_langs = [
                lang.strip()
                for lang in (options.subtitle_langs or "").split(",")
                if lang.strip()
            ]
            if subtitle_langs:
                opts["writesubtitles"] = True
                opts["writeautomaticsub"] = True
                opts["subtitleslangs"] = subtitle_langs
            elif options.download_subtitles:
                opts["writesubtitles"] = True
                opts["writeautomaticsub"] = True

            if options.embed_subs:
                opts["embedsubtitles"] = subtitle_langs if subtitle_langs else True

            if options.concurrent_fragments and options.concurrent_fragments > 0:
                opts["concurrent_fragment_downloads"] = options.concurrent_fragments

            sections = (options.download_sections or "").strip()
            if sections:
                opts["download_sections"] = sections

            sponsor_parts = [
                part.strip()
                for part in (options.sponsorblock_remove or "").split(",")
                if part.strip()
            ]
            if sponsor_parts:
                opts["sponsorblock_remove"] = sponsor_parts

            apply_cookie_sources(
                opts,
                options.cookies_from_browser,
                options.cookiefile,
            )

            if postprocessors:
                opts["postprocessors"] = postprocessors

            if options.speed_limit and options.speed_limit > 0:
                opts["ratelimit"] = options.speed_limit

            proxy = (options.proxy or "").strip()
            if proxy:
                opts["proxy"] = proxy

            if options.http_headers:
                opts["http_headers"] = {
                    **DEFAULT_HTTP_HEADERS,
                    **options.http_headers,
                }

            # 直链任务：yt-dlp generic extractor 的 title 是 URL 文件名（hash/
            # manifest/index），输出文件无法分辨；用任务标题固定输出文件名。
            # 页面链接任务不设，让 yt-dlp 用其解析到的真实标题。
            if (
                task.video_info.title not in _PLACEHOLDER_TITLES
                and _MEDIA_URL_RE.search(task.video_info.url)
            ):
                opts["outtmpl"] = os.path.join(
                    options.output_path,
                    f"{sanitize_filename(task.video_info.title)}.%(ext)s",
                )
            elif options.filename_template:
                opts["outtmpl"] = os.path.join(
                    options.output_path, options.filename_template
                )

            file_path = downloader.download(task.video_info.url, opts)

            with self._lock:
                if task.status == TaskStatus.CANCELLED:
                    self._save_to_history(task)
                    return
                if task.status == TaskStatus.PAUSED:
                    return
                self._backfill_metadata_after_download(task, downloader, file_path)
                task.status = TaskStatus.COMPLETED
                task.progress = 100.0
                task.completed_at = datetime.now()
                task.file_path = file_path or task.file_path
                self._save_to_history(task)

            self._persist(task)
            self.events.emit("task_completed", {"task_id": task.id})

            if task.options.postprocessing == "script" and task.file_path:
                self._run_postprocess_script(task)

        except DownloadCancelled as e:
            cancelled = False
            with self._lock:
                if task.status == TaskStatus.PAUSED:
                    logger.info(f"任务已暂停中断: {task.video_info.title}")
                else:
                    task.status = TaskStatus.CANCELLED
                    task.error_message = str(e)
                    self._save_to_history(task)
                    cancelled = True
            self._persist(task)
            if cancelled:
                self.events.emit("task_cancelled", {"task_id": task.id})
                logger.info(f"任务已取消: {task.video_info.title}")
        except (DownloadError, Exception) as e:
            with self._lock:
                if task.status in (TaskStatus.CANCELLED, TaskStatus.PAUSED):
                    return
                task.status = TaskStatus.FAILED
                task.error_message = str(e)
                task.error_code = classify_download_error(e)
                self._save_to_history(task)
            self._persist(task)
            self.events.emit("task_failed", {"task_id": task.id, "error": str(e)})
            self._maybe_report_failure(task)
            logger.error(f"任务失败: {task.video_info.title} - {str(e)}")
        finally:
            requeue = False
            with self._lock:
                self.active_tasks.pop(task.id, None)
                if task.id in self._resume_requested:
                    self._resume_requested.discard(task.id)
                    if task.status == TaskStatus.PAUSED:
                        task.status = TaskStatus.PENDING
                        task.error_message = ""
                        task.error_code = ""
                        requeue = True
            if requeue:
                self._persist(task)
                logger.info(f"暂停任务线程退出后重新入队: {task.video_info.title}")

    def _maybe_report_failure(self, task: DownloadTask) -> None:
        """opt-in 本地失败统计（不上报网络）。"""
        try:
            from src.sidecar.telemetry import maybe_report_failure

            maybe_report_failure(
                self.config,
                task.error_code,
                task.video_info.platform.value,
            )
        except Exception as exc:
            logger.debug("telemetry skipped: %s", exc)

    def _backfill_metadata_after_download(
        self,
        task: DownloadTask,
        downloader: Downloader,
        file_path: str,
    ) -> None:
        """下载完成后回填标题/平台/封面；页面任务优先用 yt-dlp 真实元数据。"""
        ydl_info = getattr(downloader, "last_ydl_info", None)
        is_direct = bool(_MEDIA_URL_RE.search(task.video_info.url))
        if isinstance(ydl_info, dict):
            title = pick_title_from_ydl_info(ydl_info, task.video_info.title)
            # 页面链接：用挑选后的标题；直链：仅在当前标题很弱时覆盖
            if title and (not is_direct or is_weak_title(task.video_info.title)):
                task.video_info.title = title
            uploader = str(ydl_info.get("uploader") or ydl_info.get("channel") or "").strip()
            if uploader and (not is_direct or not task.video_info.uploader):
                task.video_info.uploader = uploader
            thumb = pick_thumbnail_from_ydl_info(ydl_info)
            if thumb and (not is_direct or not task.video_info.thumbnail_url):
                task.video_info.thumbnail_url = thumb
            duration = ydl_info.get("duration")
            if isinstance(duration, (int, float)) and duration > 0:
                if not is_direct or not (task.video_info.duration or 0):
                    task.video_info.duration = int(duration)

        if task.video_info.thumbnail_url:
            task.video_info.thumbnail_url = normalize_thumbnail_url(
                task.video_info.thumbnail_url
            )

        if task.video_info.platform == Platform.UNKNOWN:
            referer = ""
            headers = task.options.http_headers or {}
            if isinstance(headers, dict):
                referer = str(headers.get("Referer") or headers.get("referer") or "")
            task.video_info.platform = PlatformDetector.detect_with_context(
                task.video_info.url,
                referer=referer or None,
                title=task.video_info.title,
            )

        if task.video_info.title in _PLACEHOLDER_TITLES:
            fallback_info = getattr(downloader, "last_info", None)
            if (
                isinstance(fallback_info, VideoInfo)
                and fallback_info.title
                and fallback_info.title not in _PLACEHOLDER_TITLES
            ):
                task.video_info = fallback_info
            elif file_path:
                stem = os.path.splitext(os.path.basename(file_path))[0].strip()
                # 去掉 .f140 一类中间后缀再当标题
                stem = re.sub(r"\.f\d+$", "", stem, flags=re.IGNORECASE)
                if stem and stem not in _PLACEHOLDER_TITLES:
                    task.video_info.title = stem

    def _save_to_history(self, task: DownloadTask):
        """保存任务到历史记录（调用方应持有锁或接受竞态窗口很小）。"""
        record = DownloadRecord(
            id=task.id,
            url=task.video_info.url,
            title=task.video_info.title,
            platform=task.video_info.platform.value,
            duration=task.video_info.duration or 0,
            thumbnail_url=task.video_info.thumbnail_url or "",
            uploader=task.video_info.uploader or "",
            status=task.status.value,
            file_path=task.file_path,
            file_size=task.video_info.file_size or 0,
            created_at=task.created_at,
            started_at=task.started_at,
            completed_at=task.completed_at,
            error_message=task.error_message,
        )
        try:
            self.db.add_download_record(record)
        except Exception as exc:
            logger.error(f"写入历史失败: {exc}")
