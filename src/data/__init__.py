"""数据层：历史库与模型（配置见 JsonConfig，无 Qt 依赖）。"""
from src.data.database import HistoryDB
from src.data.models import DownloadRecord, SearchRecord

__all__ = ["HistoryDB", "DownloadRecord", "SearchRecord"]
