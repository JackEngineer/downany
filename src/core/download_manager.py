"""
下载管理器，负责任务队列和并发控制。
"""
import queue
import threading
from typing import Dict, Optional
from PyQt6.QtCore import QObject, pyqtSignal
from src.core.download_task import DownloadTask, TaskStatus
from src.core.downloader import Downloader
from src.data.config_manager import ConfigManager
from src.data.database import HistoryDB
from src.data.models import DownloadRecord
from src.utils.logger import setup_logger

logger = setup_logger("DownloadManager")


class DownloadManager(QObject):
    """下载管理器单例类"""
    _instance = None

    # 信号定义
    task_added = pyqtSignal(str)  # task_id
    task_started = pyqtSignal(str)  # task_id
    task_progress = pyqtSignal(str, dict)  # task_id, progress_dict
    task_completed = pyqtSignal(str)  # task_id
    task_failed = pyqtSignal(str, str)  # task_id, error_message
    task_paused = pyqtSignal(str)  # task_id
    task_cancelled = pyqtSignal(str)  # task_id

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._initialized = False
        return cls._instance

    def __init__(self):
        if self._initialized:
            return

        super().__init__()
        self._initialized = True

        # 配置和数据库
        self.config = ConfigManager()
        self.db = HistoryDB()

        # 任务队列和字典
        self.task_queue = queue.Queue()
        self.tasks: Dict[str, DownloadTask] = {}

        # 当前下载的任务
        self.active_tasks: Dict[str, threading.Thread] = {}

        # 调度线程
        self.scheduler_thread = None
        self.running = False

        logger.info("下载管理器初始化完成")

    def start(self):
        """启动调度器"""
        if self.running:
            return

        self.running = True
        self.scheduler_thread = threading.Thread(target=self._scheduler_loop, daemon=True)
        self.scheduler_thread.start()
        logger.info("调度器已启动")

    def stop(self):
        """停止调度器"""
        self.running = False
        if self.scheduler_thread:
            self.scheduler_thread.join(timeout=5)
        logger.info("调度器已停止")

    def add_task(self, task: DownloadTask):
        """添加任务到队列"""
        self.tasks[task.id] = task
        self.task_queue.put(task.id)
        self.task_added.emit(task.id)
        logger.info(f"添加任务: {task.video_info.title}")

    def pause_task(self, task_id: str):
        """暂停任务 (伪暂停: 取消下载)"""
        if task_id in self.tasks:
            task = self.tasks[task_id]
            if task.status == TaskStatus.DOWNLOADING:
                task.status = TaskStatus.PAUSED
                self.task_paused.emit(task_id)
                logger.info(f"暂停任务: {task.video_info.title}")

    def resume_task(self, task_id: str):
        """恢复任务 (重新添加到队列)"""
        if task_id in self.tasks:
            task = self.tasks[task_id]
            if task.status == TaskStatus.PAUSED:
                task.status = TaskStatus.PENDING
                self.task_queue.put(task_id)
                logger.info(f"恢复任务: {task.video_info.title}")

    def cancel_task(self, task_id: str):
        """取消任务"""
        if task_id in self.tasks:
            task = self.tasks[task_id]
            task.status = TaskStatus.CANCELLED
            self.task_cancelled.emit(task_id)
            logger.info(f"取消任务: {task.video_info.title}")

    def retry_task(self, task_id: str):
        """重试失败的任务"""
        if task_id in self.tasks:
            task = self.tasks[task_id]
            if task.status == TaskStatus.FAILED:
                task.status = TaskStatus.PENDING
                task.error_message = ""
                task.progress = 0.0
                self.task_queue.put(task_id)
                logger.info(f"重试任务: {task.video_info.title}")

    def get_task(self, task_id: str) -> Optional[DownloadTask]:
        """获取任务"""
        return self.tasks.get(task_id)

    def get_all_tasks(self) -> Dict[str, DownloadTask]:
        """获取所有任务"""
        return self.tasks

    def _scheduler_loop(self):
        """调度器主循环"""
        while self.running:
            try:
                # 检查并发数
                max_concurrent = self.config.get_concurrent_downloads()
                active_count = len([t for t in self.tasks.values() if t.status == TaskStatus.DOWNLOADING])

                if active_count < max_concurrent:
                    # 从队列获取任务
                    try:
                        task_id = self.task_queue.get(timeout=1)
                        task = self.tasks.get(task_id)

                        if task and task.status == TaskStatus.PENDING:
                            # 启动下载线程
                            download_thread = threading.Thread(
                                target=self._download_task,
                                args=(task,),
                                daemon=True
                            )
                            self.active_tasks[task_id] = download_thread
                            download_thread.start()

                    except queue.Empty:
                        pass

            except Exception as e:
                logger.error(f"调度器错误: {str(e)}")

    def _download_task(self, task: DownloadTask):
        """执行下载任务"""
        from datetime import datetime

        try:
            # 更新状态
            task.status = TaskStatus.DOWNLOADING
            task.started_at = datetime.now()
            self.task_started.emit(task.id)

            # 创建下载器
            downloader = Downloader(task.options.output_path)

            # 设置进度回调
            def progress_callback(d):
                if task.status == TaskStatus.CANCELLED:
                    raise Exception("任务已取消")

                try:
                    # 清理可能的 ANSI 颜色代码
                    import re
                    percent_str = d.get('_percent_str', '0%')
                    # 移除 ANSI 转义序列
                    percent_str = re.sub(r'\x1b\[[0-9;]*m', '', str(percent_str))
                    task.progress = float(percent_str.replace('%', '').strip())
                except (ValueError, AttributeError):
                    task.progress = 0.0

                task.speed = d.get('_speed_str', '0 B/s')
                task.eta = d.get('_eta_str', 'N/A')
                self.task_progress.emit(task.id, d)

            downloader.set_callbacks(progress=progress_callback)

            # 构建下载选项
            opts = {}

            # 格式选择
            if task.options.format_id:
                opts['format'] = task.options.format_id
            elif task.options.quality != 'best':
                opts['format'] = f'bestvideo[height<={task.options.quality[:-1]}]+bestaudio/best'

            # 速度限制
            if task.options.speed_limit and task.options.speed_limit > 0:
                opts['ratelimit'] = task.options.speed_limit

            # 代理
            if task.options.proxy:
                opts['proxy'] = task.options.proxy

            # 字幕
            if task.options.download_subtitles:
                opts['writesubtitles'] = True
                opts['writeautomaticsub'] = True

            # 执行下载
            downloader.download(task.video_info.url, opts)

            # 下载完成
            task.status = TaskStatus.COMPLETED
            task.progress = 100.0
            task.completed_at = datetime.now()
            self.task_completed.emit(task.id)

            # 保存到历史记录
            self._save_to_history(task)

        except Exception as e:
            if task.status != TaskStatus.CANCELLED:
                task.status = TaskStatus.FAILED
                task.error_message = str(e)
                self.task_failed.emit(task.id, str(e))
                logger.error(f"任务失败: {task.video_info.title} - {str(e)}")

        finally:
            # 清理活动任务
            if task.id in self.active_tasks:
                del self.active_tasks[task.id]

    def _save_to_history(self, task: DownloadTask):
        """保存任务到历史记录"""
        record = DownloadRecord(
            id=task.id,
            url=task.video_info.url,
            title=task.video_info.title,
            platform=task.video_info.platform.value,
            duration=task.video_info.duration,
            thumbnail_url=task.video_info.thumbnail_url,
            uploader=task.video_info.uploader,
            status=task.status.value,
            file_path=task.file_path,
            file_size=task.video_info.file_size,
            created_at=task.created_at,
            started_at=task.started_at,
            completed_at=task.completed_at,
            error_message=task.error_message
        )
        self.db.add_download_record(record)

