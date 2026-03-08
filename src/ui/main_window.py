"""
主窗口，优先使用 Fluent 导航，失败时回退原生标签页。
"""
from PyQt6.QtWidgets import QMainWindow, QWidget, QVBoxLayout, QTabWidget
from src.core.download_manager import DownloadManager
from src.ui.tabs import DownloadTab, QueueTab, HistoryTab, SettingsTab, SearchTab
from src.ui.fluent_support import import_qfluentwidgets
from src.utils.logger import setup_logger

logger = setup_logger("MainWindow")
_QFW = import_qfluentwidgets()
_FLUENT_BASE = getattr(_QFW, "MSFluentWindow", QMainWindow) if _QFW else QMainWindow
_FLUENT_ICON = getattr(_QFW, "FluentIcon", None) if _QFW else None


class MainWindow(_FLUENT_BASE):
    """主窗口"""

    def __init__(self, use_fluent: bool = False):
        super().__init__()
        self.use_fluent = bool(
            use_fluent and _QFW and _FLUENT_ICON is not None and hasattr(self, "addSubInterface")
        )
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
        self.tabs = None
        self.search_tab = SearchTab(self.download_manager)
        self.download_tab = DownloadTab(self.download_manager)
        self.queue_tab = QueueTab(self.download_manager)
        self.history_tab = HistoryTab(self.download_manager)
        self.settings_tab = SettingsTab()
        self._ensure_interface_object_names()

        if self.use_fluent:
            try:
                self._init_fluent_navigation()
                return
            except Exception as exc:
                logger.warning(f"Fluent 导航初始化失败，回退原生标签页: {exc}")

        self._init_legacy_tabs()

    def _init_fluent_navigation(self):
        """使用 Fluent 导航承载页面。"""
        icon_availability = {
            "SEARCH": hasattr(_FLUENT_ICON, "SEARCH"),
            "DOWNLOAD": hasattr(_FLUENT_ICON, "DOWNLOAD"),
            "LIST": hasattr(_FLUENT_ICON, "LIST"),
            "HISTORY": hasattr(_FLUENT_ICON, "HISTORY"),
            "SETTING": hasattr(_FLUENT_ICON, "SETTING"),
        }
        search_icon = self._resolve_fluent_icon("SEARCH")
        download_icon = self._resolve_fluent_icon("DOWNLOAD", "DOWNLOAD", "SEARCH")
        queue_icon = self._resolve_fluent_icon("LIST", "ALBUM", "SEARCH")
        history_icon = self._resolve_fluent_icon("HISTORY", "SEARCH")
        settings_icon = self._resolve_fluent_icon("SETTING", "SETTING", "SEARCH")

        # 在真正 addSubInterface 前先完成全部图标解析，避免中途失败导致半初始化状态。
        self.addSubInterface(self.search_tab, search_icon, "搜索")
        self.addSubInterface(self.download_tab, download_icon, "下载")
        self.addSubInterface(self.queue_tab, queue_icon, "队列")
        self.addSubInterface(self.history_tab, history_icon, "历史")
        self.addSubInterface(self.settings_tab, settings_icon, "设置")

    def _ensure_interface_object_names(self):
        """Fluent 导航要求每个子界面都具有非空 objectName。"""
        tab_pairs = [
            (self.search_tab, "searchTabInterface"),
            (self.download_tab, "downloadTabInterface"),
            (self.queue_tab, "queueTabInterface"),
            (self.history_tab, "historyTabInterface"),
            (self.settings_tab, "settingsTabInterface"),
        ]
        for widget, default_name in tab_pairs:
            if widget.objectName():
                continue
            widget.setObjectName(default_name)

    def _resolve_fluent_icon(self, *candidates):
        """从候选图标名中选择第一个可用值；至少保证返回一个有效图标对象。"""
        for name in candidates:
            icon = getattr(_FLUENT_ICON, name, None)
            if icon is not None:
                return icon
        # 理论上不会到这里：SEARCH 在前置 use_fluent 判定中已经存在。
        return getattr(_FLUENT_ICON, "SEARCH")

    def _init_legacy_tabs(self):
        """回退路径：使用原生 QTabWidget。"""
        if not hasattr(self, "setCentralWidget"):
            # MSFluentWindow 不提供 QMainWindow 的 setCentralWidget 时，
            # 退化为在 Fluent 导航中挂载一个原生标签页容器，避免直接崩溃。
            if hasattr(self, "addSubInterface"):
                fallback_page = QWidget()
                fallback_page.setObjectName("legacyTabsFallbackPage")
                fallback_layout = QVBoxLayout()
                fallback_layout.setContentsMargins(10, 10, 10, 10)
                fallback_page.setLayout(fallback_layout)

                self.tabs = QTabWidget()
                fallback_layout.addWidget(self.tabs)
                self.tabs.addTab(self.search_tab, "🔍 搜索")
                self.tabs.addTab(self.download_tab, "📥 下载")
                self.tabs.addTab(self.queue_tab, "📋 队列")
                self.tabs.addTab(self.history_tab, "📚 历史")
                self.tabs.addTab(self.settings_tab, "⚙️ 设置")
                self.addSubInterface(fallback_page, _FLUENT_ICON.SEARCH, "标签页")
                return
            raise AttributeError("当前窗口基类不支持 setCentralWidget，且无 addSubInterface 可用于回退")

        central_widget = QWidget()
        self.setCentralWidget(central_widget)

        main_layout = QVBoxLayout()
        main_layout.setContentsMargins(10, 10, 10, 10)
        central_widget.setLayout(main_layout)

        self.tabs = QTabWidget()
        main_layout.addWidget(self.tabs)

        self.tabs.addTab(self.search_tab, "🔍 搜索")
        self.tabs.addTab(self.download_tab, "📥 下载")
        self.tabs.addTab(self.queue_tab, "📋 队列")
        self.tabs.addTab(self.history_tab, "📚 历史")
        self.tabs.addTab(self.settings_tab, "⚙️ 设置")

    def closeEvent(self, event):
        """关闭事件"""
        self.download_manager.stop()
        logger.info("应用程序关闭")
        event.accept()
