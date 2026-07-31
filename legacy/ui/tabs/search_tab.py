"""
搜索标签页，支持在平台内搜索视频。
"""
from __future__ import annotations

import re

from PyQt6.QtCore import QEvent, QSettings, QTimer, Qt, QThread, pyqtSignal, QUrl
from PyQt6.QtGui import QDesktopServices, QKeyEvent, QPixmap
from PyQt6.QtWidgets import (
    QApplication,
    QCompleter,
    QHBoxLayout,
    QLineEdit,
    QComboBox,
    QLabel,
    QListWidget,
    QListWidgetItem,
    QMessageBox,
    QSplitter,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from src.core.download_task import DownloadTask, Platform, VideoInfo
from src.core.preview_url import normalize_video_url
from src.core.search_engine import SearchEngine
from src.data.config_manager import ConfigManager
from src.data.database import HistoryDB
from src.ui.components import SearchResultItemWidget, ThumbnailLoader, VideoPreviewWidget
from src.ui.components.chrome import BodyLabel, PageHeader, SectionCard, StatusBadge
from src.ui.components.toast import ToastService
from src.ui.fluent_support import get_fluent_widget
from src.ui.qt_manager_adapter import QtDownloadManager
from src.utils.logger import setup_logger

logger = setup_logger("SearchTab")


class SearchThread(QThread):
    """搜索线程。"""

    results_signal = pyqtSignal(int, list)
    error_signal = pyqtSignal(int, str)

    def __init__(self, request_id: int, platform: Platform, query: str, max_results: int = 20, proxy: str = None):
        super().__init__()
        self.request_id = request_id
        self.platform = platform
        self.query = query
        self.max_results = max_results
        self.proxy = proxy

    def run(self):
        if self.isInterruptionRequested():
            return
        try:
            results = SearchEngine.search(
                self.platform, self.query, max_results=self.max_results, proxy=self.proxy
            )
            if self.isInterruptionRequested():
                return
            self.results_signal.emit(self.request_id, results)
        except Exception as e:
            if not self.isInterruptionRequested():
                self.error_signal.emit(self.request_id, str(e))


class SearchTab(QWidget):
    """搜索标签页。"""

    def __init__(
        self,
        download_manager: QtDownloadManager,
        thumbnail_loader: ThumbnailLoader = None,
        toast: ToastService | None = None,
        main_window=None,
    ):
        super().__init__()
        self.download_manager = download_manager
        self.main_window = main_window
        self.config = ConfigManager()
        self.db = HistoryDB()
        self.toast = toast
        self.search_thread = None
        self.thumbnail_loader = thumbnail_loader or ThumbnailLoader()
        self._detail_placeholder_pixmap = QPixmap()
        self._preview_fallback_triggered = False
        self._search_result_count = 0
        self._current_platform = Platform.YOUTUBE
        self._selected_video_info: VideoInfo | None = None
        self._thumbnail_requests_enabled = False
        self._thumbnail_load_pending = False
        self._thumbnail_load_scheduled = False
        self._search_request_id = 0
        self._active_search_request_id = 0
        self._max_results = 20
        self._last_query = ""
        self._previous_list_item: QListWidgetItem | None = None
        self._ui_settings = QSettings("Trae", "DownloaderUI")
        self.init_ui()
        self._setup_search_completer()
        self.thumbnail_loader.thumbnail_loaded.connect(self._on_detail_thumbnail_loaded)
        self.thumbnail_loader.thumbnail_failed.connect(self._on_detail_thumbnail_failed)
        self.refresh_overview()

    def init_ui(self):
        line_edit_cls = get_fluent_widget("LineEdit") or QLineEdit
        push_button_cls = get_fluent_widget("PushButton") or QPushButton
        primary_button_cls = get_fluent_widget("PrimaryPushButton") or push_button_cls
        combo_box_cls = get_fluent_widget("ComboBox") or QComboBox

        layout = QVBoxLayout()
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(18)

        self.header = PageHeader(
            "搜索中心",
            "在支持的平台内搜索视频结果，封面懒加载，支持直接预览与下载。",
            metrics=[
                ("结果", "0", "当前搜索命中数量"),
                ("平台", "YouTube", "当前搜索来源"),
                ("预览", "待就绪", "应用内预览状态"),
            ],
        )
        layout.addWidget(self.header)

        search_card = SectionCard("搜索工具", "选择平台后输入关键词即可开始搜索。")
        search_layout = search_card.body_layout

        search_row = QHBoxLayout()
        search_row.setSpacing(12)

        search_row.addWidget(QLabel("平台"))
        self.platform_combo = combo_box_cls()
        # 只把平台枚举存进 userData，避免 Fluent ComboBox 把它当成图标对象处理。
        self.platform_combo.addItem("YouTube", userData=Platform.YOUTUBE)
        self.platform_combo.addItem("Bilibili", userData=Platform.BILIBILI)
        self.platform_combo.currentIndexChanged.connect(self._on_platform_changed)
        search_row.addWidget(self.platform_combo)

        self.search_input = line_edit_cls()
        self.search_input.setPlaceholderText("输入关键词")
        self.search_input.setToolTip("支持搜索历史下拉与回车搜索")
        self.search_input.returnPressed.connect(self.start_search)
        search_row.addWidget(self.search_input, 1)

        self.search_btn = primary_button_cls("搜索")
        self.search_btn.setObjectName("primaryActionButton")
        self.search_btn.setToolTip("开始搜索或取消进行中的搜索")
        self.search_btn.clicked.connect(self._on_search_button_clicked)
        search_row.addWidget(self.search_btn)

        self.load_more_btn = push_button_cls("加载更多")
        self.load_more_btn.setObjectName("ghostActionButton")
        self.load_more_btn.setToolTip("在当前关键词下加载更多结果")
        self.load_more_btn.clicked.connect(self.load_more_results)
        self.load_more_btn.setEnabled(False)
        search_row.addWidget(self.load_more_btn)
        search_layout.addLayout(search_row)

        search_hint = BodyLabel("搜索结果会按列表懒加载封面，选中后右侧详情会同步更新。")
        search_hint.setObjectName("PageHint")
        search_layout.addWidget(search_hint)
        layout.addWidget(search_card)

        splitter = QSplitter(Qt.Orientation.Horizontal)
        splitter.setChildrenCollapsible(False)

        results_card = SectionCard("结果列表", "按封面和元信息浏览结果，双击可直接加入队列。")
        results_layout = results_card.body_layout

        self.result_list = QListWidget()
        self.result_list.setObjectName("SearchResultList")
        self.result_list.setToolTip("双击或按回车将选中项加入队列")
        self.result_list.itemDoubleClicked.connect(self.download_selected)
        self.result_list.currentItemChanged.connect(self._on_selection_changed)
        self.result_list.verticalScrollBar().valueChanged.connect(self._schedule_visible_thumbnail_load)
        self.result_list.horizontalScrollBar().valueChanged.connect(self._schedule_visible_thumbnail_load)
        self.result_list.viewport().installEventFilter(self)
        self.result_list.installEventFilter(self)
        self.result_list.setSpacing(10)
        self.results_state_label = QLabel("输入关键词后，结果会显示在这里。")
        self.results_state_label.setObjectName("EmptyStateLabel")
        self.results_state_label.setWordWrap(True)
        results_layout.addWidget(self.results_state_label)
        results_layout.addWidget(self.result_list)

        results_footer = BodyLabel("封面按可视区域懒加载，列表滚动更快。")
        results_footer.setObjectName("PageHint")
        results_layout.addWidget(results_footer)

        detail_card = SectionCard("详情与预览", "查看选中内容的元信息、封面和预览。")
        detail_layout = detail_card.body_layout

        self.detail_title_label = QLabel("请选择一个搜索结果")
        self.detail_title_label.setObjectName("SectionTitle")
        self.detail_title_label.setWordWrap(True)
        detail_layout.addWidget(self.detail_title_label)

        badge_row = QHBoxLayout()
        badge_row.setSpacing(8)
        self.platform_badge = StatusBadge("平台 -", "neutral")
        self.duration_badge = StatusBadge("时长 -", "neutral")
        self.preview_state_badge = StatusBadge("预览待选择", "neutral")
        badge_row.addWidget(self.platform_badge)
        badge_row.addWidget(self.duration_badge)
        badge_row.addWidget(self.preview_state_badge)
        badge_row.addStretch()
        detail_layout.addLayout(badge_row)

        self.detail_meta_label = QLabel("上传者：-")
        self.detail_meta_label.setObjectName("SectionSubtitle")
        self.detail_meta_label.setWordWrap(True)
        detail_layout.addWidget(self.detail_meta_label)

        self.detail_url_label = QLabel("链接：-")
        self.detail_url_label.setObjectName("PageHint")
        self.detail_url_label.setWordWrap(True)
        self.detail_url_label.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        detail_layout.addWidget(self.detail_url_label)

        self.detail_thumbnail_label = QLabel()
        self.detail_thumbnail_label.setObjectName("searchDetailThumbnail")
        self.detail_thumbnail_label.setMinimumSize(320, 180)
        self.detail_thumbnail_label.setMaximumHeight(180)
        self.detail_thumbnail_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        detail_layout.addWidget(self.detail_thumbnail_label)

        self.detail_thumbnail_status_label = QLabel("封面待加载")
        self.detail_thumbnail_status_label.setObjectName("PageHint")
        detail_layout.addWidget(self.detail_thumbnail_status_label)

        self.preview_widget = VideoPreviewWidget()
        self.preview_widget.setObjectName("videoPreviewWidget")
        self.preview_widget.setVisible(False)
        self.preview_widget.playback_failed.connect(self._on_preview_failed)
        detail_layout.addWidget(self.preview_widget)

        action_row = QHBoxLayout()
        action_row.setSpacing(10)
        self.copy_link_btn = push_button_cls("复制链接")
        self.copy_link_btn.setObjectName("ghostActionButton")
        self.copy_link_btn.clicked.connect(self.copy_selected_link)
        action_row.addWidget(self.copy_link_btn)

        self.open_link_btn = push_button_cls("打开链接")
        self.open_link_btn.setObjectName("ghostActionButton")
        self.open_link_btn.clicked.connect(self.open_selected_link)
        action_row.addWidget(self.open_link_btn)

        self.download_btn = primary_button_cls("下载选中")
        self.download_btn.setObjectName("primaryActionButton")
        self.download_btn.clicked.connect(lambda: self.download_selected())
        action_row.addWidget(self.download_btn)

        self.preview_btn = push_button_cls("直接预览")
        self.preview_btn.setObjectName("ghostActionButton")
        self.preview_btn.clicked.connect(self.preview_selected_video)
        action_row.addWidget(self.preview_btn)
        action_row.addStretch()
        detail_layout.addLayout(action_row)

        self.preview_status_label = QLabel("预览入口已就绪，待选择结果后可以直接播放。")
        self.preview_status_label.setObjectName("PageHint")
        detail_layout.addWidget(self.preview_status_label)
        detail_layout.addStretch()

        splitter.addWidget(results_card)
        splitter.addWidget(detail_card)
        splitter.setStretchFactor(0, 3)
        splitter.setStretchFactor(1, 2)
        self._splitter = splitter
        layout.addWidget(splitter, 1)

        splitter_state = self._ui_settings.value("searchTab/splitterState")
        if splitter_state is not None:
            try:
                splitter.restoreState(splitter_state)
            except Exception:
                pass

        self.setLayout(layout)
        self._reset_detail_panel()

    def _setup_search_completer(self):
        getter = getattr(self.db, "get_recent_searches", None)
        recent = getter(limit=15) if callable(getter) else []
        queries = []
        for record in recent:
            text = (record.query or "").strip()
            if text and text not in queries:
                queries.append(text)
        completer = QCompleter(queries, self)
        completer.setCaseSensitivity(Qt.CaseSensitivity.CaseInsensitive)
        completer.setFilterMode(Qt.MatchFlag.MatchContains)
        self.search_input.setCompleter(completer)

    def _on_search_button_clicked(self):
        if self.search_thread and self.search_thread.isRunning():
            self.cancel_search()
            return
        self.start_search()

    def cancel_search(self):
        if self.search_thread and self.search_thread.isRunning():
            self.search_thread.requestInterruption()
            self.search_thread.quit()
        self.search_finished()
        self._set_results_state("搜索已取消。")

    def load_more_results(self):
        if not self._last_query:
            return
        self._max_results += 20
        self.start_search(append=True)

    def shutdown(self):
        splitter_state = getattr(self, "_splitter", None)
        if splitter_state is not None:
            self._ui_settings.setValue("searchTab/splitterState", splitter_state.saveState())

        for index in range(self.result_list.count()):
            item = self.result_list.item(index)
            if not item:
                continue
            widget = self.result_list.itemWidget(item)
            if widget and hasattr(widget, "shutdown"):
                widget.shutdown()

        if self.search_thread and self.search_thread.isRunning():
            self.search_thread.requestInterruption()
            self.search_thread.quit()
            self.search_thread.wait(2000)
        if hasattr(self, "preview_widget"):
            self.preview_widget.shutdown()
        if hasattr(self, "thumbnail_loader"):
            self.thumbnail_loader.shutdown()

    def _on_platform_changed(self, *_args):
        self._current_platform = self._resolve_selected_platform() or Platform.YOUTUBE
        self.refresh_overview()

    def refresh_overview(self):
        """刷新顶部摘要。"""

        platform_label = self.platform_combo.currentText() if hasattr(self.platform_combo, "currentText") else "YouTube"
        preview_state = self.preview_state_badge.text() if hasattr(self.preview_state_badge, "text") else "待就绪"
        self.header.set_metrics(
            [
                ("结果", str(self._search_result_count), "当前搜索命中数量"),
                ("平台", platform_label, "当前搜索来源"),
                ("预览", preview_state, "应用内预览状态"),
            ]
        )

    def start_search(self, append: bool = False):
        """开始搜索。"""

        if self.search_thread and self.search_thread.isRunning() and not append:
            logger.info("搜索线程仍在运行，忽略重复搜索请求")
            return

        query = self.search_input.text().strip()
        if not query:
            QMessageBox.warning(self, "需要关键词", "请先输入搜索关键词")
            return

        platform = self._resolve_selected_platform()
        if platform is None:
            QMessageBox.warning(self, "平台不可用", "无法识别当前平台，请重新选择后重试")
            return
        proxy = self.config.get_proxy_for_download()

        if not append:
            self._max_results = 20
            self.result_list.clear()
            self._search_result_count = 0
            self._reset_detail_panel()

        self._last_query = query
        self._search_request_id += 1
        self._active_search_request_id = self._search_request_id

        self.search_btn.setText("取消")
        self._set_results_state("正在搜索，请稍候…")

        self.db.add_search_record(platform.value, query)
        self._setup_search_completer()

        self.search_thread = SearchThread(
            self._active_search_request_id, platform, query, self._max_results, proxy
        )
        self.search_thread.results_signal.connect(self.display_results)
        self.search_thread.error_signal.connect(self.search_error)
        self.search_thread.finished.connect(self.search_finished)
        self.search_thread.start()

    def _resolve_selected_platform(self):
        """解析当前平台。"""

        platform = self.platform_combo.currentData() if hasattr(self.platform_combo, "currentData") else None
        if platform is not None:
            return platform

        text = self.platform_combo.currentText().strip() if hasattr(self.platform_combo, "currentText") else ""
        text_map = {
            "YouTube": Platform.YOUTUBE,
            "Bilibili": Platform.BILIBILI,
        }
        return text_map.get(text)

    def display_results(self, request_id: int, results):
        """显示搜索结果。"""

        if request_id != self._active_search_request_id:
            return

        existing_urls = set()
        for index in range(self.result_list.count()):
            item = self.result_list.item(index)
            if not item:
                continue
            video = item.data(Qt.ItemDataRole.UserRole)
            if video:
                existing_urls.add(video.url)

        added = 0
        for video in results:
            if video.url in existing_urls:
                continue
            existing_urls.add(video.url)
            item = QListWidgetItem()
            item.setData(Qt.ItemDataRole.UserRole, video)
            self.result_list.addItem(item)
            item_widget = SearchResultItemWidget(video, thumbnail_loader=self.thumbnail_loader)
            item.setSizeHint(item_widget.sizeHint())
            self.result_list.setItemWidget(item, item_widget)
            added += 1

        self._search_result_count = self.result_list.count()
        self._set_results_state("未找到匹配结果，请换个关键词试试。")
        self.load_more_btn.setEnabled(self._search_result_count > 0)

        logger.info(f"显示 {added} 个新搜索结果，共 {self._search_result_count} 条")
        self._thumbnail_requests_enabled = False
        self._thumbnail_load_pending = False
        self._thumbnail_load_scheduled = False
        QTimer.singleShot(0, self._enable_thumbnail_requests)
        if self.result_list.count() > 0 and added > 0 and self.result_list.currentRow() < 0:
            self.result_list.setCurrentRow(0)
        elif self.result_list.count() == 0:
            self._reset_detail_panel()
        self.results_state_label.setVisible(self.result_list.count() == 0)
        self.refresh_overview()

    def _set_results_state(self, text: str) -> None:
        """更新结果列表空态提示。"""

        if not hasattr(self, "results_state_label"):
            return
        self.results_state_label.setText(text)
        self.results_state_label.setVisible(self.result_list.count() == 0)

    def eventFilter(self, watched, event):
        if watched in (self.result_list.viewport(), self.result_list):
            if event.type() == QEvent.Type.Resize:
                self._schedule_visible_thumbnail_load()
            if event.type() == QEvent.Type.KeyPress and isinstance(event, QKeyEvent):
                if event.key() in (Qt.Key.Key_Return, Qt.Key.Key_Enter):
                    self.download_selected()
                    return True
        return super().eventFilter(watched, event)

    def _schedule_visible_thumbnail_load(self):
        self._thumbnail_load_pending = True
        if not self._thumbnail_requests_enabled or self._thumbnail_load_scheduled:
            return
        self._thumbnail_load_scheduled = True
        QTimer.singleShot(0, self._flush_visible_thumbnail_requests)

    def _enable_thumbnail_requests(self):
        self._thumbnail_requests_enabled = True
        if self._thumbnail_load_pending and not self._thumbnail_load_scheduled:
            self._thumbnail_load_scheduled = True
            QTimer.singleShot(0, self._flush_visible_thumbnail_requests)

    def _flush_visible_thumbnail_requests(self):
        self._thumbnail_load_scheduled = False
        if not self._thumbnail_requests_enabled or not self._thumbnail_load_pending:
            return
        self._thumbnail_load_pending = False
        self._request_visible_thumbnails()

    def _request_visible_thumbnails(self):
        viewport_rect = self.result_list.viewport().rect()
        requested = 0
        for index in range(self.result_list.count()):
            item = self.result_list.item(index)
            if item is None:
                continue
            if not self.result_list.visualItemRect(item).intersects(viewport_rect):
                continue

            video_info = item.data(Qt.ItemDataRole.UserRole)
            if not video_info:
                continue
            self.thumbnail_loader.request_thumbnail(video_info.url, video_info.thumbnail_url)
            requested += 1
        if requested:
            logger.info(f"为可视项请求 {requested} 个封面")

    def _on_selection_changed(self, current: QListWidgetItem, previous: QListWidgetItem):
        if previous and previous is not current:
            prev_widget = self.result_list.itemWidget(previous)
            if prev_widget and hasattr(prev_widget, "set_selected"):
                prev_widget.set_selected(False)

        if current:
            curr_widget = self.result_list.itemWidget(current)
            if curr_widget and hasattr(curr_widget, "set_selected"):
                curr_widget.set_selected(True)

        self._previous_list_item = current

        if not current:
            self._reset_detail_panel()
            return
        video_info = current.data(Qt.ItemDataRole.UserRole)
        if not video_info:
            self._reset_detail_panel()
            return
        self._update_detail_panel(video_info)

    def _reset_detail_panel(self):
        self._selected_video_info = None
        self.detail_title_label.setText("请选择一个搜索结果")
        self.detail_meta_label.setText("上传者：- · 时长：-")
        self.detail_url_label.setText("链接：-")
        self.preview_status_label.setText("选择一个结果后，可以预览或打开链接。")
        self.platform_badge.setText("-")
        self.platform_badge.setTone("neutral")
        self.duration_badge.setText("时长 -")
        self.duration_badge.setTone("neutral")
        self.preview_state_badge.setText("预览待选择")
        self.preview_state_badge.setTone("neutral")
        self._set_preview_area_visible(False)
        self._set_detail_thumbnail_placeholder("封面待加载")
        self.preview_widget.clear()
        self.copy_link_btn.setEnabled(False)
        self.open_link_btn.setEnabled(False)
        self.download_btn.setEnabled(False)
        self.preview_btn.setEnabled(False)
        self.refresh_overview()

    def _update_detail_panel(self, video_info: VideoInfo):
        uploader = video_info.uploader or "未知"
        duration = self._format_duration(video_info.duration)
        normalized_url = self._normalize_video_url(video_info.url)

        self._selected_video_info = video_info
        self.detail_title_label.setText(video_info.title or "未命名视频")
        self.detail_meta_label.setText(f"上传者：{uploader} · 时长：{duration}")
        self.detail_url_label.setText(f"链接：{normalized_url}")
        self.platform_badge.setText(self._platform_label(video_info.platform))
        self.platform_badge.setTone(self._platform_tone(video_info.platform))
        self.duration_badge.setText(f"时长 {duration}")
        self.duration_badge.setTone("neutral")
        self.preview_state_badge.setText("可预览")
        self.preview_state_badge.setTone("info")
        self.preview_status_label.setText("点击“直接预览”播放视频；不可播放时会自动打开浏览器。")
        self.preview_widget.clear()
        self._set_preview_area_visible(False)
        self.copy_link_btn.setEnabled(True)
        self.open_link_btn.setEnabled(True)
        self.download_btn.setEnabled(True)
        self.preview_btn.setEnabled(True)
        self._update_detail_thumbnail(video_info)
        self.refresh_overview()

    def _set_detail_thumbnail_placeholder(self, text: str):
        self.detail_thumbnail_label.clear()
        self.detail_thumbnail_label.setText("封面")
        self.detail_thumbnail_status_label.setText(text)

    def _set_preview_area_visible(self, visible: bool):
        self.preview_widget.setVisible(visible)
        self.detail_thumbnail_label.setVisible(not visible)
        self.detail_thumbnail_status_label.setVisible(not visible)

    def _set_detail_thumbnail(self, pixmap: QPixmap):
        scaled = pixmap.scaled(
            self.detail_thumbnail_label.size(),
            Qt.AspectRatioMode.KeepAspectRatioByExpanding,
            Qt.TransformationMode.SmoothTransformation,
        )
        self.detail_thumbnail_label.setPixmap(scaled)
        self.detail_thumbnail_status_label.setText("封面已加载")

    def _update_detail_thumbnail(self, video_info: VideoInfo):
        if not video_info.thumbnail_url:
            self._set_detail_thumbnail_placeholder("暂无封面")
            return

        cached = self.thumbnail_loader.get_cached_pixmap(video_info.thumbnail_url)
        if cached is not None:
            self._set_detail_thumbnail(cached)
            return

        self._set_detail_thumbnail_placeholder("封面加载中…")
        self.thumbnail_loader.request_thumbnail(video_info.url, video_info.thumbnail_url)

    def _on_detail_thumbnail_loaded(self, item_key: str, pixmap: QPixmap):
        current_item = self.result_list.currentItem()
        if not current_item:
            return
        current_video = current_item.data(Qt.ItemDataRole.UserRole)
        if not current_video or current_video.url != item_key:
            return
        self._set_detail_thumbnail(pixmap)

    def _on_detail_thumbnail_failed(self, item_key: str, _reason: str):
        current_item = self.result_list.currentItem()
        if not current_item:
            return
        current_video = current_item.data(Qt.ItemDataRole.UserRole)
        if not current_video or current_video.url != item_key:
            return
        self._set_detail_thumbnail_placeholder("暂无封面")

    def search_error(self, request_id: int, error_msg: str):
        """搜索错误。"""

        if request_id != self._active_search_request_id:
            return

        if "412" in error_msg or "Precondition Failed" in error_msg:
            error_text = (
                "YouTube 暂时无法完成搜索。\n\n"
                "可以这样处理：\n\n"
                "1. 在设置里启用代理\n"
                "2. 复制视频链接到下载页直接下载\n"
                "3. 切换到 Bilibili 搜索\n"
                "4. 稍后重试"
            )
            QMessageBox.warning(self, "搜索失败", error_text)
        else:
            QMessageBox.warning(self, "搜索失败", f"搜索失败：{error_msg}")
        self._set_results_state("搜索未完成，请调整关键词后重试。")

    def search_finished(self):
        """搜索完成。"""

        self.search_btn.setText("搜索")

    def download_selected(self, item: QListWidgetItem = None):
        """下载选中的视频。"""

        current_item = item if item is not None else self.result_list.currentItem()
        if not current_item:
            QMessageBox.warning(self, "需要选择", "请先选择一个视频")
            return

        video_info = current_item.data(Qt.ItemDataRole.UserRole)

        options = self.config.build_download_options()
        task = DownloadTask(video_info=video_info, options=options)
        self.download_manager.add_task(task)
        if self.toast:
            action_cb = None
            if self.main_window and hasattr(self.main_window, "switch_to_queue"):
                action_cb = self.main_window.switch_to_queue
            self.toast.show_success(
                "已加入队列",
                video_info.title or "任务已添加",
                action_label="查看队列" if action_cb else None,
                action_cb=action_cb,
            )

    def _selected_video_url(self) -> str:
        current_item = self.result_list.currentItem()
        if not current_item:
            return ""
        video_info = current_item.data(Qt.ItemDataRole.UserRole)
        if not video_info:
            return ""
        return self._normalize_video_url(video_info.url)

    def copy_selected_link(self):
        url = self._selected_video_url()
        if not url:
            return
        QApplication.clipboard().setText(url)
        self.preview_status_label.setText("链接已复制，可以继续下载或预览。")

    def open_selected_link(self):
        url = self._selected_video_url()
        if not url:
            return
        QDesktopServices.openUrl(QUrl(url))
        self.preview_status_label.setText("已尝试打开链接。")

    def preview_selected_video(self):
        """预览选中的视频。"""

        current_item = self.result_list.currentItem()
        if not current_item:
            QMessageBox.warning(self, "需要选择", "请先选择一个视频")
            return

        video_info = current_item.data(Qt.ItemDataRole.UserRole)
        normalized_url = self._normalize_video_url(video_info.url)
        self._preview_fallback_triggered = False
        self.preview_status_label.setText(f"正在预览：{video_info.title or '当前视频'}…")
        self.preview_state_badge.setText("预览中")
        self.preview_state_badge.setTone("primary")
        self._set_preview_area_visible(True)
        self.preview_widget.stop()

        success = self.preview_widget.try_play(normalized_url)
        if success:
            self.preview_status_label.setText("正在应用内预览视频。")
            return

        self._trigger_fallback(video_info, normalized_url)

    def _on_preview_failed(self, reason: str):
        """处理预览失败信号。"""

        logger.warning(f"预览异步失败: {reason}")
        if self._preview_fallback_triggered:
            return

        current_item = self.result_list.currentItem()
        if not current_item:
            return

        video_info = current_item.data(Qt.ItemDataRole.UserRole)
        if not video_info:
            return

        normalized_url = self._normalize_video_url(video_info.url)
        self.preview_status_label.setText("应用内播放失败，正在打开浏览器…")
        self._trigger_fallback(video_info, normalized_url)

    def _trigger_fallback(self, video_info: VideoInfo, url: str):
        """触发浏览器回退。"""

        if self._preview_fallback_triggered:
            return
        self._preview_fallback_triggered = True
        self._fallback_to_browser_preview(video_info, url)

    def _fallback_to_browser_preview(self, video_info: VideoInfo, url: str):
        """回退到浏览器打开视频链接。"""

        self.preview_widget.clear()
        self.preview_status_label.setText("应用内预览不可用，正在打开浏览器…")
        self.preview_state_badge.setText("浏览器回退")
        self.preview_state_badge.setTone("warning")
        self._set_preview_area_visible(False)

        if not url:
            self.preview_status_label.setText("无法获取视频链接")
            return

        success = QDesktopServices.openUrl(QUrl(url))
        if success:
            self.preview_status_label.setText("已在浏览器打开视频预览。")
        else:
            self.preview_status_label.setText("浏览器打开失败，请复制链接手动访问。")
            if self._can_show_dialog():
                QMessageBox.warning(self, "打开失败", "无法打开链接，请检查默认浏览器设置")

    def _format_duration(self, seconds: int) -> str:
        """格式化时长。"""

        if seconds in (None, "", 0):
            return "暂无"

        try:
            seconds = int(seconds)
        except (TypeError, ValueError):
            return "暂无"

        if seconds <= 0:
            return "暂无"

        hours = seconds // 3600
        minutes = (seconds % 3600) // 60
        secs = seconds % 60

        if hours > 0:
            return f"{hours:02d}:{minutes:02d}:{secs:02d}"
        return f"{minutes:02d}:{secs:02d}"

    def _normalize_video_url(self, raw_value: str) -> str:
        """标准化视频链接，支持 ID 到可访问 URL 的转换。"""
        return normalize_video_url(raw_value)

    def _platform_label(self, platform: Platform) -> str:
        platform_value = platform.value if platform else "unknown"
        mapping = {
            "youtube": "YouTube",
            "bilibili": "Bilibili",
            "douyin": "抖音",
            "tiktok": "TikTok",
            "twitter": "X / Twitter",
            "instagram": "Instagram",
        }
        return mapping.get(platform_value, "未知平台")

    def _platform_tone(self, platform: Platform) -> str:
        platform_value = platform.value if platform else "unknown"
        if platform_value == "youtube":
            return "youtube"
        if platform_value == "bilibili":
            return "bilibili"
        if platform_value == "douyin":
            return "warning"
        if platform_value == "tiktok":
            return "info"
        return "primary"

    def _can_show_dialog(self) -> bool:
        app = QApplication.instance()
        if app is None:
            return False
        platform_name = getattr(app, "platformName", None)
        if callable(platform_name):
            try:
                return platform_name().lower() != "offscreen"
            except Exception:
                return True
        return True
