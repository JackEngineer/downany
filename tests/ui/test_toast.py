"""Toast 组件测试。"""
import os
from pathlib import Path

import PyQt6
from PyQt6.QtWidgets import QApplication, QWidget

from src.ui.components.toast import ToastService

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault(
    "QT_QPA_PLATFORM_PLUGIN_PATH",
    str(Path(PyQt6.__file__).resolve().parent / "Qt6" / "plugins" / "platforms"),
)

APP = QApplication.instance() or QApplication([])


def test_toast_service_legacy_success():
    parent = QWidget()
    toast = ToastService(parent, use_fluent=False)
    toast.show_success("完成", "任务已加入队列")
    toast._hide_legacy()
