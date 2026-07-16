"""
设置标签页，配置下载参数。
"""
from __future__ import annotations

from PyQt6.QtCore import pyqtSignal
from PyQt6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QFileDialog,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPushButton,
    QSpinBox,
    QVBoxLayout,
    QWidget,
)

from src.data.config_manager import ConfigManager
from src.ui.components.chrome import BodyLabel, PageHeader, SectionCard, StatusBadge
from src.ui.fluent_support import get_fluent_widget
from src.utils.logger import setup_logger

logger = setup_logger("SettingsTab")


class SettingsTab(QWidget):
    """设置标签页。"""

    theme_changed = pyqtSignal(str)
    settings_saved = pyqtSignal()

    def __init__(self):
        super().__init__()
        self.config = ConfigManager()
        self.init_ui()
        self.load_settings()
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
            "偏好设置",
            "调整下载目录、并发、代理和界面主题，让应用更贴合你的工作流。",
            metrics=[
                ("主题", "跟随系统", "浅色 / 深色 / 跟随系统"),
                ("下载目录", "-", "当前保存路径"),
                ("并发", "3", "同时任务数"),
            ],
        )
        layout.addWidget(self.header)

        download_card = SectionCard("下载设置", "最常用的任务配置。")
        download_layout = download_card.body_layout

        dir_row = QHBoxLayout()
        dir_row.setSpacing(12)
        dir_row.addWidget(QLabel("下载目录"))
        self.dir_input = line_edit_cls()
        dir_row.addWidget(self.dir_input, 1)
        self.dir_btn = push_button_cls("选择")
        self.dir_btn.clicked.connect(self.choose_directory)
        dir_row.addWidget(self.dir_btn)
        download_layout.addLayout(dir_row)

        concurrent_row = QHBoxLayout()
        concurrent_row.setSpacing(12)
        concurrent_row.addWidget(QLabel("并发下载数"))
        self.concurrent_spin = QSpinBox()
        self.concurrent_spin.setMinimum(1)
        self.concurrent_spin.setMaximum(10)
        concurrent_row.addWidget(self.concurrent_spin)
        concurrent_row.addStretch()
        download_layout.addLayout(concurrent_row)

        speed_row = QHBoxLayout()
        speed_row.setSpacing(12)
        speed_row.addWidget(QLabel("速度限制（KB/s，0 表示不限速）"))
        self.speed_spin = QSpinBox()
        self.speed_spin.setMinimum(0)
        self.speed_spin.setMaximum(100000)
        self.speed_spin.setSingleStep(100)
        speed_row.addWidget(self.speed_spin)
        speed_row.addStretch()
        download_layout.addLayout(speed_row)

        quality_row = QHBoxLayout()
        quality_row.setSpacing(12)
        quality_row.addWidget(QLabel("默认质量"))
        self.quality_combo = combo_box_cls()
        self.quality_combo.addItems(["best", "1080p", "720p", "480p", "360p"])
        quality_row.addWidget(self.quality_combo)
        quality_row.addStretch()
        download_layout.addLayout(quality_row)

        self.subtitle_check = QCheckBox("自动下载字幕")
        download_layout.addWidget(self.subtitle_check)

        layout.addWidget(download_card)

        proxy_card = SectionCard("网络设置", "代理和网络相关选项。")
        proxy_layout = proxy_card.body_layout

        self.proxy_enable_check = QCheckBox("启用代理")
        proxy_layout.addWidget(self.proxy_enable_check)

        proxy_row = QHBoxLayout()
        proxy_row.setSpacing(12)
        proxy_row.addWidget(QLabel("代理地址"))
        self.proxy_input = line_edit_cls()
        self.proxy_input.setPlaceholderText("http://127.0.0.1:7890")
        proxy_row.addWidget(self.proxy_input, 1)
        proxy_layout.addLayout(proxy_row)

        proxy_hint = BodyLabel("启用代理后，搜索和下载请求都会走配置的代理地址。")
        proxy_hint.setObjectName("PageHint")
        proxy_layout.addWidget(proxy_hint)

        layout.addWidget(proxy_card)

        appearance_card = SectionCard("外观设置", "切换应用主题，让浅色与深色都保持完成度。")
        appearance_layout = appearance_card.body_layout

        theme_row = QHBoxLayout()
        theme_row.setSpacing(12)
        theme_row.addWidget(QLabel("主题模式"))
        self.theme_combo = combo_box_cls()
        # 将主题模式放入 userData，避免 Fluent ComboBox 将字符串误当图标名。
        self.theme_combo.addItem("跟随系统", userData="system")
        self.theme_combo.addItem("浅色", userData="light")
        self.theme_combo.addItem("深色", userData="dark")
        theme_row.addWidget(self.theme_combo)
        theme_row.addStretch()
        appearance_layout.addLayout(theme_row)

        self.theme_badge = StatusBadge("跟随系统", "primary")
        appearance_layout.addWidget(self.theme_badge)

        appearance_hint = BodyLabel("更改主题后会立即生效，并在下次启动时保持。")
        appearance_hint.setObjectName("PageHint")
        appearance_layout.addWidget(appearance_hint)

        layout.addWidget(appearance_card)

        btn_row = QHBoxLayout()
        btn_row.addStretch()
        self.save_btn = primary_button_cls("保存设置")
        self.save_btn.setObjectName("primaryActionButton")
        self.save_btn.clicked.connect(self.save_settings)
        btn_row.addWidget(self.save_btn)
        layout.addLayout(btn_row)

        layout.addStretch()
        self.setLayout(layout)

    def refresh_overview(self):
        """刷新顶部摘要。"""

        theme_mode = self._theme_label(
            self.theme_combo.currentData() or self.config.get_theme_mode()
        )
        download_dir = self.dir_input.text().strip() or self.config.get_download_dir()
        concurrent = (
            self.concurrent_spin.value()
            if hasattr(self, "concurrent_spin")
            else self.config.get_concurrent_downloads()
        )
        self.header.set_metrics(
            [
                ("主题", theme_mode, "当前界面模式"),
                ("下载目录", self._short_path(download_dir), "当前保存路径"),
                ("并发", str(concurrent), "同时任务数"),
            ]
        )
        self.theme_badge.setText(theme_mode)
        self.theme_badge.setTone("primary")

    def load_settings(self):
        """加载设置。"""

        self.dir_input.setText(self.config.get_download_dir())
        self.concurrent_spin.setValue(self.config.get_concurrent_downloads())
        self.speed_spin.setValue(self.config.get_speed_limit() // 1024)
        self.quality_combo.setCurrentText(self.config.get_default_quality())
        self.subtitle_check.setChecked(self.config.is_download_subtitles())
        self.proxy_enable_check.setChecked(self.config.is_proxy_enabled())
        self.proxy_input.setText(self.config.get_proxy_url())
        self._set_theme_combo(self.config.get_theme_mode())

    def save_settings(self):
        """保存设置。"""

        theme_mode = self.theme_combo.currentData() or "system"
        self.config.set_download_dir(self.dir_input.text())
        self.config.set_concurrent_downloads(self.concurrent_spin.value())
        self.config.set_speed_limit(self.speed_spin.value() * 1024)
        self.config.set_default_quality(self.quality_combo.currentText())
        self.config.set_download_subtitles(self.subtitle_check.isChecked())
        self.config.set_proxy_enabled(self.proxy_enable_check.isChecked())
        self.config.set_proxy_url(self.proxy_input.text())
        self.config.set_theme_mode(theme_mode)

        self.refresh_overview()
        self.theme_changed.emit(theme_mode)
        self.settings_saved.emit()

        QMessageBox.information(self, "设置已保存", "设置已保存")
        logger.info("设置已保存")

    def choose_directory(self):
        """选择下载目录。"""

        dir_path = QFileDialog.getExistingDirectory(self, "选择下载目录")
        if dir_path:
            self.dir_input.setText(dir_path)
            self.refresh_overview()

    def _set_theme_combo(self, mode: str) -> None:
        for index in range(self.theme_combo.count()):
            if self.theme_combo.itemData(index) == mode:
                self.theme_combo.setCurrentIndex(index)
                break

    def _theme_label(self, mode: str) -> str:
        mapping = {
            "system": "跟随系统",
            "light": "浅色",
            "dark": "深色",
        }
        return mapping.get(mode, "跟随系统")

    def _short_path(self, path: str) -> str:
        if not path:
            return "-"
        normalized = path.rstrip("/")
        if len(normalized) <= 34:
            return normalized
        head = normalized[:14]
        tail = normalized[-16:]
        return f"{head}…{tail}"
