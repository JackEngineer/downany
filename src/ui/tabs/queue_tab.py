"""
队列标签页，显示和管理下载任务。
"""
from __future__ import annotations

from PyQt6.QtCore import Qt, QTimer
from PyQt6.QtWidgets import (
    QAbstractItemView,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QProgressBar,
    QPushButton,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from src.core.download_manager import DownloadManager
from src.core.download_task import TaskStatus
from src.core.platform_detector import PlatformDetector
from src.ui.components.chrome import PageHeader, SectionCard, StatusBadge
from src.utils.logger import setup_logger

logger = setup_logger("QueueTab")


class QueueTab(QWidget):
    """队列标签页。"""

    def __init__(self, download_manager: DownloadManager):
        super().__init__()
        self.download_manager = download_manager
        self._row_by_task_id: dict[str, int] = {}
        self._progress_bars: dict[str, QProgressBar] = {}
        self._status_badges: dict[str, StatusBadge] = {}
        self._progress_throttle = QTimer(self)
        self._progress_throttle.setSingleShot(True)
        self._progress_throttle.setInterval(250)
        self._progress_throttle.timeout.connect(self._flush_progress_refresh)
        self._pending_progress_refresh = False
        self.init_ui()
        self.setup_connections()
        self.start_refresh_timer()
        self.refresh_overview()

    def init_ui(self):
        layout = QVBoxLayout()
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(18)

        self.header = PageHeader(
            "任务队列",
            "集中查看当前任务状态、进度、速度和剩余时间。",
            metrics=[
                ("活跃任务", "0", "下载中和等待中的任务"),
                ("已完成", "0", "当前列表内的完成数量"),
                ("失败", "0", "可重试的失败任务"),
            ],
        )
        layout.addWidget(self.header)

        table_card = SectionCard("任务列表", "按状态和进度快速扫视所有下载任务。")
        table_layout = table_card.body_layout

        self.task_table = QTableWidget()
        self.task_table.setColumnCount(6)
        self.task_table.setHorizontalHeaderLabels(
            ["平台", "标题", "状态", "进度", "速度", "剩余时间"]
        )
        self.task_table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.task_table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.task_table.setAlternatingRowColors(True)
        self.task_table.setShowGrid(False)
        self.task_table.verticalHeader().setVisible(False)
        self.task_table.itemSelectionChanged.connect(self._update_action_states)
        self.task_table.horizontalHeader().setStretchLastSection(True)
        self.task_table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeMode.Stretch)
        self.task_table.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeMode.ResizeToContents)
        self.task_table.horizontalHeader().setSectionResizeMode(2, QHeaderView.ResizeMode.ResizeToContents)
        self.task_table.horizontalHeader().setSectionResizeMode(3, QHeaderView.ResizeMode.ResizeToContents)
        self.task_table.horizontalHeader().setSectionResizeMode(4, QHeaderView.ResizeMode.ResizeToContents)
        self.task_table.horizontalHeader().setSectionResizeMode(5, QHeaderView.ResizeMode.ResizeToContents)
        self.task_table.verticalHeader().setDefaultSectionSize(70)
        table_layout.addWidget(self.task_table)

        self.empty_state_label = QLabel("还没有下载任务。添加链接后，进度和状态会显示在这里。")
        self.empty_state_label.setObjectName("EmptyStateLabel")
        self.empty_state_label.setWordWrap(True)
        table_layout.addWidget(self.empty_state_label)

        hint_label = QLabel("选中一条任务后，可使用下方按钮进行暂停、恢复、取消或重试。")
        hint_label.setObjectName("PageHint")
        table_layout.addWidget(hint_label)

        layout.addWidget(table_card, 1)

        action_card = SectionCard("任务操作", "针对当前选中的任务执行管理动作。")
        action_layout = action_card.body_layout

        btn_layout = QHBoxLayout()
        btn_layout.setSpacing(10)

        self.pause_btn = QPushButton("暂停")
        self.pause_btn.setObjectName("ghostActionButton")
        self.pause_btn.clicked.connect(self.pause_selected_task)
        btn_layout.addWidget(self.pause_btn)

        self.resume_btn = QPushButton("恢复")
        self.resume_btn.setObjectName("ghostActionButton")
        self.resume_btn.clicked.connect(self.resume_selected_task)
        btn_layout.addWidget(self.resume_btn)

        self.cancel_btn = QPushButton("取消")
        self.cancel_btn.setObjectName("ghostActionButton")
        self.cancel_btn.clicked.connect(self.cancel_selected_task)
        btn_layout.addWidget(self.cancel_btn)

        self.retry_btn = QPushButton("重试")
        self.retry_btn.setObjectName("primaryActionButton")
        self.retry_btn.clicked.connect(self.retry_selected_task)
        btn_layout.addWidget(self.retry_btn)

        btn_layout.addStretch()
        action_layout.addLayout(btn_layout)
        layout.addWidget(action_card)

        self.setLayout(layout)
        self._update_action_states()

    def setup_connections(self):
        self.download_manager.task_added.connect(self._structure_changed)
        self.download_manager.task_started.connect(self._structure_changed)
        self.download_manager.task_progress.connect(self._on_progress)
        self.download_manager.task_completed.connect(self._structure_changed)
        self.download_manager.task_failed.connect(self._structure_changed)
        self.download_manager.task_paused.connect(self._structure_changed)
        self.download_manager.task_cancelled.connect(self._structure_changed)

    def start_refresh_timer(self):
        self.refresh_timer = QTimer(self)
        self.refresh_timer.timeout.connect(self._flush_progress_refresh)
        self.refresh_timer.start(1000)

    def shutdown(self):
        if hasattr(self, "refresh_timer"):
            self.refresh_timer.stop()
        self._progress_throttle.stop()

    def _structure_changed(self, *_args):
        self.refresh_table()
        self.refresh_overview()

    def _on_progress(self, *_args):
        self._pending_progress_refresh = True
        if not self._progress_throttle.isActive():
            self._progress_throttle.start()

    def _flush_progress_refresh(self):
        if not self._pending_progress_refresh:
            self._update_existing_rows()
            return
        self._pending_progress_refresh = False
        self._update_existing_rows()
        self.refresh_overview()

    def refresh_overview(self):
        tasks = self.download_manager.get_all_tasks().values()
        active = sum(1 for task in tasks if task.status in {TaskStatus.PENDING, TaskStatus.DOWNLOADING})
        completed = sum(1 for task in tasks if task.status == TaskStatus.COMPLETED)
        failed = sum(1 for task in tasks if task.status == TaskStatus.FAILED)
        self.header.set_metrics(
            [
                ("活跃任务", str(active), "等待或下载中的任务"),
                ("已完成", str(completed), "当前任务列表中的完成数"),
                ("失败", str(failed), "当前任务列表中的失败数"),
            ]
        )

    def refresh_table(self):
        """增量同步任务表格，并保留选中 task_id。"""
        selected_id = self.get_selected_task_id()
        tasks = self.download_manager.get_all_tasks()
        task_ids = list(tasks.keys())

        # 删除已不存在的行（从后往前）
        for task_id in list(self._row_by_task_id.keys()):
            if task_id not in tasks:
                row = self._row_by_task_id.pop(task_id)
                self.task_table.removeRow(row)
                self._progress_bars.pop(task_id, None)
                self._status_badges.pop(task_id, None)
                self._reindex_rows()

        # 按当前顺序确保行存在并更新
        for desired_row, task_id in enumerate(task_ids):
            task = tasks[task_id]
            if task_id not in self._row_by_task_id:
                self.task_table.insertRow(desired_row)
                self._create_row(desired_row, task_id, task)
            else:
                current_row = self._row_by_task_id[task_id]
                if current_row != desired_row:
                    # 简单重建映射：移动成本高时直接更新内容
                    pass
                self._update_row(self._row_by_task_id.get(task_id, desired_row), task_id, task)

        self._reindex_rows()
        # 按 task_ids 顺序校正行内容（避免错位）
        for row, task_id in enumerate(task_ids):
            self._row_by_task_id[task_id] = row
            self._update_row(row, task_id, tasks[task_id])

        self.empty_state_label.setVisible(len(tasks) == 0)

        if selected_id and selected_id in self._row_by_task_id:
            row = self._row_by_task_id[selected_id]
            self.task_table.selectRow(row)

        self._update_action_states()
        self.refresh_overview()

    def _reindex_rows(self):
        mapping = {}
        for row in range(self.task_table.rowCount()):
            item = self.task_table.item(row, 0)
            if item:
                tid = item.data(Qt.ItemDataRole.UserRole)
                if tid:
                    mapping[tid] = row
        self._row_by_task_id = mapping

    def _create_row(self, row: int, task_id: str, task):
        platform_icon = PlatformDetector.get_icon(task.video_info.platform)
        platform_item = QTableWidgetItem(platform_icon)
        platform_item.setData(Qt.ItemDataRole.UserRole, task_id)
        platform_item.setTextAlignment(Qt.AlignmentFlag.AlignCenter)
        self.task_table.setItem(row, 0, platform_item)

        title_item = QTableWidgetItem(task.video_info.title)
        title_item.setToolTip(task.video_info.title)
        self.task_table.setItem(row, 1, title_item)

        status_widget = self._build_status_badge(task.status)
        self.task_table.setCellWidget(row, 2, status_widget)
        self._status_badges[task_id] = status_widget

        progress_widget = self._build_progress_bar(task.progress)
        self.task_table.setCellWidget(row, 3, progress_widget)
        self._progress_bars[task_id] = progress_widget

        speed_item = QTableWidgetItem(task.speed)
        speed_item.setTextAlignment(Qt.AlignmentFlag.AlignCenter)
        self.task_table.setItem(row, 4, speed_item)

        eta_item = QTableWidgetItem(task.eta)
        eta_item.setTextAlignment(Qt.AlignmentFlag.AlignCenter)
        self.task_table.setItem(row, 5, eta_item)

        self._row_by_task_id[task_id] = row

    def _update_row(self, row: int, task_id: str, task):
        if row < 0 or row >= self.task_table.rowCount():
            return

        platform_item = self.task_table.item(row, 0)
        if platform_item is None:
            self._create_row(row, task_id, task)
            return

        platform_item.setText(PlatformDetector.get_icon(task.video_info.platform))
        platform_item.setData(Qt.ItemDataRole.UserRole, task_id)

        title_item = self.task_table.item(row, 1)
        if title_item:
            title_item.setText(task.video_info.title)
            title_item.setToolTip(task.video_info.title)

        badge = self._status_badges.get(task_id)
        label, tone = self._status_label_tone(task.status)
        if badge is None:
            badge = self._build_status_badge(task.status)
            self.task_table.setCellWidget(row, 2, badge)
            self._status_badges[task_id] = badge
        else:
            badge.setText(label)
            badge.setTone(tone)

        bar = self._progress_bars.get(task_id)
        if bar is None:
            bar = self._build_progress_bar(task.progress)
            self.task_table.setCellWidget(row, 3, bar)
            self._progress_bars[task_id] = bar
        else:
            bar.setValue(int(max(0, min(100, task.progress))))

        speed_item = self.task_table.item(row, 4)
        if speed_item:
            speed_item.setText(task.speed)
        eta_item = self.task_table.item(row, 5)
        if eta_item:
            eta_item.setText(task.eta)

    def _update_existing_rows(self):
        tasks = self.download_manager.get_all_tasks()
        for task_id, row in list(self._row_by_task_id.items()):
            task = tasks.get(task_id)
            if task:
                self._update_row(row, task_id, task)
        self._update_action_states()

    def _status_label_tone(self, status: TaskStatus):
        status_map = {
            TaskStatus.PENDING: ("等待中", "neutral"),
            TaskStatus.DOWNLOADING: ("下载中", "primary"),
            TaskStatus.PAUSED: ("已暂停", "warning"),
            TaskStatus.COMPLETED: ("已完成", "success"),
            TaskStatus.FAILED: ("失败", "error"),
            TaskStatus.CANCELLED: ("已取消", "neutral"),
        }
        return status_map.get(status, ("未知", "neutral"))

    def _build_status_badge(self, status: TaskStatus) -> StatusBadge:
        label, tone = self._status_label_tone(status)
        return StatusBadge(label, tone)

    def _build_progress_bar(self, progress: float) -> QProgressBar:
        bar = QProgressBar()
        bar.setRange(0, 100)
        bar.setValue(int(max(0, min(100, progress))))
        bar.setTextVisible(True)
        return bar

    def get_selected_task_id(self) -> str:
        selected_rows = self.task_table.selectedIndexes()
        if not selected_rows:
            return ""
        row = selected_rows[0].row()
        task_id_item = self.task_table.item(row, 0)
        if not task_id_item:
            return ""
        return task_id_item.data(Qt.ItemDataRole.UserRole) or ""

    def pause_selected_task(self):
        task_id = self.get_selected_task_id()
        if task_id:
            self.download_manager.pause_task(task_id)
            self._update_action_states()

    def resume_selected_task(self):
        task_id = self.get_selected_task_id()
        if task_id:
            self.download_manager.resume_task(task_id)
            self._update_action_states()

    def cancel_selected_task(self):
        task_id = self.get_selected_task_id()
        if task_id:
            self.download_manager.cancel_task(task_id)
            self._update_action_states()

    def retry_selected_task(self):
        task_id = self.get_selected_task_id()
        if task_id:
            self.download_manager.retry_task(task_id)
            self._update_action_states()

    def _update_action_states(self):
        task_id = self.get_selected_task_id()
        task = self.download_manager.get_task(task_id) if task_id else None
        status = task.status if task else None

        self.pause_btn.setEnabled(status == TaskStatus.DOWNLOADING)
        self.resume_btn.setEnabled(status == TaskStatus.PAUSED)
        self.cancel_btn.setEnabled(
            status in {TaskStatus.PENDING, TaskStatus.DOWNLOADING, TaskStatus.PAUSED}
        )
        self.retry_btn.setEnabled(status == TaskStatus.FAILED)
