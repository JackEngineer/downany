"""
历史记录数据库管理。
使用 SQLite 存储下载历史和搜索历史。
"""
import sqlite3
import os
from typing import List, Optional
from datetime import datetime
from src.data.models import DownloadRecord, SearchRecord
from src.utils.logger import setup_logger

logger = setup_logger("Database")


class HistoryDB:
    """历史记录数据库单例类"""
    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._initialized = False
        return cls._instance

    def __init__(self):
        if self._initialized:
            return

        self._initialized = True

        # 数据库路径
        db_dir = os.path.join(os.path.expanduser("~"), ".trae_downloader")
        os.makedirs(db_dir, exist_ok=True)
        self.db_path = os.path.join(db_dir, "history.db")

        # 初始化数据库
        self._init_database()
        logger.info(f"数据库初始化完成: {self.db_path}")

    def _get_connection(self) -> sqlite3.Connection:
        """获取数据库连接"""
        conn = sqlite3.Connection(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_database(self):
        """初始化数据库表结构"""
        conn = self._get_connection()
        cursor = conn.cursor()

        # 创建下载历史表
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS download_history (
                id TEXT PRIMARY KEY,
                url TEXT NOT NULL,
                title TEXT NOT NULL,
                platform TEXT NOT NULL,
                duration INTEGER,
                thumbnail_url TEXT,
                uploader TEXT,
                status TEXT NOT NULL,
                file_path TEXT,
                file_size INTEGER,
                created_at TEXT NOT NULL,
                started_at TEXT,
                completed_at TEXT,
                error_message TEXT
            )
        """)

        # 创建搜索历史表
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS search_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                platform TEXT NOT NULL,
                query TEXT NOT NULL,
                searched_at TEXT NOT NULL
            )
        """)

        conn.commit()
        conn.close()

    def add_download_record(self, record: DownloadRecord):
        """添加下载记录"""
        conn = self._get_connection()
        cursor = conn.cursor()

        cursor.execute("""
            INSERT OR REPLACE INTO download_history
            (id, url, title, platform, duration, thumbnail_url, uploader,
             status, file_path, file_size, created_at, started_at, completed_at, error_message)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            record.id, record.url, record.title, record.platform,
            record.duration, record.thumbnail_url, record.uploader,
            record.status, record.file_path, record.file_size,
            record.created_at.isoformat(),
            record.started_at.isoformat() if record.started_at else None,
            record.completed_at.isoformat() if record.completed_at else None,
            record.error_message
        ))

        conn.commit()
        conn.close()
        logger.info(f"添加下载记录: {record.title}")

    def get_all_download_records(self, limit: int = 100) -> List[DownloadRecord]:
        """获取所有下载记录"""
        conn = self._get_connection()
        cursor = conn.cursor()

        cursor.execute("""
            SELECT * FROM download_history
            ORDER BY created_at DESC
            LIMIT ?
        """, (limit,))

        records = []
        for row in cursor.fetchall():
            records.append(DownloadRecord(
                id=row['id'],
                url=row['url'],
                title=row['title'],
                platform=row['platform'],
                duration=row['duration'],
                thumbnail_url=row['thumbnail_url'],
                uploader=row['uploader'],
                status=row['status'],
                file_path=row['file_path'],
                file_size=row['file_size'],
                created_at=datetime.fromisoformat(row['created_at']),
                started_at=datetime.fromisoformat(row['started_at']) if row['started_at'] else None,
                completed_at=datetime.fromisoformat(row['completed_at']) if row['completed_at'] else None,
                error_message=row['error_message']
            ))

        conn.close()
        return records

    def search_download_records(self, query: str, limit: int = 100) -> List[DownloadRecord]:
        """搜索下载记录"""
        conn = self._get_connection()
        cursor = conn.cursor()

        cursor.execute("""
            SELECT * FROM download_history
            WHERE title LIKE ? OR url LIKE ? OR uploader LIKE ?
            ORDER BY created_at DESC
            LIMIT ?
        """, (f'%{query}%', f'%{query}%', f'%{query}%', limit))

        records = []
        for row in cursor.fetchall():
            records.append(DownloadRecord(
                id=row['id'],
                url=row['url'],
                title=row['title'],
                platform=row['platform'],
                duration=row['duration'],
                thumbnail_url=row['thumbnail_url'],
                uploader=row['uploader'],
                status=row['status'],
                file_path=row['file_path'],
                file_size=row['file_size'],
                created_at=datetime.fromisoformat(row['created_at']),
                started_at=datetime.fromisoformat(row['started_at']) if row['started_at'] else None,
                completed_at=datetime.fromisoformat(row['completed_at']) if row['completed_at'] else None,
                error_message=row['error_message']
            ))

        conn.close()
        return records

    def delete_download_record(self, record_id: str):
        """删除下载记录"""
        conn = self._get_connection()
        cursor = conn.cursor()

        cursor.execute("DELETE FROM download_history WHERE id = ?", (record_id,))

        conn.commit()
        conn.close()
        logger.info(f"删除下载记录: {record_id}")

    def add_search_record(self, platform: str, query: str):
        """添加搜索记录"""
        conn = self._get_connection()
        cursor = conn.cursor()

        cursor.execute("""
            INSERT INTO search_history (platform, query, searched_at)
            VALUES (?, ?, ?)
        """, (platform, query, datetime.now().isoformat()))

        conn.commit()
        conn.close()

    def get_recent_searches(self, limit: int = 20) -> List[SearchRecord]:
        """获取最近的搜索记录"""
        conn = self._get_connection()
        cursor = conn.cursor()

        cursor.execute("""
            SELECT * FROM search_history
            ORDER BY searched_at DESC
            LIMIT ?
        """, (limit,))

        records = []
        for row in cursor.fetchall():
            records.append(SearchRecord(
                id=row['id'],
                platform=row['platform'],
                query=row['query'],
                searched_at=datetime.fromisoformat(row['searched_at'])
            ))

        conn.close()
        return records
