"""
主窗口，优先使用 Fluent 导航，失败时回退原生标签页。
"""
from __future__ import annotations

import os
import re
from urllib.parse import urlparse

from PyQt6.QtCore import QSettings, Qt, QTimer
from PyQt6.QtGui import QDragEnterEvent, QDropEvent, QGuiApplication
from PyQt6.QtWidgets import (
    QApplication,
    QLabel,
    QMainWindow,
    QMessageBox,
    QStatusBar,
    QTabWidget,
    QVBoxLayout,
    QWidget,
)

from src.core.download_task import DownloadTask, TaskStatus, VideoInfo
from src.core.platform_detector import PlatformDetector
from src.data.config_manager import ConfigManager
from src.ui.components.toast import ToastService
from src.ui.fluent_support import import_qfluentwidgets, setup_fluent_app
from src.ui.qt_manager_adapter import create_default_manager
from src.ui.styles import apply_theme
from src.ui.tabs import DownloadTab, HistoryTab, QueueTab, SearchTab, SettingsTab
from src.utils.logger import setup_logger
from src.utils.notifications import notify

logger = setup_logger("MainWindow")
_QFW = import_qfluentwidgets()
_FORCE_LEGACY_BASE = os.environ.get("QT_QPA_PLATFORM", "").lower() == "offscreen"
_FLUENT_BASE = getattr(_QFW, "MSFluentWindow", QMainWindow) if (_QFW and not _FORCE_LEGACY_BASE) else QMainWindow
_FLUENT_ICON = getattr(_QFW, "FluentIcon", None) if _QFW else None
_NAV_POSITION = getattr(_QFW, "NavigationItemPosition", None) if _QFW else None
_INFO_BADGE = getattr(_QFW, "InfoBadge", None) if _QFW else None
_INFO_BADGE_POSITION = getattr(_QFW, "InfoBadgePosition", None) if _QFW else None

