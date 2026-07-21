"""
设置标签页，配置下载参数（即时保存）。
"""
from __future__ import annotations

import os
import urllib.error
import urllib.request
from typing import Optional

from PyQt6.QtCore import QThread, QTimer, pyqtSignal
from PyQt6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QFileDialog,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPushButton,
    QSpinBox,
    QVBoxLayout,
    QWidget,
)

from src.data.config_manager import ConfigManager
from src.ui.components.chrome import BodyLabel, PageHeader, SectionCard, StatusBadge
from src.ui.components.toast import ToastService
from src.ui.fluent_support import get_fluent_widget
from src.utils.logger import setup_logger

logger = setup_logger("SettingsTab")


class _ProxyTestThread(QThread):
    finished_signal = pyqtSignal(bool, str)

    def __init__(self, proxy_url: str, parent=None):
        super().__init__(parent)
        self.proxy_url = proxy_url

    def run(self):
        try:
            handler = urllib.request.ProxyHandler({"http": self.proxy_url, "https": self.proxy_url})
            opener = urllib.request.build_opener(handler)
            with opener.open("https://www.google.com/generate_204", timeout=8) as response:
                if response.status in (200, 204):
                    self.finished_signal.emit(True, "代理连接正常")
                    return
            self.finished_signal.emit(False, f"意外状态码: {response.status}")
        except Exception as exc:
            self.finished_signal.emit(False, str(exc))


