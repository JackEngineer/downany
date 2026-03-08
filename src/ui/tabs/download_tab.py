"""
下载标签页，支持单个和批量 URL 输入。
"""
from PyQt6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLineEdit,
    QPushButton, QLabel, QTextEdit, QGroupBox, QMessageBox
)
from PyQt6.QtCore import Qt
from src.core.download_manager import DownloadManager
from src.core.download_task import DownloadTask, VideoInfo, DownloadOptions
from src.core.platform_detector import PlatformDetector
from src.core.video_info_extractor import VideoInfoExtractor
from src.data.config_manager import ConfigManager
from src.ui.fluent_support import get_fluent_widget
from src.utils.logger import setup_logger

logger = setup_logger("DownloadTab")


class DownloadTab(QWidget):
    """下载标签页"""

    def __init__(self, download_manager: DownloadManager):
        super().__init__()
        self.download_manager = download_manager
        self.config = ConfigManager()
        self.init_ui()

    def init_ui(self):
        line_edit_cls = get_fluent_widget("LineEdit") or QLineEdit
        text_edit_cls = get_fluent_widget("TextEdit") or QTextEdit
        push_button_cls = get_fluent_widget("PushButton") or QPushButton
        primary_button_cls = get_fluent_widget("PrimaryPushButton") or push_button_cls

        layout = QVBoxLayout()
        layout.setSpacing(15)

        # 单个下载区域
        single_group = QGroupBox("单个下载")
        single_layout = QVBoxLayout()

        # URL 输入
        url_layout = QHBoxLayout()
        url_layout.addWidget(QLabel("视频链接:"))
        self.single_url_input = line_edit_cls()
        self.single_url_input.setPlaceholderText("请输入视频链接...")
        url_layout.addWidget(self.single_url_input)
        single_layout.addLayout(url_layout)

        # 按钮
        btn_layout = QHBoxLayout()
        btn_layout.addStretch()
        self.single_download_btn = primary_button_cls("开始下载")
        self.single_download_btn.clicked.connect(self.start_single_download)
        btn_layout.addWidget(self.single_download_btn)
        btn_layout.addStretch()
        single_layout.addLayout(btn_layout)

        single_group.setLayout(single_layout)
        layout.addWidget(single_group)

        # 批量下载区域
        batch_group = QGroupBox("批量下载")
        batch_layout = QVBoxLayout()

        batch_layout.addWidget(QLabel("请输入视频链接 (每行一个):"))
        self.batch_url_input = text_edit_cls()
        self.batch_url_input.setPlaceholderText("https://example.com/video1\\nhttps://example.com/video2\\n...")
        self.batch_url_input.setMaximumHeight(150)
        batch_layout.addWidget(self.batch_url_input)

        # 按钮
        batch_btn_layout = QHBoxLayout()
        batch_btn_layout.addStretch()
        self.batch_download_btn = primary_button_cls("开始批量下载")
        self.batch_download_btn.clicked.connect(self.start_batch_download)
        batch_btn_layout.addWidget(self.batch_download_btn)
        batch_btn_layout.addStretch()
        batch_layout.addLayout(batch_btn_layout)

        batch_group.setLayout(batch_layout)
        layout.addWidget(batch_group)

        layout.addStretch()
        self.setLayout(layout)

    def start_single_download(self):
        """开始单个下载"""
        url = self.single_url_input.text().strip()
        if not url:
            QMessageBox.warning(self, "提示", "请输入有效的视频链接")
            return

        self._add_download_task(url)
        self.single_url_input.clear()

    def start_batch_download(self):
        """开始批量下载"""
        text = self.batch_url_input.toPlainText()
        urls = [line.strip() for line in text.split('\\n') if line.strip()]

        if not urls:
            QMessageBox.warning(self, "提示", "请输入至少一个有效的视频链接")
            return

        for url in urls:
            self._add_download_task(url)

        self.batch_url_input.clear()
        QMessageBox.information(self, "成功", f"已添加 {len(urls)} 个下载任务到队列")

    def _add_download_task(self, url: str):
        """添加下载任务"""
        # 检测平台
        platform = PlatformDetector.detect(url)

        # 创建视频信息
        video_info = VideoInfo(
            url=url,
            title="正在获取信息...",
            platform=platform
        )

        # 创建下载选项
        options = DownloadOptions(
            output_path=self.config.get_download_dir(),
            quality=self.config.get_default_quality(),
            download_subtitles=self.config.is_download_subtitles(),
            speed_limit=self.config.get_speed_limit() if self.config.get_speed_limit() > 0 else None,
            proxy=self.config.get_proxy_url() if self.config.is_proxy_enabled() else None
        )

        # 创建任务
        task = DownloadTask(
            video_info=video_info,
            options=options
        )

        # 添加到下载管理器
        self.download_manager.add_task(task)
        logger.info(f"添加下载任务: {url}")
