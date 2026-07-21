"""
下载管理器，负责任务队列和并发控制。
"""
from __future__ import annotations

import queue
import re
import threading
import time
from datetime import datetime
from typing import Dict, List, Optional, Set

from src.core.download_task import DownloadTask, TaskSnapshot, TaskStatus
from src.core.downloader import DownloadCancelled, DownloadError, Downloader
from src.core.events import EventEmitter
from src.core.interfaces import DownloadConfig, HistoryWriter
from src.core.quality import build_format_selector
from src.core.video_info_extractor import VideoInfoExtractor
from src.data.models import DownloadRecord
from src.data.queue_store import QueueStore
from src.utils.logger import setup_logger

logger = setup_logger("DownloadManager")


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
        self.task_queue: queue.Queue = queue.Queue()
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
                if task.status == TaskStatus.PENDING:
                    self.task_queue.put(task.id)
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
            self.tasks[task.id] = task
            self.task_queue.put(task.id)
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
            self.task_queue.put(task_id)
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
            task.progress = 0.0
            task.downloaded_bytes = 0
            task.total_bytes = 0
            self.task_queue.put(task_id)
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

    def _scheduler_loop(self):
        while True:
            with self._lock:
                if not self.running:
                    break
                max_concurrent = self.config.get_concurrent_downloads()
                active_count = len(self.active_tasks)

            if active_count < max_concurrent:
                try:
                    task_id = self.task_queue.get(timeout=1)
                except queue.Empty:
                    continue

                with self._lock:
                    if not self.running:
                        break
                    task = self.tasks.get(task_id)
                    if not task or task.status != TaskStatus.PENDING:
                        continue
                    if task_id in self.active_tasks:
                        continue
                    if len(self.active_tasks) >= max_concurrent:
                        self.task_queue.put(task_id)
                        continue

                    download_thread = threading.Thread(
                        target=self._download_task,
                        args=(task,),
                        daemon=True,
                    )
                    self.active_tasks[task_id] = download_thread
                    download_thread.start()
            else:
                threading.Event().wait(0.2)

    def _download_task(self, task: DownloadTask):
        try:
            with self._lock:
                if task.status in (TaskStatus.CANCELLED, TaskStatus.PAUSED):
                    return
                task.status = TaskStatus.DOWNLOADING
                task.started_at = datetime.now()
            self._persist(task)
            self.events.emit("task_started", {"task_id": task.id})

            # 补齐元数据（失败不阻断下载）
            if not task.video_info.title or task.video_info.title in (
                "正在获取信息...",
                "未命名视频",
                "",
            ):
                proxy = task.options.proxy or None
                info = VideoInfoExtractor.extract(task.video_info.url, proxy=proxy)
                if info:
                    with self._lock:
                        task.video_info = info

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
            format_selector = build_format_selector(
                task.options.quality, task.options.format_id
            )
            if format_selector:
                opts["format"] = format_selector

            if task.options.speed_limit and task.options.speed_limit > 0:
                opts["ratelimit"] = task.options.speed_limit

            proxy = (task.options.proxy or "").strip()
            if proxy:
                opts["proxy"] = proxy

            if task.options.download_subtitles:
                opts["writesubtitles"] = True
                opts["writeautomaticsub"] = True

            file_path = downloader.download(task.video_info.url, opts)

            with self._lock:
                if task.status == TaskStatus.CANCELLED:
                    self._save_to_history(task)
                    return
                if task.status == TaskStatus.PAUSED:
                    return
                task.status = TaskStatus.COMPLETED
                task.progress = 100.0
                task.completed_at = datetime.now()
                task.file_path = file_path or task.file_path
                self._save_to_history(task)

            self._persist(task)
            self.events.emit("task_completed", {"task_id": task.id})

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
                self._save_to_history(task)
            self._persist(task)
            self.events.emit("task_failed", {"task_id": task.id, "error": str(e)})
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
                        self.task_queue.put(task.id)
                        requeue = True
            if requeue:
                self._persist(task)
                logger.info(f"暂停任务线程退出后重新入队: {task.video_info.title}")

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
