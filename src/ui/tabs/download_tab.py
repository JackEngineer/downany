"""
下载标签页，支持单个和批量 URL 输入。
"""
from __future__ import annotations

from PyQt6.QtWidgets import (
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPushButton,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from src.core.download_manager import DownloadManager
from src.core.download_task import DownloadTask, VideoInfo
from src.core.platform_detector import PlatformDetector
from src.data.config_manager import ConfigManager
from src.ui.components.chrome import BodyLabel, PageHeader, SectionCard, StatusBadge
from src.ui.fluent_support import get_fluent_widget
from src.utils.logger import setup_logger

logger = setup_logger("DownloadTab")


class DownloadTab(QWidget):
    """下载标签页。"""

    def __init__(self, download_manager: DownloadManager):
        super().__init__()
        self.download_manager = download_manager
        self.config = ConfigManager()
        self.init_ui()
        self.refresh_overview()

    def init_ui(self):
        line_edit_cls = get_fluent_widget("LineEdit") or QLineEdit
        text_edit_cls = get_fluent_widget("TextEdit") or QTextEdit
        push_button_cls = get_fluent_widget("PushButton") or QPushButton
        primary_button_cls = get_fluent_widget("PrimaryPushButton") or push_button_cls

        layout = QVBoxLayout()
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(18)

        self.header = PageHeader(
            "下载工作台",
            "粘贴单条链接或批量链接，将任务快速加入队列并开始下载。",
            metrics=[
                ("待处理任务", "0", "当前队列与下载中任务"),
                ("默认质量", "best", "来自设置页"),
                ("字幕", "关闭", "自动下载字幕"),
            ],
        )
        layout.addWidget(self.header)

        content_layout = QHBoxLayout()
        content_layout.setSpacing(18)

        left_column = QVBoxLayout()
        left_column.setSpacing(18)

        single_card = SectionCard("单个下载", "输入一个 URL，点击按钮即可加入下载队列。")
        single_layout = single_card.body_layout

        url_layout = QHBoxLayout()
        url_layout.setSpacing(12)
        url_layout.addWidget(QLabel("视频链接"))
        self.single_url_input = line_edit_cls()
        self.single_url_input.setPlaceholderText("请输入视频页面链接或视频 ID")
        url_layout.addWidget(self.single_url_input, 1)
        single_layout.addLayout(url_layout)

        single_hint = BodyLabel("支持常见视频平台链接；如果只是粘贴视频 ID，系统会尝试自动识别。")
        single_hint.setObjectName("PageHint")
        single_layout.addWidget(single_hint)

        single_btn_row = QHBoxLayout()
        single_btn_row.addStretch()
        self.single_download_btn = primary_button_cls("开始下载")
        self.single_download_btn.setObjectName("primaryActionButton")
        self.single_download_btn.clicked.connect(self.start_single_download)
        single_btn_row.addWidget(self.single_download_btn)
        single_layout.addLayout(single_btn_row)

        batch_card = SectionCard("批量下载", "每行一个链接，系统会按顺序加入下载队列。")
        batch_layout = batch_card.body_layout

        self.batch_url_input = text_edit_cls()
        self.batch_url_input.setPlaceholderText(
            "https://example.com/video-1\nhttps://example.com/video-2\n…"
        )
        self.batch_url_input.setMaximumHeight(180)
        batch_layout.addWidget(self.batch_url_input)

        batch_hint = BodyLabel("批量模式下，某一条失败不会中断后续任务。")
        batch_hint.setObjectName("PageHint")
        batch_layout.addWidget(batch_hint)

        batch_btn_row = QHBoxLayout()
        batch_btn_row.addStretch()
        self.batch_download_btn = primary_button_cls("加入批量任务")
        self.batch_download_btn.setObjectName("primaryActionButton")
        self.batch_download_btn.clicked.connect(self.start_batch_download)
        batch_btn_row.addWidget(self.batch_download_btn)
        batch_layout.addLayout(batch_btn_row)

        left_column.addWidget(single_card)
        left_column.addWidget(batch_card)

        right_column = QVBoxLayout()
        right_column.setSpacing(18)

        overview_card = SectionCard("下载摘要", "让你在开始任务前，快速确认当前设置。")
        overview_layout = overview_card.body_layout

        self.overview_queue_badge = StatusBadge("0 个任务", "neutral")
        self.overview_quality_badge = StatusBadge("best", "primary")
        self.overview_subtitle_badge = StatusBadge("关闭", "neutral")
        self.overview_proxy_badge = StatusBadge("未启用", "neutral")
        self.overview_concurrent_badge = StatusBadge("3", "info")

        summary_rows = [
            ("当前队列", self.overview_queue_badge),
            ("默认质量", self.overview_quality_badge),
            ("字幕", self.overview_subtitle_badge),
            ("代理", self.overview_proxy_badge),
            ("并发上限", self.overview_concurrent_badge),
        ]

        for label_text, badge in summary_rows:
            row = QHBoxLayout()
            row.setSpacing(12)
            label = QLabel(label_text)
            label.setObjectName("PageHint")
            row.addWidget(label)
            row.addStretch()
            row.addWidget(badge)
            overview_layout.addLayout(row)

        self.download_dir_label = QLabel()
        self.download_dir_label.setWordWrap(True)
        self.download_dir_label.setObjectName("PageHint")
        overview_layout.addWidget(self.download_dir_label)

        tip_card = SectionCard("使用提示", "保持工作流更稳定、更可控。")
        tip_layout = tip_card.body_layout
        tips = [
            "• 批量下载建议一次只加入你真正要处理的链接。",
            "• 代理和字幕设置会直接影响新加入的任务。",
            "• 任务会自动进入队列，失败后可以在队列页重试。",
        ]
        for tip in tips:
            tip_label = BodyLabel(tip)
            tip_label.setWordWrap(True)
            tip_label.setObjectName("PageHint")
            tip_layout.addWidget(tip_label)

        right_column.addWidget(overview_card)
        right_column.addWidget(tip_card)
        right_column.addStretch()

        content_layout.addLayout(left_column, 2)
        content_layout.addLayout(right_column, 1)
        layout.addLayout(content_layout, 1)

        self.setLayout(layout)

    def refresh_overview(self):
        """刷新右侧摘要。"""

        tasks = list(self.download_manager.get_all_tasks().values())
        pending = sum(1 for task in tasks if task.status.value in {"pending", "downloading", "paused"})
        self.header.set_metrics(
            [
                ("待处理任务", str(pending), "正在排队或下载中的任务"),
                ("默认质量", self.config.get_default_quality(), "来自设置页"),
                ("字幕", "开启" if self.config.is_download_subtitles() else "关闭", "自动下载字幕"),
            ]
        )

        self.overview_queue_badge.setText(f"{pending} 个任务")
        self.overview_quality_badge.setText(self.config.get_default_quality())
        self.overview_subtitle_badge.setText("开启" if self.config.is_download_subtitles() else "关闭")
        self.overview_subtitle_badge.setTone("success" if self.config.is_download_subtitles() else "neutral")

        proxy_enabled = self.config.is_proxy_enabled() and bool(self.config.get_proxy_url().strip())
        self.overview_proxy_badge.setText("已启用" if proxy_enabled else "未启用")
        self.overview_proxy_badge.setTone("info" if proxy_enabled else "neutral")

        self.overview_concurrent_badge.setText(str(self.config.get_concurrent_downloads()))
        self.download_dir_label.setText(f"下载目录：{self.config.get_download_dir()}")

    def start_single_download(self):
        """开始单个下载。"""

        url = self.single_url_input.text().strip()
        if not url:
            QMessageBox.warning(self, "需要链接", "请先输入有效的视频链接")
            return

        self._add_download_task(url)
        self.single_url_input.clear()

    def start_batch_download(self):
        """开始批量下载。"""

        text = self.batch_url_input.toPlainText()
        urls = [line.strip() for line in text.split("\n") if line.strip()]

        if not urls:
            QMessageBox.warning(self, "需要链接", "请至少输入一个有效的视频链接")
            return

        for url in urls:
            self._add_download_task(url)

        self.batch_url_input.clear()
        QMessageBox.information(self, "已加入队列", f"已添加 {len(urls)} 个下载任务到队列")
        self.refresh_overview()

    def _add_download_task(self, url: str):
        """添加下载任务。"""

        platform = PlatformDetector.detect(url)
        video_info = VideoInfo(
            url=url,
            title="正在获取信息…",
            platform=platform,
        )

        options = self.config.build_download_options()
        task = DownloadTask(video_info=video_info, options=options)
        self.download_manager.add_task(task)
        logger.info(f"添加下载任务: {url}")
        self.refresh_overview()
