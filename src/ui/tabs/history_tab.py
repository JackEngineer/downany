"""
历史记录标签页，显示和管理下载历史。
"""
from __future__ import annotations

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import (
    QAbstractItemView,
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

from src.core.download_manager import DownloadManager
from src.core.download_task import DownloadTask, VideoInfo
from src.data.config_manager import ConfigManager
from src.data.database import HistoryDB
from src.ui.components.chrome import BodyLabel, PageHeader, SectionCard, StatusBadge
from src.utils.logger import setup_logger

logger = setup_logger("HistoryTab")


class HistoryTab(QWidget):
    """历史记录标签页。"""

    def __init__(self, download_manager: DownloadManager):
        super().__init__()
        self.download_manager = download_manager
        self.db = HistoryDB()
        self.config = ConfigManager()
        self._records_cache = []
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
        self.search_input.returnPressed.connect(self.search_history)
        search_row.addWidget(self.search_input, 1)

        self.search_btn = QPushButton("搜索")
        self.search_btn.clicked.connect(self.search_history)
        search_row.addWidget(self.search_btn)

        self.refresh_btn = QPushButton("刷新")
        self.refresh_btn.setObjectName("ghostActionButton")
        self.refresh_btn.clicked.connect(self.load_history)
        search_row.addWidget(self.refresh_btn)
        search_layout.addLayout(search_row)

        search_hint = BodyLabel("记录会按最近时间排序，支持一键重新下载或删除。")
        search_hint.setObjectName("PageHint")
        search_layout.addWidget(search_hint)

        layout.addWidget(search_card)

        table_card = SectionCard("下载记录", "查看已完成、失败和历史任务。")
        table_layout = table_card.body_layout

        self.history_table = QTableWidget()
        self.history_table.setColumnCount(6)
        self.history_table.setHorizontalHeaderLabels([
            "平台",
            "标题",
            "上传者",
            "状态",
            "完成时间",
            "操作",
        ])
        self.history_table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.history_table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.history_table.setAlternatingRowColors(True)
        self.history_table.setShowGrid(False)
        self.history_table.verticalHeader().setVisible(False)
        self.history_table.itemSelectionChanged.connect(self._update_action_states)
        self.history_table.horizontalHeader().setStretchLastSection(True)
        self.history_table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeMode.Stretch)
        self.history_table.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeMode.ResizeToContents)
        self.history_table.horizontalHeader().setSectionResizeMode(2, QHeaderView.ResizeMode.ResizeToContents)
        self.history_table.horizontalHeader().setSectionResizeMode(3, QHeaderView.ResizeMode.ResizeToContents)
        self.history_table.horizontalHeader().setSectionResizeMode(4, QHeaderView.ResizeMode.ResizeToContents)
        self.history_table.horizontalHeader().setSectionResizeMode(5, QHeaderView.ResizeMode.ResizeToContents)
        self.history_table.verticalHeader().setDefaultSectionSize(66)
        table_layout.addWidget(self.history_table)

        self.empty_state_label = QLabel("暂无下载记录。完成或失败的任务会保存在这里。")
        self.empty_state_label.setObjectName("EmptyStateLabel")
        self.empty_state_label.setWordWrap(True)
        table_layout.addWidget(self.empty_state_label)
        layout.addWidget(table_card, 1)

        action_card = SectionCard("记录操作", "先选中一条记录，再执行重下或删除。")
        action_layout = action_card.body_layout

        action_row = QHBoxLayout()
        action_row.setSpacing(10)

        self.redownload_btn = QPushButton("重新下载")
        self.redownload_btn.setObjectName("primaryActionButton")
        self.redownload_btn.clicked.connect(self.redownload_selected)
        action_row.addWidget(self.redownload_btn)

        self.delete_btn = QPushButton("删除记录")
        self.delete_btn.setObjectName("ghostActionButton")
        self.delete_btn.clicked.connect(self.delete_selected)
        action_row.addWidget(self.delete_btn)

        action_row.addStretch()
        action_layout.addLayout(action_row)
        layout.addWidget(action_card)

        self.setLayout(layout)
        self._update_action_states()

    def load_history(self):
        """加载历史记录。"""

        records = self.db.get_all_download_records(limit=100)
        self.display_records(records)

    def search_history(self):
        """搜索历史记录。"""

        query = self.search_input.text().strip()
        if not query:
            self.load_history()
            return

        records = self.db.search_download_records(query, limit=100)
        self.display_records(records)

    def display_records(self, records):
        """显示记录。"""

        self._records_cache = list(records)
        self.history_table.setRowCount(len(records))
        empty_text = (
            "没有匹配的历史记录。"
            if self.search_input.text().strip()
            else "暂无下载记录。完成或失败的任务会保存在这里。"
        )
        self.empty_state_label.setText(empty_text)

        for row, record in enumerate(records):
            platform_item = QTableWidgetItem(record.platform)
            platform_item.setTextAlignment(Qt.AlignmentFlag.AlignCenter)
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

            operation_item = QTableWidgetItem("选中后可操作")
            operation_item.setData(Qt.ItemDataRole.UserRole, {"record_id": record.id, "url": record.url})
            operation_item.setTextAlignment(Qt.AlignmentFlag.AlignCenter)
            self.history_table.setItem(row, 5, operation_item)

        self.empty_state_label.setVisible(len(records) == 0)
        self._update_action_states()
        self.refresh_overview()

    def refresh_overview(self):
        """刷新顶部摘要。"""

        records = self._records_cache
        completed = sum(1 for record in records if record.status == "completed")
        failed = sum(1 for record in records if record.status == "failed")
        self.header.set_metrics(
            [
                ("显示记录", str(len(records)), "当前筛选结果"),
                ("已完成", str(completed), "历史中的完成任务"),
                ("失败", str(failed), "历史中的失败任务"),
            ]
        )

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

    def get_selected_record_info(self):
        """获取选中的记录信息。"""

        selected_rows = self.history_table.selectedIndexes()
        if not selected_rows:
            return None, None

        row = selected_rows[0].row()
        info_item = self.history_table.item(row, 5)
        if not info_item:
            return None, None

        payload = info_item.data(Qt.ItemDataRole.UserRole)
        if not payload:
            return None, None

        return payload.get("record_id"), payload.get("url")

    def redownload_selected(self):
        """重新下载选中的记录。"""

        record_id, url = self.get_selected_record_info()
        if not url:
            QMessageBox.warning(self, "需要选择", "请先选择一条记录")
            return

        video_info = VideoInfo(url=url, title="正在获取信息…")
        options = self.config.build_download_options()
        task = DownloadTask(video_info=video_info, options=options)

        self.download_manager.add_task(task)
        QMessageBox.information(self, "已加入队列", "已添加到下载队列")

    def delete_selected(self):
        """删除选中的记录。"""

        record_id, url = self.get_selected_record_info()
        if not record_id:
            QMessageBox.warning(self, "需要选择", "请先选择一条记录")
            return

        reply = QMessageBox.question(
            self,
            "删除记录",
            "确定要删除这条记录吗？",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
        )

        if reply == QMessageBox.StandardButton.Yes:
            self.db.delete_download_record(record_id)
            self.load_history()
            QMessageBox.information(self, "记录已删除", "记录已删除")
            self._update_action_states()

    def _update_action_states(self):
        """根据当前选择更新记录操作按钮。"""

        record_id, url = self.get_selected_record_info()
        has_selection = bool(record_id and url)
        self.redownload_btn.setEnabled(has_selection)
        self.delete_btn.setEnabled(has_selection)
