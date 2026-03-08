"""
qfluentwidgets 的兼容探测、安全导入与基础初始化。

仅当安装的是 PyQt6 版本的 Fluent Widgets 时才允许启用，
避免与 PyQt6 主程序混用 PyQt5 绑定导致崩溃。
"""
from importlib.metadata import PackageNotFoundError, version


def has_pyqt6_fluent_widgets() -> bool:
    """检查是否安装了 PyQt6 版 Fluent Widgets"""
    try:
        version("PyQt6-Fluent-Widgets")
        return True
    except PackageNotFoundError:
        return False


def import_qfluentwidgets():
    """
    安全导入 qfluentwidgets。
    返回模块对象；若不可用或导入失败则返回 None。
    """
    if not has_pyqt6_fluent_widgets():
        return None

    try:
        import qfluentwidgets as qfw  # type: ignore
        return qfw
    except Exception:
        return None


def setup_fluent_app(_app) -> bool:
    """
    尝试初始化 Fluent 主题。
    返回 True 代表 Fluent 可用且初始化成功；否则返回 False。
    """
    qfw = import_qfluentwidgets()
    if qfw is None:
        return False

    try:
        theme_enum = getattr(qfw, "Theme", None)
        if theme_enum is not None and hasattr(theme_enum, "AUTO"):
            qfw.setTheme(theme_enum.AUTO)
        elif theme_enum is not None and hasattr(theme_enum, "LIGHT"):
            qfw.setTheme(theme_enum.LIGHT)

        if hasattr(qfw, "setThemeColor"):
            qfw.setThemeColor("#4A90E2")
        return True
    except Exception:
        return False


def get_fluent_widget(widget_name: str):
    """
    获取 qfluentwidgets 中的控件类。
    若 Fluent 不可用或不存在该控件，返回 None。
    """
    qfw = import_qfluentwidgets()
    if qfw is None:
        return None
    return getattr(qfw, widget_name, None)
