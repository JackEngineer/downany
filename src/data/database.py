"""
历史记录数据库管理。
使用 SQLite 存储下载历史和搜索历史。
"""
import os
import sqlite3
from datetime import datetime
from typing import List, Optional

from src.data.models import DownloadRecord, OutputState, SearchRecord
from src.sidecar.paths import AppPaths
from src.utils.logger import setup_logger

logger = setup_logger("Database")


class _ClosingConnection(sqlite3.Connection):
    def __exit__(self, exc_type, exc_value, traceback):
        try:
            return super().__exit__(exc_type, exc_value, traceback)
        finally:
            self.close()


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
        paths = AppPaths.default()
        paths.ensure()
        self.db_path = str(paths.history_db_path)
        self._init_database()
        logger.info(f"数据库初始化完成: {self.db_path}")

    def _get_connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=10, factory=_ClosingConnection)
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
                    error_message TEXT,
                    completion_note TEXT NOT NULL DEFAULT ''
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
            columns = {
                str(row[1])
                for row in cursor.execute("PRAGMA table_info(download_history)").fetchall()
            }
            migrations = {
                "output_state": "ALTER TABLE download_history ADD COLUMN output_state TEXT NOT NULL DEFAULT 'pending'",
                "output_ready_at": "ALTER TABLE download_history ADD COLUMN output_ready_at TEXT",
                "output_recovery_safe": "ALTER TABLE download_history ADD COLUMN output_recovery_safe INTEGER NOT NULL DEFAULT 0",
                "output_owner_id": "ALTER TABLE download_history ADD COLUMN output_owner_id TEXT",
                "output_lease_expires_at": "ALTER TABLE download_history ADD COLUMN output_lease_expires_at TEXT",
                "completion_note": "ALTER TABLE download_history ADD COLUMN completion_note TEXT NOT NULL DEFAULT ''",
            }
            for name, sql in migrations.items():
                if name not in columns:
                    cursor.execute(sql)
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
            output_state=str(row["output_state"] or OutputState.PENDING.value),
            output_ready_at=row["output_ready_at"],
            output_recovery_safe=bool(row["output_recovery_safe"]),
            output_owner_id=row["output_owner_id"],
            output_lease_expires_at=row["output_lease_expires_at"],
            completion_note=str(row["completion_note"] or ""),
        )

    def add_download_record(
        self,
        record: DownloadRecord,
        *,
        output_state_override: Optional[OutputState | str] = None,
        output_recovery_safe_override: Optional[bool] = None,
        output_owner_id_override: Optional[str] = None,
        output_lease_expires_at_override: Optional[str] = None,
    ):
        state_override = (
            output_state_override.value
            if isinstance(output_state_override, OutputState)
            else output_state_override
        )
        output_state = state_override if state_override is not None else record.output_state
        output_safe = (
            int(output_recovery_safe_override)
            if output_recovery_safe_override is not None
            else int(record.output_recovery_safe)
        )
        output_owner = (
            output_owner_id_override
            if output_owner_id_override is not None
            else record.output_owner_id
        )
        output_lease = (
            output_lease_expires_at_override
            if output_lease_expires_at_override is not None
            else record.output_lease_expires_at
        )
        state_changed = state_override is not None
        safe_changed = output_recovery_safe_override is not None
        owner_changed = output_owner_id_override is not None
        lease_changed = output_lease_expires_at_override is not None
        with self._get_connection() as conn:
            conn.execute(
                """
                INSERT INTO download_history
                (id, url, title, platform, duration, thumbnail_url, uploader,
                 status, file_path, file_size, created_at, started_at, completed_at, error_message,
                 completion_note, output_state, output_ready_at, output_recovery_safe, output_owner_id, output_lease_expires_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  url=excluded.url,
                  title=excluded.title,
                  platform=excluded.platform,
                  duration=excluded.duration,
                  thumbnail_url=excluded.thumbnail_url,
                  uploader=excluded.uploader,
                  status=excluded.status,
                  file_path=excluded.file_path,
                  file_size=excluded.file_size,
                  created_at=excluded.created_at,
                  started_at=excluded.started_at,
                  completed_at=excluded.completed_at,
                  error_message=excluded.error_message,
                  completion_note=excluded.completion_note,
                  output_state=CASE WHEN ? THEN excluded.output_state ELSE download_history.output_state END,
                  output_ready_at=CASE WHEN ? THEN NULL ELSE download_history.output_ready_at END,
                  output_recovery_safe=CASE WHEN ? THEN excluded.output_recovery_safe ELSE download_history.output_recovery_safe END,
                  output_owner_id=CASE WHEN ? THEN excluded.output_owner_id ELSE download_history.output_owner_id END,
                  output_lease_expires_at=CASE WHEN ? THEN excluded.output_lease_expires_at ELSE download_history.output_lease_expires_at END
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
                    record.completion_note,
                    output_state,
                    record.output_ready_at,
                    output_safe,
                    output_owner,
                    output_lease,
                    int(state_changed),
                    int(state_changed),
                    int(safe_changed),
                    int(owner_changed),
                    int(lease_changed),
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

    def get_download_record(self, record_id: str) -> Optional[DownloadRecord]:
        with self._get_connection() as conn:
            row = conn.execute(
                "SELECT * FROM download_history WHERE id = ?", (record_id,)
            ).fetchone()
        return self._row_to_record(row) if row is not None else None

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
