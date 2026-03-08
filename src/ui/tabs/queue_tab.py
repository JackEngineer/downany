"""
队列标签页，显示和管理下载任务。
"""
from PyQt6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QPushButton,
    QTableWidget, QTableWidgetItem, QHeaderView, QAbstractItemView
)
from PyQt6.QtCore import Qt, QTimer
from src.core.download_manager import DownloadManager
from src.core.download_task import TaskStatus
from src.core.platform_detector import PlatformDetector
from src.utils.logger import setup_logger

logger = setup_logger("QueueTab")


class QueueTab(QWidget):
    """队列标签页"""

    def __init__(self, download_manager: DownloadManager):
        super().__init__()
        self.download_manager = download_manager
        self.init_ui()
        self.setup_connections()
        self.start_refresh_timer()

    def init_ui(self):
        layout = QVBoxLayout()

        # 任务表格
        self.task_table = QTableWidget()
        self.task_table.setColumnCount(7)
        self.task_table.setHorizontalHeaderLabels([
            "平台", "标题", "状态", "进度", "速度", "剩余时间", "操作"
        ])

        # 设置表格属性
        self.task_table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.task_table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.task_table.horizontalHeader().setStretchLastSection(True)
        self.task_table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeMode.Stretch)

        layout.addWidget(self.task_table)

        # 操作按钮
        btn_layout = QHBoxLayout()
        btn_layout.addStretch()

        self.pause_btn = QPushButton("暂停")
        self.pause_btn.clicked.connect(self.pause_selected_task)
        btn_layout.addWidget(self.pause_btn)

        self.resume_btn = QPushButton("恢复")
        self.resume_btn.clicked.connect(self.resume_selected_task)
        btn_layout.addWidget(self.resume_btn)

        self.cancel_btn = QPushButton("取消")
        self.cancel_btn.clicked.connect(self.cancel_selected_task)
        btn_layout.addWidget(self.cancel_btn)

        self.retry_btn = QPushButton("重试")
        self.retry_btn.clicked.connect(self.retry_selected_task)
        btn_layout.addWidget(self.retry_btn)

        layout.addLayout(btn_layout)
        self.setLayout(layout)

    def setup_connections(self):
        """设置信号连接"""
        self.download_manager.task_added.connect(self.refresh_table)
        self.download_manager.task_started.connect(self.refresh_table)
        self.download_manager.task_progress.connect(self.refresh_table)
        self.download_manager.task_completed.connect(self.refresh_table)
        self.download_manager.task_failed.connect(self.refresh_table)
        self.download_manager.task_paused.connect(self.refresh_table)
        self.download_manager.task_cancelled.connect(self.refresh_table)

    def start_refresh_timer(self):
        """启动刷新定时器"""
        self.refresh_timer = QTimer()
        self.refresh_timer.timeout.connect(self.refresh_table)
        self.refresh_timer.start(1000)  # 每秒刷新一次

    def refresh_table(self):
        """刷新任务表格"""
        tasks = self.download_manager.get_all_tasks()
        self.task_table.setRowCount(len(tasks))

        for row, (task_id, task) in enumerate(tasks.items()):
            # 平台
            platform_icon = PlatformDetector.get_icon(task.video_info.platform)
            self.task_table.setItem(row, 0, QTableWidgetItem(platform_icon))

            # 标题
            self.task_table.setItem(row, 1, QTableWidgetItem(task.video_info.title))

            # 状态
            status_text = self._get_status_text(task.status)
            self.task_table.setItem(row, 2, QTableWidgetItem(status_text))

            # 进度
            progress_text = f"{task.progress:.1f}%"
            self.task_table.setItem(row, 3, QTableWidgetItem(progress_text))

            # 速度
            self.task_table.setItem(row, 4, QTableWidgetItem(task.speed))

            # 剩余时间
            self.task_table.setItem(row, 5, QTableWidgetItem(task.eta))

            # 操作 (存储 task_id)
            self.task_table.setItem(row, 6, QTableWidgetItem(task_id))

    def _get_status_text(self, status: TaskStatus) -> str:
        """获取状态文本"""
        status_map = {
            TaskStatus.PENDING: "等待中",
            TaskStatus.DOWNLOADING: "下载中",
            TaskStatus.PAUSED: "已暂停",
            TaskStatus.COMPLETED: "已完成",
            TaskStatus.FAILED: "失败",
            TaskStatus.CANCELLED: "已取消",
        }
        return status_map.get(status, "未知")

    def get_selected_task_id(self) -> str:
        """获取选中的任务 ID"""
        selected_rows = self.task_table.selectedIndexes()
        if not selected_rows:
            return ""

        row = selected_rows[0].row()
        task_id_item = self.task_table.item(row, 6)
        return task_id_item.text() if task_id_item else ""

    def pause_selected_task(self):
        """暂停选中的任务"""
        task_id = self.get_selected_task_id()
        if task_id:
            self.download_manager.pause_task(task_id)

    def resume_selected_task(self):
        """恢复选中的任务"""
        task_id = self.get_selected_task_id()
        if task_id:
            self.download_manager.resume_task(task_id)

    def cancel_selected_task(self):
        """取消选中的任务"""
        task_id = self.get_selected_task_id()
        if task_id:
            self.download_manager.cancel_task(task_id)

    def retry_selected_task(self):
        """重试选中的任务"""
        task_id = self.get_selected_task_id()
        if task_id:
            self.download_manager.retry_task(task_id)
