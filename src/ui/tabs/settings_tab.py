"""
设置标签页，配置下载参数。
"""
from PyQt6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel,
    QLineEdit, QPushButton, QSpinBox, QCheckBox,
    QGroupBox, QFileDialog, QMessageBox, QComboBox
)
from src.data.config_manager import ConfigManager
from src.ui.fluent_support import get_fluent_widget
from src.utils.logger import setup_logger

logger = setup_logger("SettingsTab")


class SettingsTab(QWidget):
    """设置标签页"""

    def __init__(self):
        super().__init__()
        self.config = ConfigManager()
        self.init_ui()
        self.load_settings()

    def init_ui(self):
        line_edit_cls = get_fluent_widget("LineEdit") or QLineEdit
        push_button_cls = get_fluent_widget("PushButton") or QPushButton
        primary_button_cls = get_fluent_widget("PrimaryPushButton") or push_button_cls
        combo_box_cls = get_fluent_widget("ComboBox") or QComboBox

        layout = QVBoxLayout()
        layout.setSpacing(15)

        # 下载设置
        download_group = QGroupBox("下载设置")
        download_layout = QVBoxLayout()

        # 下载目录
        dir_layout = QHBoxLayout()
        dir_layout.addWidget(QLabel("下载目录:"))
        self.dir_input = line_edit_cls()
        dir_layout.addWidget(self.dir_input)
        self.dir_btn = push_button_cls("选择")
        self.dir_btn.clicked.connect(self.choose_directory)
        dir_layout.addWidget(self.dir_btn)
        download_layout.addLayout(dir_layout)

        # 并发下载数
        concurrent_layout = QHBoxLayout()
        concurrent_layout.addWidget(QLabel("并发下载数:"))
        self.concurrent_spin = QSpinBox()
        self.concurrent_spin.setMinimum(1)
        self.concurrent_spin.setMaximum(10)
        concurrent_layout.addWidget(self.concurrent_spin)
        concurrent_layout.addStretch()
        download_layout.addLayout(concurrent_layout)

        # 速度限制
        speed_layout = QHBoxLayout()
        speed_layout.addWidget(QLabel("速度限制 (KB/s, 0=无限制):"))
        self.speed_spin = QSpinBox()
        self.speed_spin.setMinimum(0)
        self.speed_spin.setMaximum(100000)
        self.speed_spin.setSingleStep(100)
        speed_layout.addWidget(self.speed_spin)
        speed_layout.addStretch()
        download_layout.addLayout(speed_layout)

        # 默认质量
        quality_layout = QHBoxLayout()
        quality_layout.addWidget(QLabel("默认质量:"))
        self.quality_combo = combo_box_cls()
        self.quality_combo.addItems(["best", "1080p", "720p", "480p", "360p"])
        quality_layout.addWidget(self.quality_combo)
        quality_layout.addStretch()
        download_layout.addLayout(quality_layout)

        # 字幕下载
        self.subtitle_check = QCheckBox("自动下载字幕")
        download_layout.addWidget(self.subtitle_check)

        download_group.setLayout(download_layout)
        layout.addWidget(download_group)

        # 代理设置
        proxy_group = QGroupBox("代理设置")
        proxy_layout = QVBoxLayout()

        self.proxy_enable_check = QCheckBox("启用代理")
        proxy_layout.addWidget(self.proxy_enable_check)

        proxy_url_layout = QHBoxLayout()
        proxy_url_layout.addWidget(QLabel("代理地址:"))
        self.proxy_input = line_edit_cls()
        self.proxy_input.setPlaceholderText("http://127.0.0.1:7890")
        proxy_url_layout.addWidget(self.proxy_input)
        proxy_layout.addLayout(proxy_url_layout)

        proxy_group.setLayout(proxy_layout)
        layout.addWidget(proxy_group)

        # 保存按钮
        btn_layout = QHBoxLayout()
        btn_layout.addStretch()
        self.save_btn = primary_button_cls("保存设置")
        self.save_btn.clicked.connect(self.save_settings)
        btn_layout.addWidget(self.save_btn)
        layout.addLayout(btn_layout)

        layout.addStretch()
        self.setLayout(layout)

    def load_settings(self):
        """加载设置"""
        self.dir_input.setText(self.config.get_download_dir())
        self.concurrent_spin.setValue(self.config.get_concurrent_downloads())
        self.speed_spin.setValue(self.config.get_speed_limit() // 1024)  # 转换为 KB/s
        self.quality_combo.setCurrentText(self.config.get_default_quality())
        self.subtitle_check.setChecked(self.config.is_download_subtitles())
        self.proxy_enable_check.setChecked(self.config.is_proxy_enabled())
        self.proxy_input.setText(self.config.get_proxy_url())

    def save_settings(self):
        """保存设置"""
        self.config.set_download_dir(self.dir_input.text())
        self.config.set_concurrent_downloads(self.concurrent_spin.value())
        self.config.set_speed_limit(self.speed_spin.value() * 1024)  # 转换为 bytes/s
        self.config.set_default_quality(self.quality_combo.currentText())
        self.config.set_download_subtitles(self.subtitle_check.isChecked())
        self.config.set_proxy_enabled(self.proxy_enable_check.isChecked())
        self.config.set_proxy_url(self.proxy_input.text())

        QMessageBox.information(self, "成功", "设置已保存")
        logger.info("设置已保存")

    def choose_directory(self):
        """选择下载目录"""
        dir_path = QFileDialog.getExistingDirectory(self, "选择下载目录")
        if dir_path:
            self.dir_input.setText(dir_path)
