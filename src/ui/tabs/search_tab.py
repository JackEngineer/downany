"""
搜索标签页，支持在平台内搜索视频。
"""
from PyQt6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLineEdit,
    QPushButton, QLabel, QComboBox, QListWidget,
    QListWidgetItem, QMessageBox
)
from PyQt6.QtCore import Qt, QThread, pyqtSignal
import re
from src.core.search_engine import SearchEngine
from src.core.download_task import Platform, DownloadTask, VideoInfo, DownloadOptions
from src.core.download_manager import DownloadManager
from src.data.config_manager import ConfigManager
from src.data.database import HistoryDB
from src.ui.components import SearchResultItemWidget, ThumbnailLoader
from src.utils.logger import setup_logger

logger = setup_logger("SearchTab")


class SearchThread(QThread):
    """搜索线程"""
    results_signal = pyqtSignal(list)
    error_signal = pyqtSignal(str)

    def __init__(self, platform: Platform, query: str, proxy: str = None):
        super().__init__()
        self.platform = platform
        self.query = query
        self.proxy = proxy

    def run(self):
        try:
            results = SearchEngine.search(self.platform, self.query, max_results=20, proxy=self.proxy)
            self.results_signal.emit(results)
        except Exception as e:
            self.error_signal.emit(str(e))


class SearchTab(QWidget):
    """搜索标签页"""

    def __init__(self, download_manager: DownloadManager):
        super().__init__()
        self.download_manager = download_manager
        self.config = ConfigManager()
        self.db = HistoryDB()
        self.search_thread = None
        self.thumbnail_loader = ThumbnailLoader()
        self.init_ui()

    def init_ui(self):
        layout = QVBoxLayout()

        # 搜索栏
        search_layout = QHBoxLayout()

        search_layout.addWidget(QLabel("平台:"))
        self.platform_combo = QComboBox()
        self.platform_combo.addItem("YouTube", Platform.YOUTUBE)
        self.platform_combo.addItem("Bilibili", Platform.BILIBILI)
        search_layout.addWidget(self.platform_combo)

        self.search_input = QLineEdit()
        self.search_input.setPlaceholderText("输入搜索关键词...")
        self.search_input.returnPressed.connect(self.start_search)
        search_layout.addWidget(self.search_input)

        self.search_btn = QPushButton("搜索")
        self.search_btn.clicked.connect(self.start_search)
        search_layout.addWidget(self.search_btn)

        layout.addLayout(search_layout)

        # 结果列表
        self.result_list = QListWidget()
        self.result_list.itemDoubleClicked.connect(self.download_selected)
        layout.addWidget(self.result_list)

        # 操作按钮
        btn_layout = QHBoxLayout()
        btn_layout.addStretch()

        self.download_btn = QPushButton("下载选中")
        self.download_btn.clicked.connect(lambda: self.download_selected())
        btn_layout.addWidget(self.download_btn)

        layout.addLayout(btn_layout)
        self.setLayout(layout)

    def start_search(self):
        """开始搜索"""
        if self.search_thread and self.search_thread.isRunning():
            logger.info("搜索线程仍在运行，忽略重复搜索请求")
            return

        query = self.search_input.text().strip()
        if not query:
            QMessageBox.warning(self, "提示", "请输入搜索关键词")
            return

        platform = self.platform_combo.currentData()
        proxy = self.config.get_proxy_url() if self.config.is_proxy_enabled() else None

        # 禁用搜索按钮
        self.search_btn.setEnabled(False)
        self.search_btn.setText("搜索中...")
        self.result_list.clear()

        # 保存搜索历史
        self.db.add_search_record(platform.value, query)

        # 启动搜索线程
        self.search_thread = SearchThread(platform, query, proxy)
        self.search_thread.results_signal.connect(self.display_results)
        self.search_thread.error_signal.connect(self.search_error)
        self.search_thread.finished.connect(self.search_finished)
        self.search_thread.start()

    def display_results(self, results):
        """显示搜索结果"""
        self.result_list.clear()

        for video in results:
            item = QListWidgetItem()
            item.setData(Qt.ItemDataRole.UserRole, video)
            self.result_list.addItem(item)
            item_widget = SearchResultItemWidget(video, thumbnail_loader=self.thumbnail_loader)
            item.setSizeHint(item_widget.sizeHint())
            self.result_list.setItemWidget(item, item_widget)

        logger.info(f"显示 {len(results)} 个搜索结果")

    def search_error(self, error_msg):
        """搜索错误"""
        # 检查是否是 YouTube 的 412 错误
        if "412" in error_msg or "Precondition Failed" in error_msg:
            error_text = (
                "YouTube 搜索失败 (HTTP 412 错误)\n\n"
                "这是 YouTube 的反爬虫机制。解决方案：\n\n"
                '1. 使用代理：在"设置"标签页配置代理\n'
                '2. 直接下载：在浏览器搜索后复制链接到"下载"标签页\n'
                "3. 使用 Bilibili：切换到 Bilibili 平台搜索\n"
                "4. 等待一段时间后重试\n\n"
                "详细说明请查看 TROUBLESHOOTING.md 文件"
            )
            QMessageBox.warning(self, "搜索失败", error_text)
        else:
            QMessageBox.warning(self, "搜索失败", f"搜索出错: {error_msg}")

    def search_finished(self):
        """搜索完成"""
        self.search_btn.setEnabled(True)
        self.search_btn.setText("搜索")

    def download_selected(self, item: QListWidgetItem = None):
        """下载选中的视频"""
        current_item = item if item is not None else self.result_list.currentItem()
        if not current_item:
            QMessageBox.warning(self, "提示", "请选择一个视频")
            return

        video_info = current_item.data(Qt.ItemDataRole.UserRole)

        # 创建下载选项
        options = DownloadOptions(
            output_path=self.config.get_download_dir(),
            quality=self.config.get_default_quality(),
            download_subtitles=self.config.is_download_subtitles(),
            proxy=self.config.get_proxy_url() if self.config.is_proxy_enabled() else None
        )

        # 创建任务
        task = DownloadTask(video_info=video_info, options=options)

        # 添加到下载管理器
        self.download_manager.add_task(task)
        QMessageBox.information(self, "成功", f"已添加到下载队列: {video_info.title}")

    def _format_duration(self, seconds: int) -> str:
        """格式化时长"""
        if seconds == 0:
            return "N/A"

        # 确保转换为整数
        seconds = int(seconds)
        hours = seconds // 3600
        minutes = (seconds % 3600) // 60
        secs = seconds % 60

        if hours > 0:
            return f"{hours:02d}:{minutes:02d}:{secs:02d}"
        else:
            return f"{minutes:02d}:{secs:02d}"

    def _normalize_video_url(self, raw_value: str) -> str:
        """标准化视频链接，支持 ID 到可访问 URL 的转换。"""
        value = (raw_value or "").strip()
        if value.startswith(("http://", "https://")):
            return value

        if re.fullmatch(r"[0-9A-Za-z_-]{11}", value):
            return f"https://www.youtube.com/watch?v={value}"

        if re.fullmatch(r"BV[0-9A-Za-z]{10}", value, re.IGNORECASE):
            return f"https://www.bilibili.com/video/{value}"

        return value
