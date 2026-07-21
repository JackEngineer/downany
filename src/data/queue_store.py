"""下载队列持久化存储（Qt 无关）。与历史记录共用同一个 SQLite 文件。"""
from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime
from typing import List

from src.core.download_task import (
    DownloadOptions,
    DownloadTask,
    Platform,
    TaskStatus,
    VideoInfo,
)
from src.utils.logger import setup_logger

logger = setup_logger("QueueStore")


class QueueStore:
    """task_queue 表的读写与 DownloadTask 重建。"""

    def __init__(self, db_path: str):
        self.db_path = db_path
        os.makedirs(os.path.dirname(self.db_path) or ".", exist_ok=True)
        self._init_table()

    def _get_connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout=5000")
        conn.execute("PRAGMA journal_mode=WAL")
        return conn

    def _init_table(self) -> None:
        with self._get_connection() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS task_queue (
                    id TEXT PRIMARY KEY,
                    status TEXT NOT NULL,
                    progress REAL NOT NULL DEFAULT 0,
                    downloaded_bytes INTEGER NOT NULL DEFAULT 0,
                    total_bytes INTEGER NOT NULL DEFAULT 0,
                    error_message TEXT NOT NULL DEFAULT '',
                    file_path TEXT NOT NULL DEFAULT '',
                    video_info_json TEXT NOT NULL,
                    options_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            conn.commit()

    def upsert_task(self, task: DownloadTask) -> None:
        # formats 列表可能很大且可再解析，不落库
        video_info = {
            "url": task.video_info.url,
            "title": task.video_info.title,
            "duration": task.video_info.duration,
            "thumbnail_url": task.video_info.thumbnail_url,
            "uploader": task.video_info.uploader,
            "platform": task.video_info.platform.value,
            "file_size": task.video_info.file_size,
        }
        options = {
            "format_id": task.options.format_id,
            "quality": task.options.quality,
            "download_subtitles": task.options.download_subtitles,
            "output_path": task.options.output_path,
            "speed_limit": task.options.speed_limit,
            "proxy": task.options.proxy,
        }
        with self._get_connection() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO task_queue
                (id, status, progress, downloaded_bytes, total_bytes, error_message,
                 file_path, video_info_json, options_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    task.id,
                    task.status.value,
                    task.progress,
                    task.downloaded_bytes,
                    task.total_bytes,
                    task.error_message,
                    task.file_path,
                    json.dumps(video_info, ensure_ascii=False),
                    json.dumps(options, ensure_ascii=False),
                    task.created_at.isoformat(),
                    datetime.now().isoformat(),
                ),
            )
            conn.commit()

    def update_progress(
        self, task_id: str, progress: float, downloaded_bytes: int, total_bytes: int
    ) -> None:
        with self._get_connection() as conn:
            conn.execute(
                """
                UPDATE task_queue
                SET progress = ?, downloaded_bytes = ?, total_bytes = ?, updated_at = ?
                WHERE id = ?
                """,
                (progress, downloaded_bytes, total_bytes, datetime.now().isoformat(), task_id),
            )
            conn.commit()

    def remove_task(self, task_id: str) -> None:
        with self._get_connection() as conn:
            conn.execute("DELETE FROM task_queue WHERE id = ?", (task_id,))
            conn.commit()

    def load_tasks(self) -> List[DownloadTask]:
        with self._get_connection() as conn:
            rows = conn.execute(
                "SELECT * FROM task_queue ORDER BY created_at ASC"
            ).fetchall()
        tasks: List[DownloadTask] = []
        for row in rows:
            try:
                tasks.append(self._row_to_task(row))
            except (ValueError, KeyError, json.JSONDecodeError) as exc:
                logger.error(f"跳过无法重建的队列行 {row['id']}: {exc}")
        return tasks

    @staticmethod
    def _row_to_task(row: sqlite3.Row) -> DownloadTask:
        info = json.loads(row["video_info_json"])
        opts = json.loads(row["options_json"])
        try:
            platform = Platform(info.get("platform", "unknown"))
        except ValueError:
            platform = Platform.UNKNOWN
        return DownloadTask(
            id=row["id"],
            video_info=VideoInfo(
                url=info["url"],
                title=info.get("title", ""),
                duration=info.get("duration", 0),
                thumbnail_url=info.get("thumbnail_url", ""),
                uploader=info.get("uploader", ""),
                platform=platform,
                file_size=info.get("file_size", 0),
            ),
            options=DownloadOptions(
                format_id=opts.get("format_id"),
                quality=opts.get("quality", "best"),
                download_subtitles=bool(opts.get("download_subtitles", False)),
                output_path=opts.get("output_path", "downloads"),
                speed_limit=opts.get("speed_limit"),
                proxy=opts.get("proxy"),
            ),
            status=TaskStatus(row["status"]),
            progress=row["progress"],
            downloaded_bytes=row["downloaded_bytes"],
            total_bytes=row["total_bytes"],
            file_path=row["file_path"],
            error_message=row["error_message"],
            created_at=datetime.fromisoformat(row["created_at"]),
        )
