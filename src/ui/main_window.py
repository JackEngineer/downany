"""
主窗口，优先使用 Fluent 导航，失败时回退原生标签页。
"""
from __future__ import annotations

import os

from PyQt6.QtWidgets import QMainWindow, QWidget, QVBoxLayout, QTabWidget, QApplication

from src.core.download_manager import DownloadManager
from src.data.config_manager import ConfigManager
from src.ui.fluent_support import import_qfluentwidgets, setup_fluent_app
from src.ui.styles import apply_theme
from src.ui.tabs import DownloadTab, HistoryTab, QueueTab, SearchTab, SettingsTab
from src.utils.logger import setup_logger

logger = setup_logger("MainWindow")
_QFW = import_qfluentwidgets()
_FORCE_LEGACY_BASE = os.environ.get("QT_QPA_PLATFORM", "").lower() == "offscreen"
_FLUENT_BASE = getattr(_QFW, "MSFluentWindow", QMainWindow) if (_QFW and not _FORCE_LEGACY_BASE) else QMainWindow
_FLUENT_ICON = getattr(_QFW, "FluentIcon", None) if _QFW else None
_NAV_POSITION = getattr(_QFW, "NavigationItemPosition", None) if _QFW else None


class MainWindow(_FLUENT_BASE):
    """主窗口。"""

    def __init__(self, use_fluent: bool = False):
        super().__init__()
        self.config = ConfigManager()
        self.current_theme_mode = self.config.get_theme_mode()
        self.use_fluent = bool(
            use_fluent and _QFW and _FLUENT_ICON is not None and hasattr(self, "addSubInterface")
        )
        self.setWindowTitle("Trae 视频下载器")
        self.setMinimumSize(1120, 760)
        self.resize(1280, 860)

        self.download_manager = DownloadManager()
        self.download_manager.start()

        self.init_ui()
        self._connect_refresh_hooks()
        self.apply_theme_mode(self.current_theme_mode)

        logger.info("主窗口初始化完成")

    def init_ui(self):
        """初始化 UI。"""

        self.tabs = None
        self.search_tab = SearchTab(self.download_manager)
        self.download_tab = DownloadTab(self.download_manager)
        self.queue_tab = QueueTab(self.download_manager)
        self.history_tab = HistoryTab(self.download_manager)
        self.settings_tab = SettingsTab()
        self._connect_tab_signal(self.settings_tab, "theme_changed", self.apply_theme_mode)
        self._connect_tab_signal(self.settings_tab, "settings_saved", self.refresh_page_summaries)
        self._ensure_interface_object_names()

        if self.use_fluent:
            try:
                self._init_fluent_navigation()
                return
            except Exception as exc:
                logger.warning(f"Fluent 导航初始化失败，回退原生标签页: {exc}")
                self.use_fluent = False

        self._init_legacy_tabs()

    def _connect_refresh_hooks(self):
        """连接任务状态变化与页面摘要刷新。"""

        from PyQt6.QtCore import QTimer

        self._summary_throttle = QTimer(self)
        self._summary_throttle.setSingleShot(True)
        self._summary_throttle.setInterval(400)
        self._summary_throttle.timeout.connect(self.refresh_page_summaries)

        for signal_name in [
            "task_added",
            "task_started",
            "task_completed",
            "task_failed",
            "task_paused",
            "task_cancelled",
        ]:
            signal = getattr(self.download_manager, signal_name, None)
            if signal is not None and hasattr(signal, "connect"):
                signal.connect(self.refresh_page_summaries)

        progress = getattr(self.download_manager, "task_progress", None)
        if progress is not None and hasattr(progress, "connect"):
            progress.connect(self._schedule_summary_refresh)

    def _schedule_summary_refresh(self, *_args):
        if not self._summary_throttle.isActive():
            self._summary_throttle.start()

    def _connect_tab_signal(self, tab, signal_name: str, slot):
        """安全连接标签页上的可选信号。"""

        signal = getattr(tab, signal_name, None)
        if signal is not None and hasattr(signal, "connect"):
            signal.connect(slot)

    def _init_fluent_navigation(self):
        """使用 Fluent 导航承载页面。"""

        search_icon = self._resolve_fluent_icon("SEARCH")
        download_icon = self._resolve_fluent_icon("DOWNLOAD", "SEARCH")
        queue_icon = self._resolve_fluent_icon("LIST", "ALBUM", "SEARCH")
        history_icon = self._resolve_fluent_icon("HISTORY", "SEARCH")
        settings_icon = self._resolve_fluent_icon("SETTING", "SEARCH")

        self.addSubInterface(self.search_tab, search_icon, "搜索")
        self.addSubInterface(self.download_tab, download_icon, "下载")
        self.addSubInterface(self.queue_tab, queue_icon, "队列")
        self.addSubInterface(self.history_tab, history_icon, "历史")
        settings_position = getattr(_NAV_POSITION, "BOTTOM", None)
        if settings_position is not None:
            self.addSubInterface(self.settings_tab, settings_icon, "设置", position=settings_position)
        else:
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
        """从候选图标名中选择第一个可用值。"""

        for name in candidates:
            icon = getattr(_FLUENT_ICON, name, None)
            if icon is not None:
                return icon
        return getattr(_FLUENT_ICON, "SEARCH")

    def _init_legacy_tabs(self):
        """回退路径：使用原生 QTabWidget。"""

        if not hasattr(self, "setCentralWidget"):
            if hasattr(self, "addSubInterface"):
                fallback_page = QWidget()
                fallback_page.setObjectName("legacyTabsFallbackPage")
                fallback_layout = QVBoxLayout()
                fallback_layout.setContentsMargins(12, 12, 12, 12)
                fallback_layout.setSpacing(12)
                fallback_page.setLayout(fallback_layout)

                self.tabs = QTabWidget()
                self.tabs.setDocumentMode(True)
                self.tabs.addTab(self.search_tab, "搜索")
                self.tabs.addTab(self.download_tab, "下载")
                self.tabs.addTab(self.queue_tab, "队列")
                self.tabs.addTab(self.history_tab, "历史")
                self.tabs.addTab(self.settings_tab, "设置")
                fallback_layout.addWidget(self.tabs)
                self.addSubInterface(fallback_page, _FLUENT_ICON.SEARCH, "标签页")
                return
            raise AttributeError("当前窗口基类不支持 setCentralWidget，且无 addSubInterface 可用于回退")

        central_widget = QWidget()
        self.setCentralWidget(central_widget)

        main_layout = QVBoxLayout()
        main_layout.setContentsMargins(12, 12, 12, 12)
        main_layout.setSpacing(12)
        central_widget.setLayout(main_layout)

        self.tabs = QTabWidget()
        self.tabs.setDocumentMode(True)
        self.tabs.addTab(self.search_tab, "搜索")
        self.tabs.addTab(self.download_tab, "下载")
        self.tabs.addTab(self.queue_tab, "队列")
        self.tabs.addTab(self.history_tab, "历史")
        self.tabs.addTab(self.settings_tab, "设置")
        main_layout.addWidget(self.tabs)

    def refresh_page_summaries(self, *_args):
        """刷新所有页面的摘要信息。"""

        for page in (
            self.search_tab,
            self.download_tab,
            self.queue_tab,
            self.history_tab,
            self.settings_tab,
        ):
            refresh = getattr(page, "refresh_overview", None)
            if callable(refresh):
                refresh()

    def apply_theme_mode(self, theme_mode: str, *_args):
        """应用新的主题模式。"""

        self.current_theme_mode = theme_mode or self.current_theme_mode
        app = QApplication.instance()
        if app is None:
            return

        setup_fluent_app(app, self.current_theme_mode)
        apply_theme(app, self.current_theme_mode)
        self.refresh_page_summaries()

    def closeEvent(self, event):
        """关闭事件。"""

        for page in (
            getattr(self, "search_tab", None),
            getattr(self, "download_tab", None),
            getattr(self, "queue_tab", None),
            getattr(self, "history_tab", None),
            getattr(self, "settings_tab", None),
        ):
            if page is None:
                continue
            shutdown = getattr(page, "shutdown", None)
            if callable(shutdown):
                try:
                    shutdown()
                except Exception as exc:
                    logger.warning(f"页面清理失败: {exc}")

        if hasattr(self, "_summary_throttle"):
            self._summary_throttle.stop()

        self.download_manager.stop()
        logger.info("应用程序关闭")
        event.accept()