_URL_PATTERN = re.compile(r"https?://[^\s]+", re.IGNORECASE)


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
        self.setMinimumSize(960, 640)
        self.resize(1280, 860)
        self.setAcceptDrops(True)

        self.download_manager = create_default_manager()
        self.download_manager.start()

        self.toast = ToastService(self, use_fluent=self.use_fluent)
        self._queue_nav_item = None
        self._queue_badge = None
        self._queue_tab_index = 2
        self._ui_settings = QSettings("Trae", "DownloaderUI")

        self.init_ui()
        self._setup_status_bar()
        self._connect_refresh_hooks()
        self._connect_notification_hooks()
        self._connect_system_theme_listener()
        self.apply_theme_mode(self.current_theme_mode)
        self._restore_window_state()

        logger.info("主窗口初始化完成")

    def init_ui(self):
        """初始化 UI。"""

        self.tabs = None
        self.search_tab = SearchTab(self.download_manager, toast=self.toast, main_window=self)
        self.download_tab = DownloadTab(self.download_manager, toast=self.toast, main_window=self)
        self.queue_tab = QueueTab(self.download_manager, toast=self.toast)
        self.history_tab = HistoryTab(self.download_manager, toast=self.toast)
        self.settings_tab = SettingsTab(toast=self.toast)
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

    def _setup_status_bar(self):
        if not hasattr(self, "setStatusBar"):
            return
        status = QStatusBar(self)
        self._status_active_label = QLabel("活跃任务：0")
        self._status_speed_label = QLabel("下载中：0")
        self._status_dir_label = QLabel("")
        status.addWidget(self._status_active_label)
        status.addPermanentWidget(self._status_speed_label)
        status.addPermanentWidget(self._status_dir_label)
        self.setStatusBar(status)

    def _connect_refresh_hooks(self):
        """连接任务状态变化与页面摘要刷新。"""

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

    def _connect_notification_hooks(self):
        for signal_name, slot in (
            ("task_completed", self._on_task_completed_notify),
            ("task_failed", self._on_task_failed_notify),
        ):
            signal = getattr(self.download_manager, signal_name, None)
            if signal is not None and hasattr(signal, "connect"):
                signal.connect(slot)

    def _connect_system_theme_listener(self):
        app = QGuiApplication.instance()
        if app is None or not hasattr(app, "styleHints"):
            return
        hints = app.styleHints()
        if hasattr(hints, "colorSchemeChanged"):
            hints.colorSchemeChanged.connect(self._on_system_color_scheme_changed)

    def _on_system_color_scheme_changed(self, *_args):
        if self.config.get_theme_mode() != "system":
            return
        self.apply_theme_mode("system")

    def _on_task_completed_notify(self, task_id: str):
        task = self.download_manager.get_task(task_id)
        if not task:
            return
        title = task.video_info.title or "下载完成"
        notify("下载完成", title)
        if not self.isActiveWindow():
            self.toast.show_success("下载完成", title)

    def _on_task_failed_notify(self, task_id: str, error: str):
        task = self.download_manager.get_task(task_id)
        title = task.video_info.title if task else "下载失败"
        notify("下载失败", f"{title}: {error[:120]}")
        if not self.isActiveWindow():
            self.toast.show_error("下载失败", error[:200])

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
        self._queue_nav_item = self.addSubInterface(self.queue_tab, queue_icon, "队列")
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
                self._queue_tab_index = self.tabs.addTab(self.queue_tab, "队列")
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
        self._queue_tab_index = self.tabs.addTab(self.queue_tab, "队列")
        self.tabs.addTab(self.history_tab, "历史")
        self.tabs.addTab(self.settings_tab, "设置")
        main_layout.addWidget(self.tabs)

    def switch_to_queue(self):
        """切换到队列页。"""

        if self.use_fluent and hasattr(self, "switchTo"):
            try:
                self.switchTo(self.queue_tab)
                return
            except Exception:
                pass
        if self.tabs is not None:
            self.tabs.setCurrentIndex(self._queue_tab_index)

    def switch_to_download(self):
        """切换到下载页。"""

        if self.use_fluent and hasattr(self, "switchTo"):
            try:
                self.switchTo(self.download_tab)
                return
            except Exception:
                pass
        if self.tabs is not None:
            self.tabs.setCurrentIndex(1)

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

        self._update_global_status()
        self._update_queue_badge()
        self._update_dock_badge()

    def _update_global_status(self):
        tasks = list(self.download_manager.get_all_tasks().values())
        active = sum(
            1
            for task in tasks
            if task.status in {TaskStatus.PENDING, TaskStatus.DOWNLOADING, TaskStatus.PAUSED}
        )
        downloading = sum(1 for task in tasks if task.status == TaskStatus.DOWNLOADING)

        if hasattr(self, "_status_active_label"):
            self._status_active_label.setText(f"活跃任务：{active}")
            self._status_speed_label.setText(f"下载中：{downloading}")
            short_dir = self._short_path(self.config.get_download_dir())
            self._status_dir_label.setText(f"目录：{short_dir}")

    def _update_queue_badge(self):
        tasks = list(self.download_manager.get_all_tasks().values())
        active = sum(
            1
            for task in tasks
            if task.status in {TaskStatus.PENDING, TaskStatus.DOWNLOADING, TaskStatus.PAUSED}
        )

        if self.use_fluent and self._queue_nav_item is not None and _INFO_BADGE is not None:
            try:
                if active <= 0:
                    if self._queue_badge is not None:
                        self._queue_badge.deleteLater()
                        self._queue_badge = None
                else:
                    position = getattr(_INFO_BADGE_POSITION, "TOP_RIGHT", None)
                    text = str(active) if active < 100 else "99+"
                    if self._queue_badge is None:
                        kwargs = {
                            "text": text,
                            "parent": self._queue_nav_item,
                            "target": self._queue_nav_item,
                        }
                        if position is not None:
                            kwargs["position"] = position
                        self._queue_badge = _INFO_BADGE.make(**kwargs)
                    else:
                        self._queue_badge.setText(text)
            except Exception as exc:
                logger.debug(f"更新队列徽标失败: {exc}")

        if self.tabs is not None:
            label = f"队列 ({active})" if active > 0 else "队列"
            self.tabs.setTabText(self._queue_tab_index, label)

    def _update_dock_badge(self):
        tasks = list(self.download_manager.get_all_tasks().values())
        active = sum(
            1
            for task in tasks
            if task.status in {TaskStatus.PENDING, TaskStatus.DOWNLOADING, TaskStatus.PAUSED}
        )
        app = QGuiApplication.instance()
        if app is None:
            return
        setter = getattr(app, "setBadgeNumber", None)
        if callable(setter):
            try:
                setter(active)
            except Exception:
                pass

    def _short_path(self, path: str) -> str:
        if not path:
            return "-"
        normalized = path.rstrip("/")
        if len(normalized) <= 34:
            return normalized
        return f"{normalized[:14]}…{normalized[-16:]}"

    def _restore_window_state(self):
        geometry = self._ui_settings.value("mainwindow/geometry")
        if geometry is not None:
            try:
                self.restoreGeometry(geometry)
            except Exception:
                pass

    def _save_window_state(self):
        self._ui_settings.setValue("mainwindow/geometry", self.saveGeometry())

    def apply_theme_mode(self, theme_mode: str, *_args):
        """应用新的主题模式。"""

        self.current_theme_mode = theme_mode or self.current_theme_mode
        app = QApplication.instance()
        if app is None:
            return

        setup_fluent_app(app, self.current_theme_mode)
        apply_theme(app, self.current_theme_mode, fluent_enabled=self.use_fluent)
        self.refresh_page_summaries()

    def dragEnterEvent(self, event: QDragEnterEvent):
        if event.mimeData() and event.mimeData().hasText():
            event.acceptProposedAction()
        else:
            event.ignore()

    def dropEvent(self, event: QDropEvent):
        if not event.mimeData() or not event.mimeData().hasText():
            event.ignore()
            return

        text = event.mimeData().text()
        urls = self._extract_urls_from_text(text)
        if not urls:
            event.ignore()
            return

        self._add_urls_to_queue(urls)
        event.acceptProposedAction()

    def _extract_urls_from_text(self, text: str) -> list[str]:
        found = _URL_PATTERN.findall(text or "")
        cleaned = []
        for url in found:
            url = url.strip().rstrip(".,;)")
            if url and url not in cleaned:
                cleaned.append(url)
        return cleaned

    def _add_urls_to_queue(self, urls: list[str]):
        options = self.config.build_download_options()
        for url in urls:
            platform = PlatformDetector.detect(url)
            placeholder = self._url_placeholder_title(url)
            video_info = VideoInfo(url=url, title=placeholder, platform=platform)
            task = DownloadTask(video_info=video_info, options=options)
            self.download_manager.add_task(task)

        count = len(urls)
        self.toast.show_success(
            f"已加入 {count} 个任务",
            "链接已添加到下载队列",
            action_label="查看队列",
            action_cb=self.switch_to_queue,
        )

    @staticmethod
    def _url_placeholder_title(url: str) -> str:
        try:
            parsed = urlparse(url)
            host = parsed.netloc or "未知来源"
            path = (parsed.path or "").strip("/")
            if path:
                segment = path.split("/")[-1][:40]
                return f"{host}/{segment}"
            return host
        except Exception:
            return url[:60]

    def closeEvent(self, event):
        """关闭事件。"""

        tasks = list(self.download_manager.get_all_tasks().values())
        active = [
            task
            for task in tasks
            if task.status in {TaskStatus.PENDING, TaskStatus.DOWNLOADING, TaskStatus.PAUSED}
        ]
        if active:
            reply = QMessageBox.question(
                self,
                "确认退出",
                f"仍有 {len(active)} 个任务未完成，确定要退出吗？",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
                QMessageBox.StandardButton.No,
            )
            if reply != QMessageBox.StandardButton.Yes:
                event.ignore()
                return

        self._save_window_state()

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
