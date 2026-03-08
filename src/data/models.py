"""
数据库模型定义。
"""
from dataclasses import dataclass
from typing import Optional
from datetime import datetime


@dataclass
class DownloadRecord:
    """下载历史记录"""
    id: str
    url: str
    title: str
    platform: str
    duration: int
    thumbnail_url: str
    uploader: str
    status: str
    file_path: str
    file_size: int
    created_at: datetime
    started_at: Optional[datetime]
    completed_at: Optional[datetime]
    error_message: str


@dataclass
class SearchRecord:
    """搜索历史记录"""
    id: int
    platform: str
    query: str
    searched_at: datetime
