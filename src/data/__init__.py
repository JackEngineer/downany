"""
数据层模块初始化。

注意：不要在此急切导入 ConfigManager（依赖 PyQt6）。
Electron Sidecar 会经 `src.data.models` 加载本包，急切导入会导致
无 Qt 的 PyInstaller 包启动失败（ModuleNotFoundError: PyQt6）。
"""
from src.data.database import HistoryDB
from src.data.models import DownloadRecord, SearchRecord

__all__ = ["HistoryDB", "DownloadRecord", "SearchRecord", "ConfigManager"]


def __getattr__(name: str):
    if name == "ConfigManager":
        from src.data.config_manager import ConfigManager

        return ConfigManager
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
