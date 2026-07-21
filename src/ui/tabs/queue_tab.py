"""
队列标签页，显示和管理下载任务。
"""
from __future__ import annotations

import os
import platform
import subprocess

from PyQt6.QtCore import Qt, QItemSelectionModel, QTimer
from PyQt6.QtGui import QAction, QDesktopServices
from PyQt6.QtWidgets import (
    QAbstractItemView,
    QApplication,
    QHBoxLayout,
    QHeaderView,
    QMenu,
    QPushButton,
    QTableView,
    QVBoxLayout,
    QWidget,
)

from src.ui.qt_manager_adapter import QtDownloadManager
from src.core.download_task import TaskStatus
from src.ui.components.chrome import BodyLabel, PageHeader, SectionCard
from src.ui.components.empty_state import EmptyStateWidget
from src.ui.components.toast import ToastService
from src.ui.tabs.queue_model import ProgressDelegate, QueueTableModel, StatusDelegate, TASK_ID_ROLE
from src.utils.logger import setup_logger

logger = setup_logger("QueueTab")


class QueueTab(QWidget):
    """队列标签页。"""

    def __init__(self, download_manager: QtDownloadManager, toast: ToastService | None = None):
        super().__init__()
        self.download_manager = download_manager
        self.toast = toast
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

        toolbar = QHBoxLayout()
        toolbar.setSpacing(10)

        self.pause_all_btn = QPushButton("全部暂停")
        self.pause_all_btn.setObjectName("ghostActionButton")
        self.pause_all_btn.setToolTip("暂停所有正在下载的任务")
        self.pause_all_btn.clicked.connect(self.pause_all_downloading)
        toolbar.addWidget(self.pause_all_btn)

        self.resume_all_btn = QPushButton("全部开始")
        self.resume_all_btn.setObjectName("ghostActionButton")
        self.resume_all_btn.setToolTip("恢复所有已暂停的任务")
        self.resume_all_btn.clicked.connect(self.resume_all_paused)
        toolbar.addWidget(self.resume_all_btn)

        self.clear_finished_btn = QPushButton("清除已完成")
        self.clear_finished_btn.setObjectName("ghostActionButton")
        self.clear_finished_btn.setToolTip("从列表移除已完成和已取消的任务")
        self.clear_finished_btn.clicked.connect(self.clear_finished_tasks)
        toolbar.addWidget(self.clear_finished_btn)

        toolbar.addStretch()

        self.pause_btn = QPushButton("暂停")
        self.pause_btn.setObjectName("ghostActionButton")
        self.pause_btn.setToolTip("暂停选中的下载任务")
        self.pause_btn.clicked.connect(self.pause_selected_task)
        toolbar.addWidget(self.pause_btn)

        self.resume_btn = QPushButton("恢复")
        self.resume_btn.setObjectName("ghostActionButton")
        self.resume_btn.setToolTip("恢复选中的暂停任务")
        self.resume_btn.clicked.connect(self.resume_selected_task)
        toolbar.addWidget(self.resume_btn)

        self.cancel_btn = QPushButton("取消")
        self.cancel_btn.setObjectName("ghostActionButton")
        self.cancel_btn.setToolTip("取消选中的任务")
        self.cancel_btn.clicked.connect(self.cancel_selected_task)
        toolbar.addWidget(self.cancel_btn)

        self.retry_btn = QPushButton("重试")
        self.retry_btn.setObjectName("primaryActionButton")
        self.retry_btn.setToolTip("重试选中的失败任务")
        self.retry_btn.clicked.connect(self.retry_selected_task)
        toolbar.addWidget(self.retry_btn)

        table_layout.addLayout(toolbar)

        self.table_model = QueueTableModel(self.download_manager, self)
        self.task_table = QTableView()
        self.task_table.setModel(self.table_model)
        self.task_table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.task_table.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)
        self.task_table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.task_table.setAlternatingRowColors(True)
        self.task_table.setShowGrid(False)
        self.task_table.verticalHeader().setVisible(False)
        self.task_table.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self.task_table.customContextMenuRequested.connect(self._show_context_menu)
        self.task_table.selectionModel().selectionChanged.connect(self._update_action_states)

        header = self.task_table.horizontalHeader()
        header.setStretchLastSection(True)
        header.setSectionResizeMode(1, QHeaderView.ResizeMode.Stretch)
        for col in (0, 2, 3, 4, 5):
            header.setSectionResizeMode(col, QHeaderView.ResizeMode.ResizeToContents)

        self.task_table.setItemDelegateForColumn(2, StatusDelegate(self.task_table))
        self.task_table.setItemDelegateForColumn(3, ProgressDelegate(self.task_table))
        self.task_table.verticalHeader().setDefaultSectionSize(52)
        table_layout.addWidget(self.task_table)

        self.empty_state = EmptyStateWidget(
            "还没有下载任务。",
            "添加链接后，进度和状态会显示在这里。",
        )
        table_layout.addWidget(self.empty_state)

        hint_label = QWidget()
        hint_layout = QHBoxLayout(hint_label)
        hint_layout.setContentsMargins(0, 0, 0, 0)
        hint = BodyLabel("右键任务可快速操作；支持多选批量管理。")
        hint.setObjectName("PageHint")
        hint_layout.addWidget(hint)
        table_layout.addWidget(hint_label)

        layout.addWidget(table_card, 1)
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
        if self._pending_progress_refresh:
            self._pending_progress_refresh = False
            self.table_model.refresh_rows()
            self.refresh_overview()
        else:
            self.table_model.refresh_rows()
        self._update_action_states()

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
        selected_ids = self.get_selected_task_ids()
        self.table_model.refresh_structure()
        has_tasks = self.table_model.rowCount() > 0
        self.empty_state.setVisible(not has_tasks)
        self.task_table.setVisible(has_tasks)

        if selected_ids:
            selection = self.task_table.selectionModel()
            for row in range(self.table_model.rowCount()):
                task_id = self.table_model.task_id_at(row)
                if task_id in selected_ids:
                    index = self.table_model.index(row, 0)
                    selection.select(
                        index,
                        QItemSelectionModel.SelectionFlag.Select | QItemSelectionModel.SelectionFlag.Rows,
                    )

        self._update_action_states()
        self.refresh_overview()

    def get_selected_task_ids(self) -> list[str]:
        indexes = self.task_table.selectionModel().selectedRows()
        task_ids = []
        for index in indexes:
            task_id = self.table_model.data(index, TASK_ID_ROLE)
            if task_id:
                task_ids.append(str(task_id))
        return task_ids

    def get_selected_task_id(self) -> str:
        ids = self.get_selected_task_ids()
        return ids[0] if ids else ""

    def _show_context_menu(self, pos):
        task_id = self._task_id_at_pos(pos)
        if not task_id:
            return
        if task_id not in self.get_selected_task_ids():
            self._select_row_at_pos(pos)

        menu = QMenu(self)
        menu.addAction(self._make_action("暂停", self.pause_selected_task))
        menu.addAction(self._make_action("恢复", self.resume_selected_task))
        menu.addAction(self._make_action("取消", self.cancel_selected_task))
        menu.addAction(self._make_action("重试", self.retry_selected_task))
        menu.addSeparator()
        menu.addAction(self._make_action("复制链接", self.copy_selected_link))
        menu.addAction(self._make_action("打开文件", self.open_selected_file))
        menu.addAction(self._make_action("在访达中显示", self.reveal_selected_file))
        menu.exec(self.task_table.viewport().mapToGlobal(pos))

    def _make_action(self, text: str, slot) -> QAction:
        action = QAction(text, self)
        action.triggered.connect(slot)
        return action

    def _task_id_at_pos(self, pos) -> str:
        index = self.task_table.indexAt(pos)
        if not index.isValid():
            return ""
        return self.table_model.task_id_at(index.row())

    def _select_row_at_pos(self, pos):
        index = self.task_table.indexAt(pos)
        if index.isValid():
            self.task_table.selectRow(index.row())

    def pause_selected_task(self):
        for task_id in self.get_selected_task_ids():
            self.download_manager.pause_task(task_id)
        self._update_action_states()

    def resume_selected_task(self):
        for task_id in self.get_selected_task_ids():
            self.download_manager.resume_task(task_id)
        self._update_action_states()

    def cancel_selected_task(self):
        for task_id in self.get_selected_task_ids():
            self.download_manager.cancel_task(task_id)
        self._update_action_states()

    def retry_selected_task(self):
        for task_id in self.get_selected_task_ids():
            self.download_manager.retry_task(task_id)
        self._update_action_states()

    def pause_all_downloading(self):
        for task in self.download_manager.get_all_tasks().values():
            if task.status == TaskStatus.DOWNLOADING:
                self.download_manager.pause_task(task.id)

    def resume_all_paused(self):
        for task in self.download_manager.get_all_tasks().values():
            if task.status == TaskStatus.PAUSED:
                self.download_manager.resume_task(task.id)

    def clear_finished_tasks(self):
        to_remove = [
            task_id
            for task_id, task in self.download_manager.get_all_tasks().items()
            if task.status in {TaskStatus.COMPLETED, TaskStatus.CANCELLED}
        ]
        for task_id in to_remove:
            self.download_manager.remove_task(task_id)
        self.refresh_table()

    def copy_selected_link(self):
        task_id = self.get_selected_task_id()
        task = self.download_manager.get_task(task_id)
        if not task:
            return
        QApplication.clipboard().setText(task.video_info.url)
        if self.toast:
            self.toast.show_info("已复制", "视频链接已复制到剪贴板")

    def open_selected_file(self):
        task_id = self.get_selected_task_id()
        task = self.download_manager.get_task(task_id)
        if not task or not task.file_path or not os.path.isfile(task.file_path):
            if self.toast:
                self.toast.show_warning("无法打开", "文件不存在或任务尚未完成")
            return
        QDesktopServices.openUrl(QtCore_QUrl_from_path(task.file_path))

    def reveal_selected_file(self):
        task_id = self.get_selected_task_id()
        task = self.download_manager.get_task(task_id)
        if not task or not task.file_path or not os.path.isfile(task.file_path):
            if self.toast:
                self.toast.show_warning("无法显示", "文件不存在或任务尚未完成")
            return
        if platform.system() == "Darwin":
            subprocess.run(["open", "-R", task.file_path], check=False)
        else:
            QDesktopServices.openUrl(QtCore_QUrl_from_path(os.path.dirname(task.file_path)))

    def _update_action_states(self):
        selected_ids = self.get_selected_task_ids()
        tasks = [self.download_manager.get_task(task_id) for task_id in selected_ids]
        tasks = [task for task in tasks if task is not None]
        if not tasks:
            self.pause_btn.setEnabled(False)
            self.resume_btn.setEnabled(False)
            self.cancel_btn.setEnabled(False)
            self.retry_btn.setEnabled(False)
            return

        statuses = {task.status for task in tasks}
        self.pause_btn.setEnabled(TaskStatus.DOWNLOADING in statuses)
        self.resume_btn.setEnabled(TaskStatus.PAUSED in statuses)
        self.cancel_btn.setEnabled(
            bool(statuses & {TaskStatus.PENDING, TaskStatus.DOWNLOADING, TaskStatus.PAUSED})
        )
        self.retry_btn.setEnabled(TaskStatus.FAILED in statuses)


def QtCore_QUrl_from_path(path: str):
    from PyQt6.QtCore import QUrl

    return QUrl.fromLocalFile(path)
