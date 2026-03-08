"""
搜索标签页，支持在平台内搜索视频。
"""
from PyQt6.QtWidgets import (
    QApplication, QWidget, QVBoxLayout, QHBoxLayout, QLineEdit,
    QPushButton, QLabel, QComboBox, QListWidget,
    QListWidgetItem, QMessageBox, QSplitter, QFrame
)
from PyQt6.QtCore import QEvent, QTimer, Qt, QThread, pyqtSignal, QUrl
from PyQt6.QtGui import QDesktopServices, QPixmap
import re
from src.core.search_engine import SearchEngine
from src.core.download_task import Platform, DownloadTask, VideoInfo, DownloadOptions
from src.core.download_manager import DownloadManager
from src.data.config_manager import ConfigManager
from src.data.database import HistoryDB
from src.ui.components import SearchResultItemWidget, ThumbnailLoader, VideoPreviewWidget
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

    def __init__(self, download_manager: DownloadManager, thumbnail_loader: ThumbnailLoader = None):
        super().__init__()
        self.download_manager = download_manager
        self.config = ConfigManager()
        self.db = HistoryDB()
        self.search_thread = None
        self.thumbnail_loader = thumbnail_loader or ThumbnailLoader()
        self._detail_placeholder_pixmap = QPixmap()
        self.init_ui()
        self.thumbnail_loader.thumbnail_loaded.connect(self._on_detail_thumbnail_loaded)
        self.thumbnail_loader.thumbnail_failed.connect(self._on_detail_thumbnail_failed)

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

        splitter = QSplitter(Qt.Orientation.Horizontal)

        # 结果列表
        self.result_list = QListWidget()
        self.result_list.itemDoubleClicked.connect(self.download_selected)
        self.result_list.currentItemChanged.connect(self._on_selection_changed)
        self.result_list.verticalScrollBar().valueChanged.connect(self._schedule_visible_thumbnail_load)
        self.result_list.horizontalScrollBar().valueChanged.connect(self._schedule_visible_thumbnail_load)
        self.result_list.viewport().installEventFilter(self)
        self.result_list.installEventFilter(self)
        splitter.addWidget(self.result_list)

        # 详情区
        detail_panel = QFrame()
        detail_panel.setObjectName("searchDetailPanel")
        detail_layout = QVBoxLayout()
        detail_layout.setSpacing(10)

        self.detail_title_label = QLabel("请选择一个搜索结果")
        self.detail_title_label.setObjectName("searchDetailTitle")
        self.detail_title_label.setWordWrap(True)
        detail_layout.addWidget(self.detail_title_label)

        self.detail_meta_label = QLabel("平台: - | 上传者: - | 时长: -")
        self.detail_meta_label.setObjectName("searchDetailMeta")
        self.detail_meta_label.setWordWrap(True)
        detail_layout.addWidget(self.detail_meta_label)

        self.detail_url_label = QLabel("链接: -")
        self.detail_url_label.setObjectName("searchDetailUrl")
        self.detail_url_label.setWordWrap(True)
        self.detail_url_label.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        detail_layout.addWidget(self.detail_url_label)

        self.detail_thumbnail_label = QLabel()
        self.detail_thumbnail_label.setObjectName("searchDetailThumbnail")
        self.detail_thumbnail_label.setMinimumSize(320, 180)
        self.detail_thumbnail_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        detail_layout.addWidget(self.detail_thumbnail_label)

        self.detail_thumbnail_status_label = QLabel("封面待加载")
        self.detail_thumbnail_status_label.setObjectName("searchDetailThumbnailStatus")
        detail_layout.addWidget(self.detail_thumbnail_status_label)

        # 视频预览区域
        self.preview_widget = VideoPreviewWidget()
        self.preview_widget.setObjectName("videoPreviewWidget")
        self.preview_widget.playback_failed.connect(self._on_preview_failed)
        detail_layout.addWidget(self.preview_widget)

        action_layout = QHBoxLayout()
        self.copy_link_btn = QPushButton("复制链接")
        self.copy_link_btn.clicked.connect(self.copy_selected_link)
        action_layout.addWidget(self.copy_link_btn)

        self.open_link_btn = QPushButton("打开链接")
        self.open_link_btn.clicked.connect(self.open_selected_link)
        action_layout.addWidget(self.open_link_btn)

        self.download_btn = QPushButton("下载选中")
        self.download_btn.clicked.connect(lambda: self.download_selected())
        action_layout.addWidget(self.download_btn)

        self.preview_btn = QPushButton("直接预览")
        self.preview_btn.clicked.connect(self.preview_selected_video)
        action_layout.addWidget(self.preview_btn)
        detail_layout.addLayout(action_layout)

        self.preview_status_label = QLabel("预览入口已就绪，待播放器接入")
        self.preview_status_label.setObjectName("searchPreviewStatus")
        detail_layout.addWidget(self.preview_status_label)
        detail_layout.addStretch()

        detail_panel.setLayout(detail_layout)
        splitter.addWidget(detail_panel)
        splitter.setStretchFactor(0, 3)
        splitter.setStretchFactor(1, 2)
        layout.addWidget(splitter)
        self.setLayout(layout)
        self._reset_detail_panel()

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
        self._reset_detail_panel()

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
        self._schedule_visible_thumbnail_load()
        if self.result_list.count() > 0:
            self.result_list.setCurrentRow(0)
        else:
            self._reset_detail_panel()

    def eventFilter(self, watched, event):
        if watched in (self.result_list.viewport(), self.result_list) and event.type() == QEvent.Type.Resize:
            self._schedule_visible_thumbnail_load()
        return super().eventFilter(watched, event)

    def _schedule_visible_thumbnail_load(self):
        QTimer.singleShot(0, self._request_visible_thumbnails)

    def _request_visible_thumbnails(self):
        viewport_rect = self.result_list.viewport().rect()
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

    def _on_selection_changed(self, current: QListWidgetItem, _previous: QListWidgetItem):
        if not current:
            self._reset_detail_panel()
            return
        video_info = current.data(Qt.ItemDataRole.UserRole)
        if not video_info:
            self._reset_detail_panel()
            return
        self._update_detail_panel(video_info)

    def _reset_detail_panel(self):
        self.detail_title_label.setText("请选择一个搜索结果")
        self.detail_meta_label.setText("平台: - | 上传者: - | 时长: -")
        self.detail_url_label.setText("链接: -")
        self.preview_status_label.setText("请选择视频进行预览")
        self._set_detail_thumbnail_placeholder("封面待加载")
        self.preview_widget.clear()
        self.copy_link_btn.setEnabled(False)
        self.open_link_btn.setEnabled(False)
        self.download_btn.setEnabled(False)
        self.preview_btn.setEnabled(False)

    def _update_detail_panel(self, video_info: VideoInfo):
        platform_name = video_info.platform.value if video_info.platform else "Unknown"
        uploader = video_info.uploader or "Unknown"
        duration = self._format_duration(video_info.duration)
        normalized_url = self._normalize_video_url(video_info.url)

        self.detail_title_label.setText(video_info.title or "Unknown")
        self.detail_meta_label.setText(f"平台: {platform_name} | 上传者: {uploader} | 时长: {duration}")
        self.detail_url_label.setText(f"链接: {normalized_url}")
        self.preview_status_label.setText("可点击“直接预览”播放视频（失败时自动回退浏览器）")
        self.copy_link_btn.setEnabled(True)
        self.open_link_btn.setEnabled(True)
        self.download_btn.setEnabled(True)
        self.preview_btn.setEnabled(True)
        self._update_detail_thumbnail(video_info)

    def _set_detail_thumbnail_placeholder(self, text: str):
        self.detail_thumbnail_label.clear()
        self.detail_thumbnail_status_label.setText(text)

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

        cached = self.thumbnail_loader._pixmap_cache.get(video_info.thumbnail_url)
        if cached is not None and not cached.isNull():
            self._set_detail_thumbnail(cached)
            return

        self._set_detail_thumbnail_placeholder("封面加载中...")
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
        self.preview_status_label.setText("链接已复制，可继续下载或预览")

    def open_selected_link(self):
        url = self._selected_video_url()
        if not url:
            return
        QDesktopServices.openUrl(QUrl(url))
        self.preview_status_label.setText("已尝试打开链接")

    def preview_selected_video(self):
        """
        预览选中的视频。
        优先尝试应用内播放，失败时自动回退到浏览器打开。
        """
        current_item = self.result_list.currentItem()
        if not current_item:
            QMessageBox.warning(self, "提示", "请选择一个视频")
            return

        video_info = current_item.data(Qt.ItemDataRole.UserRole)
        normalized_url = self._normalize_video_url(video_info.url)

        self.preview_status_label.setText(
            f"正在尝试预览：{video_info.title or '当前视频'}..."
        )

        # 先停止当前播放
        self.preview_widget.stop()

        # 尝试应用内播放
        success = self.preview_widget.try_play(normalized_url)
        if success:
            self.preview_status_label.setText("正在应用内预览视频")
            return

        # 应用内播放失败或需要解析，自动回退到浏览器
        self._fallback_to_browser_preview(video_info, normalized_url)

    def _on_preview_failed(self, reason: str):
        """处理预览失败信号。"""
        logger.warning(f"预览失败: {reason}")
        # 失败已在 try_play 中处理回退，这里主要用于状态更新

    def _fallback_to_browser_preview(self, video_info: VideoInfo, url: str):
        """回退到浏览器打开视频链接。"""
        self.preview_status_label.setText(
            f"应用内预览不可用，正在尝试浏览器打开..."
        )

        if not url:
            QMessageBox.warning(self, "提示", "无法获取视频链接")
            self.preview_status_label.setText("无法获取视频链接")
            return

        success = QDesktopServices.openUrl(QUrl(url))
        if success:
            self.preview_status_label.setText("已在浏览器打开视频预览")
        else:
            QMessageBox.warning(
                self, "提示", "无法打开链接，请检查默认浏览器设置"
            )
            self.preview_status_label.setText(
                "浏览器打开失败，请复制链接手动访问"
            )

    def _format_duration(self, seconds: int) -> str:
        """格式化时长"""
        if seconds in (None, "", 0):
            return "N/A"

        try:
            seconds = int(seconds)
        except (TypeError, ValueError):
            return "N/A"

        if seconds <= 0:
            return "N/A"

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
