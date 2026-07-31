"""
qfluentwidgets 的兼容探测、安全导入与基础初始化。
"""
from __future__ import annotations

from importlib.metadata import PackageNotFoundError, version
from typing import Any, Optional

from src.ui.styles.theme import ThemeMode, Theme

_QFW_MODULE: Any = None
_QFW_CHECKED = False


def has_pyqt6_fluent_widgets() -> bool:
    """检查是否安装了 PyQt6 版 Fluent Widgets。"""

    try:
        version("PyQt6-Fluent-Widgets")
        return True
    except PackageNotFoundError:
        return False


def reset_fluent_cache() -> None:
    """测试或热重载时重置 Fluent 缓存。"""
    global _QFW_MODULE, _QFW_CHECKED
    _QFW_MODULE = None
    _QFW_CHECKED = False


def import_qfluentwidgets():
    """安全导入 qfluentwidgets；结果模块级缓存。"""

    global _QFW_MODULE, _QFW_CHECKED
    if _QFW_CHECKED:
        return _QFW_MODULE

    _QFW_CHECKED = True
    if not has_pyqt6_fluent_widgets():
        _QFW_MODULE = None
        return None

    try:
        import qfluentwidgets as qfw  # type: ignore

        _QFW_MODULE = qfw
        return qfw
    except Exception:
        _QFW_MODULE = None
        return None


def setup_fluent_app(_app, theme_mode: Optional[str] = None) -> bool:
    """尝试初始化 Fluent 主题。"""

    qfw = import_qfluentwidgets()
    if qfw is None:
        return False

    try:
        resolved_mode = Theme.resolve_mode(theme_mode)
        theme_enum = getattr(qfw, "Theme", None)
        if theme_enum is not None:
            if resolved_mode == ThemeMode.DARK and hasattr(theme_enum, "DARK"):
                qfw.setTheme(theme_enum.DARK)
            elif resolved_mode == ThemeMode.LIGHT and hasattr(theme_enum, "LIGHT"):
                qfw.setTheme(theme_enum.LIGHT)
            elif hasattr(theme_enum, "AUTO"):
                qfw.setTheme(theme_enum.AUTO)

        if hasattr(qfw, "setThemeColor"):
            qfw.setThemeColor(Theme.PRIMARY)
        return True
    except Exception:
        return False


def get_fluent_widget(widget_name: str):
    """获取 qfluentwidgets 控件类。"""

    qfw = import_qfluentwidgets()
    if qfw is None:
        return None
    return getattr(qfw, widget_name, None)
