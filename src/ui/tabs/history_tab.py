"""
历史记录标签页，显示和管理下载历史。
"""
from __future__ import annotations

import os

from PyQt6.QtCore import Qt, QTimer
from PyQt6.QtGui import QDesktopServices
from PyQt6.QtWidgets import (
    QAbstractItemView,
    QComboBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPushButton,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
    QHeaderView,
)

from src.ui.qt_manager_adapter import QtDownloadManager
from src.core.download_task import DownloadTask, VideoInfo
from src.data.config_manager import ConfigManager
from src.data.database import HistoryDB
from src.ui.components.chrome import BodyLabel, PageHeader, SectionCard, StatusBadge
from src.ui.components.empty_state import EmptyStateWidget
from src.ui.components.toast import ToastService
from src.utils.logger import setup_logger

logger = setup_logger("HistoryTab")


class HistoryTab(QWidget):
    """历史记录标签页。"""

    def __init__(self, download_manager: QtDownloadManager, toast: ToastService | None = None):
        super().__init__()
        self.download_manager = download_manager
        self.db = HistoryDB()
        self.config = ConfigManager()
        self.toast = toast
        self._records_cache = []
        self._filter_timer = QTimer(self)
        self._filter_timer.setSingleShot(True)
        self._filter_timer.setInterval(300)
        self._filter_timer.timeout.connect(self._apply_filters)
        self.init_ui()
        self.load_history()

    def init_ui(self):
        layout = QVBoxLayout()
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(18)

        self.header = PageHeader(
            "历史记录",
            "快速检索过去下载过的任务，并重新加入下载队列。",
            metrics=[
                ("显示记录", "0", "当前列表内的记录数"),
                ("已完成", "0", "当前列表中的完成记录"),
                ("失败", "0", "可重新下载的失败记录"),
            ],
        )
        layout.addWidget(self.header)

        search_card = SectionCard("搜索历史", "按标题、链接或上传者检索记录。")
        search_layout = search_card.body_layout

        search_row = QHBoxLayout()
        search_row.setSpacing(12)
        self.search_input = QLineEdit()
        self.search_input.setPlaceholderText("搜索标题、链接或上传者")
        self.search_input.setToolTip("输入关键词即时过滤")
        self.search_input.textChanged.connect(self._schedule_filter)
        search_row.addWidget(self.search_input, 1)

        search_row.addWidget(QLabel("状态"))
        self.status_filter = QComboBox()
        self.status_filter.addItem("全部", userData="all")
        self.status_filter.addItem("已完成", userData="completed")
        self.status_filter.addItem("失败", userData="failed")
        self.status_filter.addItem("下载中", userData="downloading")
        self.status_filter.addItem("已取消", userData="cancelled")
        self.status_filter.currentIndexChanged.connect(self._apply_filters)
        search_row.addWidget(self.status_filter)

        self.refresh_btn = QPushButton("刷新")
        self.refresh_btn.setObjectName("ghostActionButton")
        self.refresh_btn.clicked.connect(self.load_history)
        search_row.addWidget(self.refresh_btn)
        search_layout.addLayout(search_row)

        search_hint = BodyLabel("支持即时过滤、多选删除与一键重新下载。")
        search_hint.setObjectName("PageHint")
        search_layout.addWidget(search_hint)

        layout.addWidget(search_card)

        table_card = SectionCard("下载记录", "查看已完成、失败和历史任务。")
        table_layout = table_card.body_layout

        self.history_table = QTableWidget()
        self.history_table.setColumnCount(5)
        self.history_table.setHorizontalHeaderLabels([
            "平台",
            "标题",
            "上传者",
            "状态",
            "完成时间",
        ])
        self.history_table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.history_table.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)
        self.history_table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.history_table.setAlternatingRowColors(True)
        self.history_table.setShowGrid(False)
        self.history_table.verticalHeader().setVisible(False)
        self.history_table.itemSelectionChanged.connect(self._update_action_states)
        self.history_table.horizontalHeader().setStretchLastSection(True)
        self.history_table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeMode.Stretch)
        for col in (0, 2, 3, 4):
            self.history_table.horizontalHeader().setSectionResizeMode(col, QHeaderView.ResizeMode.ResizeToContents)
        self.history_table.verticalHeader().setDefaultSectionSize(56)
        table_layout.addWidget(self.history_table)

        self.empty_state = EmptyStateWidget("暂无下载记录。", "完成或失败的任务会保存在这里。")
        table_layout.addWidget(self.empty_state)

        layout.addWidget(table_card, 1)

        action_card = SectionCard("记录操作", "选中记录后可执行以下操作。")
        action_layout = action_card.body_layout

        action_row = QHBoxLayout()
        action_row.setSpacing(10)

        self.redownload_btn = QPushButton("加入队列")
        self.redownload_btn.setObjectName("primaryActionButton")
        self.redownload_btn.setToolTip("将选中记录重新加入下载队列")
        self.redownload_btn.clicked.connect(self.redownload_selected)
        action_row.addWidget(self.redownload_btn)

        self.open_file_btn = QPushButton("打开文件")
        self.open_file_btn.setObjectName("ghostActionButton")
        self.open_file_btn.clicked.connect(self.open_selected_file)
        action_row.addWidget(self.open_file_btn)

        self.delete_btn = QPushButton("删除记录")
        self.delete_btn.setObjectName("ghostActionButton")
        self.delete_btn.clicked.connect(self.delete_selected)
        action_row.addWidget(self.delete_btn)

        self.delete_batch_btn = QPushButton("批量删除")
        self.delete_batch_btn.setObjectName("ghostActionButton")
        self.delete_batch_btn.clicked.connect(self.delete_selected)
        action_row.addWidget(self.delete_batch_btn)

        self.clear_btn = QPushButton("清空历史")
        self.clear_btn.setObjectName("ghostActionButton")
        self.clear_btn.clicked.connect(self.clear_history)
        action_row.addWidget(self.clear_btn)

        action_row.addStretch()
        action_layout.addLayout(action_row)
        layout.addWidget(action_card)

        self.setLayout(layout)
        self._update_action_states()

    def load_history(self):
        records = self.db.get_all_download_records(limit=500)
        self._records_cache = list(records)
        self._apply_filters()

    def _schedule_filter(self):
        self._filter_timer.start()

    def _apply_filters(self):
        query = self.search_input.text().strip().lower()
        status_filter = self.status_filter.currentData() or "all"
        records = self._records_cache

        if status_filter != "all":
            records = [record for record in records if record.status == status_filter]

        if query:
            records = [
                record
                for record in records
                if query in (record.title or "").lower()
                or query in (record.url or "").lower()
                or query in (record.uploader or "").lower()
            ]

        self.display_records(records)

    def display_records(self, records):
        self.history_table.setRowCount(len(records))
        empty_text = (
            "没有匹配的历史记录。"
            if self.search_input.text().strip() or self.status_filter.currentData() != "all"
            else "暂无下载记录。完成或失败的任务会保存在这里。"
        )
        self.empty_state.set_message(empty_text)
        self.empty_state.setVisible(len(records) == 0)
        self.history_table.setVisible(len(records) > 0)

        for row, record in enumerate(records):
            platform_item = QTableWidgetItem(record.platform)
            platform_item.setTextAlignment(Qt.AlignmentFlag.AlignCenter)
            platform_item.setData(Qt.ItemDataRole.UserRole, {"record_id": record.id, "url": record.url, "file_path": record.file_path})
            self.history_table.setItem(row, 0, platform_item)

            title_item = QTableWidgetItem(record.title)
            title_item.setToolTip(record.title)
            self.history_table.setItem(row, 1, title_item)

            uploader_item = QTableWidgetItem(record.uploader)
            uploader_item.setToolTip(record.uploader)
            self.history_table.setItem(row, 2, uploader_item)

            status_badge = self._build_status_badge(record.status)
            self.history_table.setCellWidget(row, 3, status_badge)

            completed_time = record.completed_at.strftime("%Y-%m-%d %H:%M") if record.completed_at else "暂无"
            completed_item = QTableWidgetItem(completed_time)
            completed_item.setTextAlignment(Qt.AlignmentFlag.AlignCenter)
            self.history_table.setItem(row, 4, completed_item)

        self._update_action_states()
        self.refresh_overview(records)

    def refresh_overview(self, records=None):
        if records is None:
            records = self._filtered_records()
        completed = sum(1 for record in records if getattr(record, "status", None) == "completed")
        failed = sum(1 for record in records if getattr(record, "status", None) == "failed")
        self.header.set_metrics(
            [
                ("显示记录", str(len(records)), "当前筛选结果"),
                ("已完成", str(completed), "历史中的完成任务"),
                ("失败", str(failed), "历史中的失败任务"),
            ]
        )

    def _filtered_records(self):
        query = self.search_input.text().strip().lower() if hasattr(self, "search_input") else ""
        status_filter = "all"
        if hasattr(self, "status_filter"):
            status_filter = self.status_filter.currentData() or "all"
        records = list(self._records_cache)
        if status_filter != "all":
            records = [record for record in records if record.status == status_filter]
        if query:
            records = [
                record
                for record in records
                if query in (record.title or "").lower()
                or query in (record.url or "").lower()
                or query in (record.uploader or "").lower()
            ]
        return records

    def _current_display_records(self):
        return self._filtered_records()

    def _build_status_badge(self, status: str) -> StatusBadge:
        mapping = {
            "completed": ("已完成", "success"),
            "failed": ("失败", "error"),
            "pending": ("等待中", "neutral"),
            "downloading": ("下载中", "primary"),
            "paused": ("已暂停", "warning"),
            "cancelled": ("已取消", "neutral"),
        }
        label, tone = mapping.get(status, ("未知", "neutral"))
        return StatusBadge(label, tone)

    def get_selected_record_infos(self):
        selected_rows = sorted({index.row() for index in self.history_table.selectedIndexes()})
        infos = []
        for row in selected_rows:
            item = self.history_table.item(row, 0)
            if not item:
                continue
            payload = item.data(Qt.ItemDataRole.UserRole)
            if payload:
                infos.append(payload)
        return infos

    def redownload_selected(self):
        infos = self.get_selected_record_infos()
        if not infos:
            QMessageBox.warning(self, "需要选择", "请先选择一条记录")
            return

        for info in infos:
            url = info.get("url")
            if not url:
                continue
            video_info = VideoInfo(url=url, title="正在获取信息…")
            options = self.config.build_download_options()
            task = DownloadTask(video_info=video_info, options=options)
            self.download_manager.add_task(task)

        if self.toast:
            self.toast.show_success(f"已加入 {len(infos)} 个任务", "历史记录已重新加入队列")

    def open_selected_file(self):
        infos = self.get_selected_record_infos()
        if not infos:
            return
        file_path = infos[0].get("file_path") or ""
        if not file_path or not os.path.isfile(file_path):
            if self.toast:
                self.toast.show_warning("无法打开", "本地文件不存在")
            return
        QDesktopServices.openUrl(QtCore_QUrl_from_path(file_path))

    def delete_selected(self):
        infos = self.get_selected_record_infos()
        if not infos:
            QMessageBox.warning(self, "需要选择", "请先选择一条记录")
            return

        reply = QMessageBox.question(
            self,
            "删除记录",
            f"确定要删除选中的 {len(infos)} 条记录吗？",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
        )
        if reply != QMessageBox.StandardButton.Yes:
            return

        deleted_ids = {info.get("record_id") for info in infos if info.get("record_id")}
        for record_id in deleted_ids:
            self.db.delete_download_record(record_id)

        self._records_cache = [r for r in self._records_cache if r.id not in deleted_ids]
        self._apply_filters()
        if self.toast:
            self.toast.show_success("记录已删除", f"已删除 {len(deleted_ids)} 条记录")

    def clear_history(self):
        if not self._records_cache:
            return
        reply = QMessageBox.question(
            self,
            "清空历史",
            "确定要清空全部历史记录吗？此操作不可恢复。",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
        )
        if reply != QMessageBox.StandardButton.Yes:
            return
        for record in list(self._records_cache):
            self.db.delete_download_record(record.id)
        self._records_cache = []
        self._apply_filters()
        if self.toast:
            self.toast.show_success("历史已清空", "所有下载记录已删除")

    def _update_action_states(self):
        infos = self.get_selected_record_infos()
        has_selection = bool(infos)
        self.redownload_btn.setEnabled(has_selection)
        self.delete_btn.setEnabled(has_selection)
        self.delete_batch_btn.setEnabled(len(infos) > 1)
        file_path = infos[0].get("file_path") if infos else ""
        self.open_file_btn.setEnabled(bool(file_path and os.path.isfile(file_path)))


def QtCore_QUrl_from_path(path: str):
    from PyQt6.QtCore import QUrl

    return QUrl.fromLocalFile(path)