class SettingsTab(QWidget):
    """设置标签页。"""

    theme_changed = pyqtSignal(str)
    settings_saved = pyqtSignal()

    def __init__(self, toast: ToastService | None = None):
        super().__init__()
        self.config = ConfigManager()
        self.toast = toast
        self._loading = False
        self._proxy_test_thread: Optional[_ProxyTestThread] = None
        self._save_timer = QTimer(self)
        self._save_timer.setSingleShot(True)
        self._save_timer.setInterval(300)
        self._save_timer.timeout.connect(self._flush_deferred_save)
        self._pending_save = False
        self.init_ui()
        self.load_settings()
        self.refresh_overview()

    def init_ui(self):
        line_edit_cls = get_fluent_widget("LineEdit") or QLineEdit
        push_button_cls = get_fluent_widget("PushButton") or QPushButton
        combo_box_cls = get_fluent_widget("ComboBox") or QComboBox

        layout = QVBoxLayout()
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(18)

        self.header = PageHeader(
            "偏好设置",
            "调整下载目录、并发、代理和界面主题，更改会即时保存。",
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
        self.dir_input.setToolTip("视频文件保存位置")
        self.dir_input.textChanged.connect(self._schedule_save)
        dir_row.addWidget(self.dir_input, 1)
        self.dir_btn = push_button_cls("选择")
        self.dir_btn.clicked.connect(self.choose_directory)
        dir_row.addWidget(self.dir_btn)
        download_layout.addLayout(dir_row)

        self.dir_error_label = BodyLabel("")
        self.dir_error_label.setObjectName("PageHint")
        self.dir_error_label.hide()
        download_layout.addWidget(self.dir_error_label)

        concurrent_row = QHBoxLayout()
        concurrent_row.setSpacing(12)
        concurrent_row.addWidget(QLabel("并发下载数"))
        self.concurrent_spin = QSpinBox()
        self.concurrent_spin.setMinimum(1)
        self.concurrent_spin.setMaximum(10)
        self.concurrent_spin.setToolTip("同时进行的下载任务数量")
        self.concurrent_spin.valueChanged.connect(self._schedule_save)
        concurrent_row.addWidget(self.concurrent_spin)
        concurrent_row.addStretch()
        download_layout.addLayout(concurrent_row)

        speed_row = QHBoxLayout()
        speed_row.setSpacing(12)
        speed_row.addWidget(QLabel("速度限制"))
        self.speed_spin = QSpinBox()
        self.speed_spin.setMinimum(0)
        self.speed_spin.setMaximum(100000)
        self.speed_spin.setSingleStep(100)
        self.speed_spin.setToolTip("0 表示不限速，单位为 KB/s")
        self.speed_spin.valueChanged.connect(self._schedule_save)
        speed_row.addWidget(self.speed_spin)
        speed_row.addWidget(QLabel("KB/s"))
        speed_row.addStretch()
        download_layout.addLayout(speed_row)

        quality_row = QHBoxLayout()
        quality_row.setSpacing(12)
        quality_row.addWidget(QLabel("默认质量"))
        self.quality_combo = combo_box_cls()
        self.quality_combo.addItems(["best", "1080p", "720p", "480p", "360p"])
        self.quality_combo.currentTextChanged.connect(self._schedule_save)
        quality_row.addWidget(self.quality_combo)
        quality_row.addStretch()
        download_layout.addLayout(quality_row)

        self.subtitle_check = QCheckBox("自动下载字幕")
        self.subtitle_check.setToolTip("新任务默认附带字幕下载")
        self.subtitle_check.toggled.connect(self._schedule_save)
        download_layout.addWidget(self.subtitle_check)

        layout.addWidget(download_card)

        proxy_card = SectionCard("网络设置", "代理和网络相关选项。")
        proxy_layout = proxy_card.body_layout

        self.proxy_enable_check = QCheckBox("启用代理")
        self.proxy_enable_check.toggled.connect(self._schedule_save)
        proxy_layout.addWidget(self.proxy_enable_check)

        proxy_row = QHBoxLayout()
        proxy_row.setSpacing(12)
        proxy_row.addWidget(QLabel("代理地址"))
        self.proxy_input = line_edit_cls()
        self.proxy_input.setPlaceholderText("http://127.0.0.1:7890")
        self.proxy_input.setToolTip("HTTP/HTTPS 代理地址")
        self.proxy_input.textChanged.connect(self._schedule_save)
        proxy_row.addWidget(self.proxy_input, 1)
        self.proxy_test_btn = push_button_cls("测试连接")
        self.proxy_test_btn.setObjectName("ghostActionButton")
        self.proxy_test_btn.clicked.connect(self.test_proxy)
        proxy_row.addWidget(self.proxy_test_btn)
        proxy_layout.addLayout(proxy_row)

        self.proxy_error_label = BodyLabel("")
        self.proxy_error_label.setObjectName("PageHint")
        self.proxy_error_label.hide()
        proxy_layout.addWidget(self.proxy_error_label)

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
        self.theme_combo.addItem("跟随系统", userData="system")
        self.theme_combo.addItem("浅色", userData="light")
        self.theme_combo.addItem("深色", userData="dark")
        self.theme_combo.currentIndexChanged.connect(self._on_theme_changed)
        theme_row.addWidget(self.theme_combo)
        theme_row.addStretch()
        appearance_layout.addLayout(theme_row)

        self.theme_badge = StatusBadge("跟随系统", "primary")
        appearance_layout.addWidget(self.theme_badge)

        appearance_hint = BodyLabel("主题更改会立即生效并自动保存。")
        appearance_hint.setObjectName("PageHint")
        appearance_layout.addWidget(appearance_hint)

        layout.addWidget(appearance_card)

        btn_row = QHBoxLayout()
        self.reset_btn = push_button_cls("恢复默认")
        self.reset_btn.setObjectName("ghostActionButton")
        self.reset_btn.clicked.connect(self.reset_defaults)
        btn_row.addWidget(self.reset_btn)
        btn_row.addStretch()
        layout.addLayout(btn_row)

        layout.addStretch()
        self.setLayout(layout)

    def _schedule_save(self, *_args):
        if self._loading:
            return
        self._pending_save = True
        if not self._save_timer.isActive():
            self._save_timer.start()

    def _flush_deferred_save(self):
        if not self._pending_save:
            return
        self._pending_save = False
        self.save_settings(show_toast=False)

    def _on_theme_changed(self, *_args):
        if self._loading:
            return
        theme_mode = self.theme_combo.currentData() or "system"
        self.config.set_theme_mode(theme_mode)
        self.theme_changed.emit(theme_mode)
        self.refresh_overview()
        self.settings_saved.emit()

    def refresh_overview(self):
        theme_mode = self._theme_label(
            self.theme_combo.currentData() or self.config.get_theme_mode()
        )
        download_dir = self.dir_input.text().strip() or self.config.get_download_dir()
        concurrent = self.concurrent_spin.value()
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
        self._loading = True
        self.dir_input.setText(self.config.get_download_dir())
        self.concurrent_spin.setValue(self.config.get_concurrent_downloads())
        self.speed_spin.setValue(self.config.get_speed_limit() // 1024)
        self.quality_combo.setCurrentText(self.config.get_default_quality())
        self.subtitle_check.setChecked(self.config.is_download_subtitles())
        self.proxy_enable_check.setChecked(self.config.is_proxy_enabled())
        self.proxy_input.setText(self.config.get_proxy_url())
        self._set_theme_combo(self.config.get_theme_mode())
        self._loading = False

    def save_settings(self, show_toast: bool = False):
        if not self._validate_inputs():
            return False

        self.config.set_download_dir(self.dir_input.text().strip())
        self.config.set_concurrent_downloads(self.concurrent_spin.value())
        self.config.set_speed_limit(self.speed_spin.value() * 1024)
        self.config.set_default_quality(self.quality_combo.currentText())
        self.config.set_download_subtitles(self.subtitle_check.isChecked())
        self.config.set_proxy_enabled(self.proxy_enable_check.isChecked())
        self.config.set_proxy_url(self.proxy_input.text().strip())
        theme_mode = self.theme_combo.currentData() or "system"
        self.config.set_theme_mode(theme_mode)

        self.refresh_overview()
        self.theme_changed.emit(theme_mode)
        self.settings_saved.emit()
        logger.info("设置已保存")
        if show_toast and self.toast:
            self.toast.show_success("设置已保存", "偏好已更新")
        return True

    def _validate_inputs(self) -> bool:
        valid = True
        download_dir = self.dir_input.text().strip()
        if not download_dir:
            self.dir_error_label.setText("下载目录不能为空")
            self.dir_error_label.show()
            valid = False
        else:
            parent = download_dir
            if not os.path.isdir(parent):
                parent = os.path.dirname(parent) or "."
            if not os.path.isdir(parent) and not os.path.exists(os.path.dirname(parent) or "."):
                self.dir_error_label.setText("下载目录路径无效")
                self.dir_error_label.show()
                valid = False
            else:
                self.dir_error_label.hide()

        if self.proxy_enable_check.isChecked():
            proxy = self.proxy_input.text().strip()
            if proxy and not proxy.startswith(("http://", "https://", "socks5://")):
                self.proxy_error_label.setText("代理地址需以 http://、https:// 或 socks5:// 开头")
                self.proxy_error_label.show()
                valid = False
            else:
                self.proxy_error_label.hide()
        else:
            self.proxy_error_label.hide()

        return valid

    def choose_directory(self):
        dir_path = QFileDialog.getExistingDirectory(self, "选择下载目录")
        if dir_path:
            self.dir_input.setText(dir_path)
            self._schedule_save()

    def test_proxy(self):
        proxy = self.proxy_input.text().strip()
        if not proxy:
            if self.toast:
                self.toast.show_warning("需要代理地址", "请先填写代理地址")
            return
        if self._proxy_test_thread and self._proxy_test_thread.isRunning():
            return
        self.proxy_test_btn.setEnabled(False)
        self.proxy_test_btn.setText("测试中…")
        self._proxy_test_thread = _ProxyTestThread(proxy, self)
        self._proxy_test_thread.finished_signal.connect(self._on_proxy_test_finished)
        self._proxy_test_thread.start()

    def _on_proxy_test_finished(self, ok: bool, message: str):
        self.proxy_test_btn.setEnabled(True)
        self.proxy_test_btn.setText("测试连接")
        if not self.toast:
            return
        if ok:
            self.toast.show_success("代理可用", message)
        else:
            self.toast.show_error("代理不可用", message[:200])

    def reset_defaults(self):
        self.config.reset_to_defaults()
        self.load_settings()
        self.save_settings(show_toast=True)

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
