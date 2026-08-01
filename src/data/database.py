"""
历史记录数据库管理。
使用 SQLite 存储下载历史和搜索历史。
"""
import os
import sqlite3
from datetime import datetime
from typing import List, Optional

from src.data.models import DownloadRecord, SearchRecord
from src.utils.logger import setup_logger

logger = setup_logger("Database")


class HistoryDB:
    """历史记录数据库单例类"""

    _instance = None

    def __new__(cls, *args, **kwargs):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._initialized = False
        return cls._instance

    def __init__(self, db_path: Optional[str] = None):
        if self._initialized and db_path is None:
            return

        if db_path is not None:
            # 测试可注入路径；允许重新指向
            self.db_path = db_path
            self._initialized = True
            os.makedirs(os.path.dirname(self.db_path) or ".", exist_ok=True)
            self._init_database()
            return

        self._initialized = True
        # 与 Sidecar AppPaths 默认一致；生产路径应显式传入 db_path
        db_dir = os.path.join(
            os.path.expanduser("~"),
            "Library",
            "Application Support",
            "VideoDownloader",
        )
        os.makedirs(db_dir, exist_ok=True)
        self.db_path = os.path.join(db_dir, "history.db")
        self._init_database()
        logger.info(f"数据库初始化完成: {self.db_path}")

    def _get_connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout=5000")
        conn.execute("PRAGMA journal_mode=WAL")
        return conn

    def _init_database(self):
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
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
                """
            )
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS search_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    platform TEXT NOT NULL,
                    query TEXT NOT NULL,
                    searched_at TEXT NOT NULL
                )
                """
            )
            conn.commit()

    @staticmethod
    def _row_to_record(row: sqlite3.Row) -> DownloadRecord:
        return DownloadRecord(
            id=row["id"],
            url=row["url"],
            title=row["title"],
            platform=row["platform"],
            duration=row["duration"] or 0,
            thumbnail_url=row["thumbnail_url"] or "",
            uploader=row["uploader"] or "",
            status=row["status"],
            file_path=row["file_path"] or "",
            file_size=row["file_size"] or 0,
            created_at=datetime.fromisoformat(row["created_at"]),
            started_at=datetime.fromisoformat(row["started_at"]) if row["started_at"] else None,
            completed_at=datetime.fromisoformat(row["completed_at"]) if row["completed_at"] else None,
            error_message=row["error_message"] or "",
        )

    def add_download_record(self, record: DownloadRecord):
        with self._get_connection() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO download_history
                (id, url, title, platform, duration, thumbnail_url, uploader,
                 status, file_path, file_size, created_at, started_at, completed_at, error_message)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record.id,
                    record.url,
                    record.title,
                    record.platform,
                    record.duration,
                    record.thumbnail_url,
                    record.uploader,
                    record.status,
                    record.file_path,
                    record.file_size,
                    record.created_at.isoformat(),
                    record.started_at.isoformat() if record.started_at else None,
                    record.completed_at.isoformat() if record.completed_at else None,
                    record.error_message,
                ),
            )
            conn.commit()
        logger.info(f"添加下载记录: {record.title}")

    def get_all_download_records(self, limit: int = 100) -> List[DownloadRecord]:
        with self._get_connection() as conn:
            cursor = conn.execute(
                """
                SELECT * FROM download_history
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (limit,),
            )
            return [self._row_to_record(row) for row in cursor.fetchall()]

    def search_download_records(self, query: str, limit: int = 100) -> List[DownloadRecord]:
        with self._get_connection() as conn:
            cursor = conn.execute(
                """
                SELECT * FROM download_history
                WHERE title LIKE ? OR url LIKE ? OR uploader LIKE ?
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (f"%{query}%", f"%{query}%", f"%{query}%", limit),
            )
            return [self._row_to_record(row) for row in cursor.fetchall()]

    def delete_download_record(self, record_id: str):
        with self._get_connection() as conn:
            conn.execute("DELETE FROM download_history WHERE id = ?", (record_id,))
            conn.commit()
        logger.info(f"删除下载记录: {record_id}")

    def delete_download_records(self, record_ids: List[str]) -> int:
        if not record_ids:
            return 0
        with self._get_connection() as conn:
            placeholders = ",".join("?" for _ in record_ids)
            cursor = conn.execute(
                f"DELETE FROM download_history WHERE id IN ({placeholders})",
                tuple(record_ids),
            )
            conn.commit()
            deleted = cursor.rowcount if cursor.rowcount is not None else 0
        logger.info(f"批量删除下载记录: {deleted}")
        return deleted

    def clear_download_history(self) -> None:
        with self._get_connection() as conn:
            conn.execute("DELETE FROM download_history")
            conn.commit()
        logger.info("已清空下载历史")

    def list_download_records(
        self,
        offset: int = 0,
        limit: int = 50,
        status: Optional[str] = None,
        query: Optional[str] = None,
    ) -> List[DownloadRecord]:
        clauses = []
        params: list = []
        if status:
            clauses.append("status = ?")
            params.append(status)
        if query:
            clauses.append("(title LIKE ? OR url LIKE ? OR uploader LIKE ?)")
            like = f"%{query}%"
            params.extend([like, like, like])
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        params.extend([max(0, int(limit)), max(0, int(offset))])
        sql = f"""
            SELECT * FROM download_history
            {where}
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
        """
        with self._get_connection() as conn:
            cursor = conn.execute(sql, tuple(params))
            return [self._row_to_record(row) for row in cursor.fetchall()]

    def add_search_record(self, platform: str, query: str):
        with self._get_connection() as conn:
            conn.execute(
                """
                INSERT INTO search_history (platform, query, searched_at)
                VALUES (?, ?, ?)
                """,
                (platform, query, datetime.now().isoformat()),
            )
            conn.commit()

    def get_recent_searches(self, limit: int = 20) -> List[SearchRecord]:
        with self._get_connection() as conn:
            cursor = conn.execute(
                """
                SELECT * FROM search_history
                ORDER BY searched_at DESC
                LIMIT ?
                """,
                (limit,),
            )
            return [
                SearchRecord(
                    id=row["id"],
                    platform=row["platform"],
                    query=row["query"],
                    searched_at=datetime.fromisoformat(row["searched_at"]),
                )
                for row in cursor.fetchall()
            ]
