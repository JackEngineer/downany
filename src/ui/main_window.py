"""
主窗口，使用标签页布局。
"""
from PyQt6.QtWidgets import QMainWindow, QWidget, QVBoxLayout, QTabWidget
from PyQt6.QtCore import Qt
from src.core.download_manager import DownloadManager
from src.ui.tabs import DownloadTab, QueueTab, HistoryTab, SettingsTab, SearchTab
from src.ui.styles import apply_theme
from src.utils.logger import setup_logger

logger = setup_logger("MainWindow")


class MainWindow(QMainWindow):
    """主窗口"""

    def __init__(self):
        super().__init__()
        self.setWindowTitle("Trae 视频下载器")
        self.resize(1000, 700)

        # 初始化下载管理器
        self.download_manager = DownloadManager()
        self.download_manager.start()

        # 初始化 UI
        self.init_ui()

        logger.info("主窗口初始化完成")

    def init_ui(self):
        """初始化 UI"""
        # 主 Widget
        central_widget = QWidget()
        self.setCentralWidget(central_widget)

        # 主布局
        main_layout = QVBoxLayout()
        main_layout.setContentsMargins(10, 10, 10, 10)
        central_widget.setLayout(main_layout)

        # 标签页控件
        self.tabs = QTabWidget()
        main_layout.addWidget(self.tabs)

        # 创建各个标签页
        self.search_tab = SearchTab(self.download_manager)
        self.tabs.addTab(self.search_tab, "🔍 搜索")

        self.download_tab = DownloadTab(self.download_manager)
        self.tabs.addTab(self.download_tab, "📥 下载")

        self.queue_tab = QueueTab(self.download_manager)
        self.tabs.addTab(self.queue_tab, "📋 队列")

        self.history_tab = HistoryTab(self.download_manager)
        self.tabs.addTab(self.history_tab, "📚 历史")

        self.settings_tab = SettingsTab()
        self.tabs.addTab(self.settings_tab, "⚙️ 设置")

    def closeEvent(self, event):
        """关闭事件"""
        # 停止下载管理器
        self.download_manager.stop()
        logger.info("应用程序关闭")
        event.accept()
