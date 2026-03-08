"""
历史记录标签页，显示和管理下载历史。
"""
from PyQt6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLineEdit,
    QPushButton, QTableWidget, QTableWidgetItem,
    QHeaderView, QAbstractItemView, QMessageBox
)
from PyQt6.QtCore import Qt
from src.data.database import HistoryDB
from src.core.download_manager import DownloadManager
from src.core.download_task import DownloadTask, VideoInfo, DownloadOptions, Platform
from src.data.config_manager import ConfigManager
from src.utils.logger import setup_logger

logger = setup_logger("HistoryTab")


class HistoryTab(QWidget):
    """历史记录标签页"""

    def __init__(self, download_manager: DownloadManager):
        super().__init__()
        self.download_manager = download_manager
        self.db = HistoryDB()
        self.config = ConfigManager()
        self.init_ui()
        self.load_history()

    def init_ui(self):
        layout = QVBoxLayout()

        # 搜索栏
        search_layout = QHBoxLayout()
        self.search_input = QLineEdit()
        self.search_input.setPlaceholderText("搜索标题、链接或上传者...")
        self.search_input.returnPressed.connect(self.search_history)
        search_layout.addWidget(self.search_input)

        self.search_btn = QPushButton("搜索")
        self.search_btn.clicked.connect(self.search_history)
        search_layout.addWidget(self.search_btn)

        self.refresh_btn = QPushButton("刷新")
        self.refresh_btn.clicked.connect(self.load_history)
        search_layout.addWidget(self.refresh_btn)

        layout.addLayout(search_layout)

        # 历史记录表格
        self.history_table = QTableWidget()
        self.history_table.setColumnCount(6)
        self.history_table.setHorizontalHeaderLabels([
            "平台", "标题", "上传者", "状态", "完成时间", "操作"
        ])

        # 设置表格属性
        self.history_table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.history_table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.history_table.horizontalHeader().setStretchLastSection(True)
        self.history_table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeMode.Stretch)

        layout.addWidget(self.history_table)

        # 操作按钮
        btn_layout = QHBoxLayout()
        btn_layout.addStretch()

        self.redownload_btn = QPushButton("重新下载")
        self.redownload_btn.clicked.connect(self.redownload_selected)
        btn_layout.addWidget(self.redownload_btn)

        self.delete_btn = QPushButton("删除记录")
        self.delete_btn.clicked.connect(self.delete_selected)
        btn_layout.addWidget(self.delete_btn)

        layout.addLayout(btn_layout)
        self.setLayout(layout)

    def load_history(self):
        """加载历史记录"""
        records = self.db.get_all_download_records(limit=100)
        self.display_records(records)

    def search_history(self):
        """搜索历史记录"""
        query = self.search_input.text().strip()
        if not query:
            self.load_history()
            return

        records = self.db.search_download_records(query, limit=100)
        self.display_records(records)

    def display_records(self, records):
        """显示记录"""
        self.history_table.setRowCount(len(records))

        for row, record in enumerate(records):
            # 平台
            self.history_table.setItem(row, 0, QTableWidgetItem(record.platform))

            # 标题
            self.history_table.setItem(row, 1, QTableWidgetItem(record.title))

            # 上传者
            self.history_table.setItem(row, 2, QTableWidgetItem(record.uploader))

            # 状态
            self.history_table.setItem(row, 3, QTableWidgetItem(record.status))

            # 完成时间
            completed_time = record.completed_at.strftime("%Y-%m-%d %H:%M") if record.completed_at else "N/A"
            self.history_table.setItem(row, 4, QTableWidgetItem(completed_time))

            # 操作 (存储 record_id 和 url)
            self.history_table.setItem(row, 5, QTableWidgetItem(f"{record.id}|{record.url}"))

    def get_selected_record_info(self):
        """获取选中的记录信息"""
        selected_rows = self.history_table.selectedIndexes()
        if not selected_rows:
            return None, None

        row = selected_rows[0].row()
        info_item = self.history_table.item(row, 5)
        if not info_item:
            return None, None

        parts = info_item.text().split('|', 1)
        if len(parts) != 2:
            return None, None

        return parts[0], parts[1]  # record_id, url

    def redownload_selected(self):
        """重新下载选中的记录"""
        record_id, url = self.get_selected_record_info()
        if not url:
            QMessageBox.warning(self, "提示", "请选择一条记录")
            return

        # 创建下载任务
        video_info = VideoInfo(url=url, title="正在获取信息...")
        options = DownloadOptions(
            output_path=self.config.get_download_dir(),
            quality=self.config.get_default_quality(),
            download_subtitles=self.config.is_download_subtitles()
        )
        task = DownloadTask(video_info=video_info, options=options)

        self.download_manager.add_task(task)
        QMessageBox.information(self, "成功", "已添加到下载队列")

    def delete_selected(self):
        """删除选中的记录"""
        record_id, url = self.get_selected_record_info()
        if not record_id:
            QMessageBox.warning(self, "提示", "请选择一条记录")
            return

        reply = QMessageBox.question(
            self, "确认", "确定要删除这条记录吗？",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No
        )

        if reply == QMessageBox.StandardButton.Yes:
            self.db.delete_download_record(record_id)
            self.load_history()
            QMessageBox.information(self, "成功", "记录已删除")
