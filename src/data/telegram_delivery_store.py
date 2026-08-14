"""SQLite-backed Telegram delivery queue.

The queue deliberately lives next to ``download_history``.  A completed
download and its delivery snapshot are therefore protected by the same
SQLite writer transaction, which makes the output-ready hand-off idempotent
across Sidecar restarts and multiple processes.
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import uuid
from dataclasses import replace
from datetime import datetime, timezone
from typing import Callable, Optional, Sequence, TypeVar

from src.data.models import (
    DownloadRecord,
    ExpiredProcessingResolution,
    OutputReadyEnqueueResult,
    OutputState,
    RecoveryResult,
    TelegramDeliveryDraft,
    TelegramDeliveryPage,
    TelegramDeliveryRecord,
    TelegramDeliverySegmentManifest,
    TelegramDeliverySegmentPart,
    TelegramDeliveryStatus,
    TelegramDeliveryWriterFence,
    TelegramTargetBlock,
)


class DeliveryNotFound(LookupError):
    pass


class DeliveryStateConflict(RuntimeError):
    pass


class TargetStillBlocked(DeliveryStateConflict):
    pass


WriterFenceResult = TypeVar("WriterFenceResult")
MAX_CLOUD_SEGMENT_BYTES = 49_000_000
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def _validate_segment_manifest(
    manifest: TelegramDeliverySegmentManifest,
) -> TelegramDeliverySegmentManifest:
    if not os.path.isabs(manifest.segment_dir):
        raise DeliveryStateConflict("segment directory must be absolute")
    if manifest.source_file_size < 1 or manifest.source_file_mtime_ns < 0:
        raise DeliveryStateConflict("segment source snapshot is invalid")
    if len(manifest.parts) < 1 or len(manifest.parts) > 10_000:
        raise DeliveryStateConflict("segment count is invalid")
    for expected_index, part in enumerate(manifest.parts):
        if part.index != expected_index:
            raise DeliveryStateConflict("segment indexes must be contiguous")
        if (
            not part.file_name
            or part.file_name in {".", ".."}
            or os.path.basename(part.file_name) != part.file_name
            or "/" in part.file_name
            or "\\" in part.file_name
        ):
            raise DeliveryStateConflict("segment file name is invalid")
        if part.file_size < 1 or part.file_size >= MAX_CLOUD_SEGMENT_BYTES:
            raise DeliveryStateConflict("segment file size is invalid")
        if not _SHA256_RE.fullmatch(part.sha256):
            raise DeliveryStateConflict("segment SHA-256 is invalid")
        metadata = (part.video_width, part.video_height, part.duration_seconds)
        if any(value is not None for value in metadata):
            if any(
                value is None
                or isinstance(value, bool)
                or not isinstance(value, int)
                or value < 1
                for value in metadata
            ):
                raise DeliveryStateConflict("segment video metadata is invalid")
    return manifest


def _segment_manifest_json(manifest: TelegramDeliverySegmentManifest) -> str:
    manifest = _validate_segment_manifest(manifest)
    return json.dumps(
        {
            "parts": [
                {
                    "fileName": part.file_name,
                    "fileSize": part.file_size,
                    "index": part.index,
                    "sha256": part.sha256,
                    **(
                        {
                            "videoWidth": part.video_width,
                            "videoHeight": part.video_height,
                            "durationSeconds": part.duration_seconds,
                        }
                        if part.video_width is not None
                        else {}
                    ),
                }
                for part in manifest.parts
            ],
            "segmentDir": manifest.segment_dir,
            "sourceFileMtimeNs": manifest.source_file_mtime_ns,
            "sourceFileSize": manifest.source_file_size,
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def _parse_segment_manifest(value: object) -> Optional[TelegramDeliverySegmentManifest]:
    if value is None or str(value) == "":
        return None
    try:
        body = json.loads(str(value))
    except (TypeError, ValueError) as exc:
        raise DeliveryStateConflict("stored segment manifest is invalid") from exc
    if not isinstance(body, dict) or set(body) != {
        "parts",
        "segmentDir",
        "sourceFileMtimeNs",
        "sourceFileSize",
    }:
        raise DeliveryStateConflict("stored segment manifest fields are invalid")
    raw_parts = body["parts"]
    if not isinstance(raw_parts, list):
        raise DeliveryStateConflict("stored segment parts are invalid")
    parts: list[TelegramDeliverySegmentPart] = []
    for raw in raw_parts:
        base_fields = {
            "fileName",
            "fileSize",
            "index",
            "sha256",
        }
        video_fields = base_fields | {
            "videoWidth",
            "videoHeight",
            "durationSeconds",
        }
        if not isinstance(raw, dict) or set(raw) not in (base_fields, video_fields):
            raise DeliveryStateConflict("stored segment part fields are invalid")
        if not isinstance(raw["index"], int) or isinstance(raw["index"], bool):
            raise DeliveryStateConflict("stored segment index is invalid")
        if not isinstance(raw["fileSize"], int) or isinstance(raw["fileSize"], bool):
            raise DeliveryStateConflict("stored segment size is invalid")
        parts.append(
            TelegramDeliverySegmentPart(
                index=raw["index"],
                file_name=str(raw["fileName"]),
                file_size=raw["fileSize"],
                sha256=str(raw["sha256"]),
                video_width=raw.get("videoWidth"),
                video_height=raw.get("videoHeight"),
                duration_seconds=raw.get("durationSeconds"),
            )
        )
    if not isinstance(body["sourceFileSize"], int) or isinstance(body["sourceFileSize"], bool):
        raise DeliveryStateConflict("stored source size is invalid")
    if not isinstance(body["sourceFileMtimeNs"], int) or isinstance(body["sourceFileMtimeNs"], bool):
        raise DeliveryStateConflict("stored source mtime is invalid")
    return _validate_segment_manifest(
        TelegramDeliverySegmentManifest(
            source_file_size=body["sourceFileSize"],
            source_file_mtime_ns=body["sourceFileMtimeNs"],
            segment_dir=str(body["segmentDir"]),
            parts=tuple(parts),
        )
    )


def _parse_message_ids(value: object) -> tuple[str, ...]:
    try:
        raw = json.loads(str(value or "[]"))
    except (TypeError, ValueError) as exc:
        raise DeliveryStateConflict("stored segment message IDs are invalid") from exc
    if not isinstance(raw, list) or any(not isinstance(item, str) or not item for item in raw):
        raise DeliveryStateConflict("stored segment message IDs are invalid")
    return tuple(raw)


class _ClosingConnection(sqlite3.Connection):
    """sqlite's context manager commits but does not close the handle.

    Closing on scope exit matters on Windows, where an open SQLite handle
    prevents the app data directory from being moved or upgraded.
    """

    def __exit__(self, exc_type, exc_value, traceback):
        try:
            return super().__exit__(exc_type, exc_value, traceback)
        finally:
            self.close()


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _normalise_time(value: str) -> str:
    text = str(value or "").strip()
    if not text:
        return utc_now()
    if text.endswith("+00:00"):
        return text[:-6] + "Z"
    return text


class _ConnectionFence(TelegramDeliveryWriterFence):
    def __init__(self, store: "TelegramDeliveryStore", conn: sqlite3.Connection):
        self._store = store
        self._conn = conn

    def record_output_ready_and_enqueue(
        self,
        task_id: str,
        draft: Optional[TelegramDeliveryDraft],
        ready_at: str,
        owner_id: Optional[str],
    ) -> OutputReadyEnqueueResult:
        return self._store._record_output_ready_and_enqueue(
            self._conn, task_id, draft, ready_at, owner_id
        )

    def resolve_expired_processing_output(
        self,
        *,
        task_id: str,
        expected_owner_id: Optional[str],
        expected_lease_expires_at: Optional[str],
        draft: Optional[TelegramDeliveryDraft],
        recovered_at: str,
    ) -> Optional[ExpiredProcessingResolution]:
        return self._store._resolve_expired_processing_output(
            self._conn,
            task_id=task_id,
            expected_owner_id=expected_owner_id,
            expected_lease_expires_at=expected_lease_expires_at,
            draft=draft,
            recovered_at=recovered_at,
        )


class TelegramDeliveryStore:
    def __init__(self, db_path: str, *, new_id: Callable[[], str] | None = None):
        self.db_path = str(db_path)
        self._new_id = new_id or (lambda: str(uuid.uuid4()))
        os.makedirs(os.path.dirname(self.db_path) or ".", exist_ok=True)
        self._init_schema()

    def _get_connection(self, *, busy_timeout_ms: int = 5000) -> sqlite3.Connection:
        timeout = max(0.0, busy_timeout_ms / 1000.0)
        conn = sqlite3.connect(
            self.db_path,
            timeout=timeout,
            isolation_level=None,
            factory=_ClosingConnection,
        )
        conn.row_factory = sqlite3.Row
        conn.execute(f"PRAGMA busy_timeout={max(0, int(busy_timeout_ms))}")
        conn.execute("PRAGMA journal_mode=WAL")
        return conn

    def _init_schema(self) -> None:
        with self._get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute(
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
                    output_state TEXT NOT NULL DEFAULT 'pending',
                    output_ready_at TEXT,
                    output_recovery_safe INTEGER NOT NULL DEFAULT 0,
                    output_owner_id TEXT,
                    output_lease_expires_at TEXT
                )
                """
            )
            columns = {str(row[1]) for row in conn.execute("PRAGMA table_info(download_history)")}
            migrations = {
                "output_state": "ALTER TABLE download_history ADD COLUMN output_state TEXT NOT NULL DEFAULT 'pending'",
                "output_ready_at": "ALTER TABLE download_history ADD COLUMN output_ready_at TEXT",
                "output_recovery_safe": "ALTER TABLE download_history ADD COLUMN output_recovery_safe INTEGER NOT NULL DEFAULT 0",
                "output_owner_id": "ALTER TABLE download_history ADD COLUMN output_owner_id TEXT",
                "output_lease_expires_at": "ALTER TABLE download_history ADD COLUMN output_lease_expires_at TEXT",
            }
            for name, sql in migrations.items():
                if name not in columns:
                    conn.execute(sql)
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS telegram_delivery_queue (
                    id TEXT PRIMARY KEY,
                    task_id TEXT NOT NULL,
                    account_id TEXT NOT NULL,
                    target_chat_id TEXT NOT NULL,
                    target_chat_type TEXT NOT NULL,
                    target_chat_title TEXT NOT NULL DEFAULT '',
                    source_url TEXT NOT NULL DEFAULT '',
                    title TEXT NOT NULL DEFAULT '',
                    file_path TEXT NOT NULL,
                    file_size INTEGER NOT NULL,
                    file_mtime_ns TEXT NOT NULL,
                    media_kind TEXT NOT NULL,
                    status TEXT NOT NULL,
                    attempt_count INTEGER NOT NULL DEFAULT 0,
                    retry_sequence_count INTEGER NOT NULL DEFAULT 0,
                    request_attempt_charged INTEGER NOT NULL DEFAULT 0,
                    fallback_used INTEGER NOT NULL DEFAULT 0,
                    next_attempt_at TEXT,
                    lease_id TEXT,
                    lease_expires_at TEXT,
                    request_started_at TEXT,
                    last_error_code TEXT NOT NULL DEFAULT '',
                    last_error_message TEXT NOT NULL DEFAULT '',
                    telegram_message_id TEXT,
                    segment_manifest_json TEXT,
                    segment_next_index INTEGER NOT NULL DEFAULT 0,
                    segment_message_ids_json TEXT NOT NULL DEFAULT '[]',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    sent_at TEXT
                )
                """
            )
            delivery_columns = {
                str(row[1])
                for row in conn.execute("PRAGMA table_info(telegram_delivery_queue)")
            }
            delivery_migrations = {
                "segment_manifest_json": "ALTER TABLE telegram_delivery_queue ADD COLUMN segment_manifest_json TEXT",
                "segment_next_index": "ALTER TABLE telegram_delivery_queue ADD COLUMN segment_next_index INTEGER NOT NULL DEFAULT 0",
                "segment_message_ids_json": "ALTER TABLE telegram_delivery_queue ADD COLUMN segment_message_ids_json TEXT NOT NULL DEFAULT '[]'",
            }
            for name, sql in delivery_migrations.items():
                if name not in delivery_columns:
                    conn.execute(sql)
            conn.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_telegram_delivery_task ON telegram_delivery_queue(task_id)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_telegram_delivery_due ON telegram_delivery_queue(account_id, status, next_attempt_at, created_at)"
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS telegram_delivery_target_blocks (
                    account_id TEXT NOT NULL,
                    target_chat_id TEXT NOT NULL,
                    error_code TEXT NOT NULL,
                    error_message TEXT NOT NULL DEFAULT '',
                    blocked_at TEXT NOT NULL,
                    PRIMARY KEY(account_id, target_chat_id)
                )
                """
            )
            conn.commit()

    @staticmethod
    def _row_to_record(row: sqlite3.Row) -> TelegramDeliveryRecord:
        return TelegramDeliveryRecord(
            id=str(row["id"]),
            task_id=str(row["task_id"]),
            account_id=str(row["account_id"]),
            target_chat_id=str(row["target_chat_id"]),
            target_chat_type=str(row["target_chat_type"]),
            target_chat_title=str(row["target_chat_title"] or ""),
            source_url=str(row["source_url"] or ""),
            title=str(row["title"] or ""),
            file_path=str(row["file_path"] or ""),
            file_size=int(row["file_size"] or 0),
            file_mtime_ns=int(str(row["file_mtime_ns"] or "0")),
            media_kind=str(row["media_kind"] or "document"),
            status=str(row["status"]),
            attempt_count=int(row["attempt_count"] or 0),
            retry_sequence_count=int(row["retry_sequence_count"] or 0),
            request_attempt_charged=bool(row["request_attempt_charged"]),
            fallback_used=bool(row["fallback_used"]),
            next_attempt_at=row["next_attempt_at"],
            lease_id=row["lease_id"],
            lease_expires_at=row["lease_expires_at"],
            request_started_at=row["request_started_at"],
            last_error_code=str(row["last_error_code"] or ""),
            last_error_message=str(row["last_error_message"] or ""),
            telegram_message_id=row["telegram_message_id"],
            created_at=str(row["created_at"]),
            updated_at=str(row["updated_at"]),
            sent_at=row["sent_at"],
            segment_manifest=_parse_segment_manifest(row["segment_manifest_json"]),
            segment_next_index=int(row["segment_next_index"] or 0),
            segment_message_ids=_parse_message_ids(row["segment_message_ids_json"]),
        )

    @staticmethod
    def _history_record(row: sqlite3.Row) -> DownloadRecord:
        return DownloadRecord(
            id=str(row["id"]),
            url=str(row["url"] or ""),
            title=str(row["title"] or ""),
            platform=str(row["platform"] or "unknown"),
            duration=int(row["duration"] or 0),
            thumbnail_url=str(row["thumbnail_url"] or ""),
            uploader=str(row["uploader"] or ""),
            status=str(row["status"] or ""),
            file_path=str(row["file_path"] or ""),
            file_size=int(row["file_size"] or 0),
            created_at=datetime.fromisoformat(str(row["created_at"]).replace("Z", "+00:00")),
            started_at=(
                datetime.fromisoformat(str(row["started_at"]).replace("Z", "+00:00"))
                if row["started_at"]
                else None
            ),
            completed_at=(
                datetime.fromisoformat(str(row["completed_at"]).replace("Z", "+00:00"))
                if row["completed_at"]
                else None
            ),
            error_message=str(row["error_message"] or ""),
            output_state=str(row["output_state"] or OutputState.PENDING.value),
            output_ready_at=row["output_ready_at"],
            output_recovery_safe=bool(row["output_recovery_safe"]),
            output_owner_id=row["output_owner_id"],
            output_lease_expires_at=row["output_lease_expires_at"],
        )

    def with_writer_fence(
        self,
        operation: Callable[[TelegramDeliveryWriterFence], WriterFenceResult],
        *,
        busy_timeout_ms: int = 5000,
    ) -> WriterFenceResult:
        conn = self._get_connection(busy_timeout_ms=busy_timeout_ms)
        try:
            conn.execute("BEGIN IMMEDIATE")
            result = operation(_ConnectionFence(self, conn))
            conn.commit()
            return result
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _history_row(self, conn: sqlite3.Connection, task_id: str) -> Optional[sqlite3.Row]:
        return conn.execute(
            "SELECT * FROM download_history WHERE id = ?", (task_id,)
        ).fetchone()

    def _existing_delivery(
        self, conn: sqlite3.Connection, task_id: str
    ) -> Optional[TelegramDeliveryRecord]:
        row = conn.execute(
            "SELECT * FROM telegram_delivery_queue WHERE task_id = ?", (task_id,)
        ).fetchone()
        return self._row_to_record(row) if row else None

    def _record_output_ready_and_enqueue(
        self,
        conn: sqlite3.Connection,
        task_id: str,
        draft: Optional[TelegramDeliveryDraft],
        ready_at: str,
        owner_id: Optional[str],
    ) -> OutputReadyEnqueueResult:
        history = self._history_row(conn, task_id)
        if history is None:
            raise DeliveryNotFound(task_id)
        state = str(history["output_state"] or OutputState.PENDING.value)
        current_owner = history["output_owner_id"]
        if state == OutputState.PROCESSING.value and current_owner != owner_id:
            raise DeliveryStateConflict("output processing owner mismatch")
        if state == OutputState.PENDING.value and current_owner is not None:
            raise DeliveryStateConflict("pending output has an owner")
        existing = self._existing_delivery(conn, task_id)
        conn.execute(
            """
            UPDATE download_history
               SET output_state = 'ready',
                   output_ready_at = COALESCE(output_ready_at, ?),
                   output_owner_id = NULL,
                   output_lease_expires_at = NULL
             WHERE id = ?
            """,
            (_normalise_time(ready_at), task_id),
        )
        if existing is not None:
            return OutputReadyEnqueueResult(existing, False)
        if draft is None:
            return OutputReadyEnqueueResult(None, False)
        block = conn.execute(
            "SELECT error_code, error_message FROM telegram_delivery_target_blocks WHERE account_id = ? AND target_chat_id = ?",
            (draft.account_id, draft.target_chat_id),
        ).fetchone()
        now = _normalise_time(ready_at)
        status = (
            TelegramDeliveryStatus.FAILED.value
            if block is not None
            else TelegramDeliveryStatus.PENDING.value
        )
        error_code = str(block["error_code"]) if block else ""
        error_message = str(block["error_message"]) if block else ""
        delivery_id = self._new_id()
        conn.execute(
            """
            INSERT INTO telegram_delivery_queue
              (id, task_id, account_id, target_chat_id, target_chat_type, target_chat_title,
               source_url, title, file_path, file_size, file_mtime_ns, media_kind, status,
               attempt_count, retry_sequence_count, request_attempt_charged, fallback_used,
               next_attempt_at, lease_id, lease_expires_at, request_started_at,
               last_error_code, last_error_message, telegram_message_id, created_at, updated_at, sent_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, NULL, NULL, NULL, NULL, ?, ?, NULL, ?, ?, NULL)
            """,
            (
                delivery_id,
                draft.task_id,
                draft.account_id,
                draft.target_chat_id,
                draft.target_chat_type,
                draft.target_chat_title,
                draft.source_url,
                draft.title,
                draft.file_path,
                int(draft.file_size),
                str(int(draft.file_mtime_ns)),
                draft.media_kind,
                status,
                error_code,
                error_message,
                now,
                now,
            ),
        )
        row = conn.execute(
            "SELECT * FROM telegram_delivery_queue WHERE id = ?", (delivery_id,)
        ).fetchone()
        return OutputReadyEnqueueResult(self._row_to_record(row), True)

    def record_output_ready_and_enqueue(
        self,
        task_id: str,
        draft: Optional[TelegramDeliveryDraft],
        ready_at: str,
        owner_id: Optional[str],
    ) -> OutputReadyEnqueueResult:
        return self.with_writer_fence(
            lambda fence: fence.record_output_ready_and_enqueue(task_id, draft, ready_at, owner_id)
        )

    def _resolve_expired_processing_output(
        self,
        conn: sqlite3.Connection,
        *,
        task_id: str,
        expected_owner_id: Optional[str],
        expected_lease_expires_at: Optional[str],
        draft: Optional[TelegramDeliveryDraft],
        recovered_at: str,
    ) -> Optional[ExpiredProcessingResolution]:
        row = self._history_row(conn, task_id)
        if row is None:
            return None
        state = str(row["output_state"] or OutputState.PENDING.value)
        if state != OutputState.PROCESSING.value:
            return None
        if row["output_owner_id"] != expected_owner_id or row["output_lease_expires_at"] != expected_lease_expires_at:
            return None
        existing = self._existing_delivery(conn, task_id)
        if existing is not None:
            conn.execute(
                "UPDATE download_history SET output_state='ready', output_ready_at=COALESCE(output_ready_at, ?), output_owner_id=NULL, output_lease_expires_at=NULL WHERE id=?",
                (_normalise_time(recovered_at), task_id),
            )
            refreshed = self._history_row(conn, task_id)
            return ExpiredProcessingResolution(self._history_record(refreshed), existing, False)
        conn.execute(
            "UPDATE download_history SET output_state='interrupted', output_owner_id=NULL, output_lease_expires_at=NULL WHERE id=?",
            (task_id,),
        )
        created = False
        delivery = None
        if draft is not None:
            now = _normalise_time(recovered_at)
            delivery_id = self._new_id()
            conn.execute(
                """
                INSERT INTO telegram_delivery_queue
                  (id, task_id, account_id, target_chat_id, target_chat_type, target_chat_title,
                   source_url, title, file_path, file_size, file_mtime_ns, media_kind, status,
                   last_error_code, last_error_message, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'failed', 'POSTPROCESS_INTERRUPTED', ?, ?, ?)
                """,
                (
                    delivery_id,
                    draft.task_id,
                    draft.account_id,
                    draft.target_chat_id,
                    draft.target_chat_type,
                    draft.target_chat_title,
                    draft.source_url,
                    draft.title,
                    draft.file_path,
                    draft.file_size,
                    str(draft.file_mtime_ns),
                    draft.media_kind,
                    "Download process ended before the output was committed.",
                    now,
                    now,
                ),
            )
            delivery = self._row_to_record(
                conn.execute("SELECT * FROM telegram_delivery_queue WHERE id=?", (delivery_id,)).fetchone()
            )
            created = True
        refreshed = self._history_row(conn, task_id)
        return ExpiredProcessingResolution(self._history_record(refreshed), delivery, created)

    def resolve_expired_processing_output(self, **kwargs) -> Optional[ExpiredProcessingResolution]:
        return self.with_writer_fence(
            lambda fence: fence.resolve_expired_processing_output(**kwargs)
        )

    def mark_processing_failed(
        self,
        *,
        task_id: str,
        owner_id: str,
        draft: Optional[TelegramDeliveryDraft],
        failed_at: str,
        error_message: str,
    ) -> Optional[ExpiredProcessingResolution]:
        """Close a failed post-process handoff without waiting for lease expiry.

        A normal script failure is different from a killed Sidecar: the worker
        still owns the processing handoff, so waiting for the recovery lease to
        expire would hide the failed delivery until a later restart.  Keep the
        same failed/retryable queue shape as crash recovery, but perform the
        owner check and state transition immediately in one writer transaction.
        """
        with self._get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = self._history_row(conn, task_id)
            if row is None:
                conn.rollback()
                raise DeliveryNotFound(task_id)
            if row["output_state"] != OutputState.PROCESSING.value:
                conn.rollback()
                raise DeliveryStateConflict("output is not processing")
            if row["output_owner_id"] != owner_id:
                conn.rollback()
                raise DeliveryStateConflict("output processing owner mismatch")

            existing = self._existing_delivery(conn, task_id)
            conn.execute(
                "UPDATE download_history SET output_state='interrupted', output_owner_id=NULL, output_lease_expires_at=NULL WHERE id=?",
                (task_id,),
            )
            delivery = existing
            created = False
            if delivery is None and draft is not None:
                now = _normalise_time(failed_at)
                delivery_id = self._new_id()
                conn.execute(
                    """
                    INSERT INTO telegram_delivery_queue
                      (id, task_id, account_id, target_chat_id, target_chat_type, target_chat_title,
                       source_url, title, file_path, file_size, file_mtime_ns, media_kind, status,
                       last_error_code, last_error_message, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'failed', 'POSTPROCESS_INTERRUPTED', ?, ?, ?)
                    """,
                    (
                        delivery_id,
                        draft.task_id,
                        draft.account_id,
                        draft.target_chat_id,
                        draft.target_chat_type,
                        draft.target_chat_title,
                        draft.source_url,
                        draft.title,
                        draft.file_path,
                        draft.file_size,
                        str(draft.file_mtime_ns),
                        draft.media_kind,
                        str(error_message)[:1000],
                        now,
                        now,
                    ),
                )
                delivery = self._row_to_record(
                    conn.execute("SELECT * FROM telegram_delivery_queue WHERE id=?", (delivery_id,)).fetchone()
                )
                created = True
            refreshed = self._history_row(conn, task_id)
            conn.commit()
        return ExpiredProcessingResolution(self._history_record(refreshed), delivery, created)

    def mark_processing(self, task_id: str, owner_id: str, lease_expires_at: str) -> None:
        with self._get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = self._history_row(conn, task_id)
            if row is None:
                raise DeliveryNotFound(task_id)
            if row["output_state"] not in (OutputState.PENDING.value, OutputState.PROCESSING.value):
                raise DeliveryStateConflict("output is already ready")
            if row["output_state"] == OutputState.PROCESSING.value and row["output_owner_id"] != owner_id:
                raise DeliveryStateConflict("output processing owner mismatch")
            conn.execute(
                "UPDATE download_history SET output_state='processing', output_owner_id=?, output_lease_expires_at=? WHERE id=?",
                (owner_id, _normalise_time(lease_expires_at), task_id),
            )
            conn.commit()

    def renew_processing(self, task_id: str, owner_id: str, lease_expires_at: str) -> None:
        with self._get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            cur = conn.execute(
                "UPDATE download_history SET output_lease_expires_at=? WHERE id=? AND output_state='processing' AND output_owner_id=?",
                (_normalise_time(lease_expires_at), task_id, owner_id),
            )
            if cur.rowcount != 1:
                conn.rollback()
                raise DeliveryStateConflict("processing lease mismatch")
            conn.commit()

    def max_download_history_rowid(self) -> int:
        with self._get_connection() as conn:
            row = conn.execute("SELECT COALESCE(MAX(rowid), 0) AS value FROM download_history").fetchone()
        return int(row["value"] or 0)

    def _fetch_record(self, conn: sqlite3.Connection, delivery_id: str) -> TelegramDeliveryRecord:
        row = conn.execute("SELECT * FROM telegram_delivery_queue WHERE id=?", (delivery_id,)).fetchone()
        if row is None:
            raise DeliveryNotFound(delivery_id)
        return self._row_to_record(row)

    def claim_next(self, *, account_id: str, now: str, lease_id: str, lease_expires_at: str) -> Optional[TelegramDeliveryRecord]:
        now = _normalise_time(now)
        with self._get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                """
                SELECT q.id FROM telegram_delivery_queue q
                WHERE q.account_id=?
                  AND q.status IN ('pending','retry_wait','preparing')
                  AND (q.status='pending' OR (q.status='retry_wait' AND q.next_attempt_at <= ?) OR (q.status='preparing' AND (q.lease_expires_at IS NULL OR q.lease_expires_at <= ?)))
                  AND NOT EXISTS (SELECT 1 FROM telegram_delivery_target_blocks b WHERE b.account_id=q.account_id AND b.target_chat_id=q.target_chat_id)
                ORDER BY q.created_at ASC, q.id ASC
                LIMIT 1
                """,
                (account_id, now, now),
            ).fetchone()
            if row is None:
                conn.commit()
                return None
            updated = conn.execute(
                """
                UPDATE telegram_delivery_queue
                   SET status='preparing', lease_id=?, lease_expires_at=?, request_started_at=NULL,
                       request_attempt_charged=0, updated_at=?
                 WHERE id=? AND status IN ('pending','retry_wait','preparing')
                """,
                (lease_id, _normalise_time(lease_expires_at), now, row["id"]),
            )
            if updated.rowcount != 1:
                conn.rollback()
                return None
            record = self._fetch_record(conn, str(row["id"]))
            conn.commit()
            return record

    def _lease_update(self, delivery_id: str, lease_id: str, sql: str, params: Sequence[object]) -> TelegramDeliveryRecord:
        with self._get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            cur = conn.execute(sql, tuple(params))
            if cur.rowcount != 1:
                conn.rollback()
                raise DeliveryStateConflict("delivery lease or state mismatch")
            result = self._fetch_record(conn, delivery_id)
            conn.commit()
            return result

    def renew_lease(self, delivery_id: str, lease_id: str, lease_expires_at: str) -> TelegramDeliveryRecord:
        return self._lease_update(
            delivery_id,
            lease_id,
            "UPDATE telegram_delivery_queue SET lease_expires_at=?, updated_at=? WHERE id=? AND lease_id=? AND status IN ('preparing','sending')",
            (_normalise_time(lease_expires_at), utc_now(), delivery_id, lease_id),
        )

    def release_claim(self, delivery_id: str, lease_id: str, released_at: str) -> TelegramDeliveryRecord:
        return self._lease_update(
            delivery_id,
            lease_id,
            "UPDATE telegram_delivery_queue SET status='pending', lease_id=NULL, lease_expires_at=NULL, request_started_at=NULL, request_attempt_charged=0, updated_at=? WHERE id=? AND lease_id=? AND status='preparing'",
            (_normalise_time(released_at), delivery_id, lease_id),
        )

    def mark_sending(self, delivery_id: str, lease_id: str, request_started_at: str, media_kind: str, fallback_used: bool, charge_attempt: bool) -> TelegramDeliveryRecord:
        return self._lease_update(
            delivery_id,
            lease_id,
            "UPDATE telegram_delivery_queue SET status='sending', request_started_at=?, media_kind=?, fallback_used=?, request_attempt_charged=?, attempt_count=attempt_count+?, updated_at=? WHERE id=? AND lease_id=? AND status='preparing'",
            (_normalise_time(request_started_at), media_kind, int(fallback_used), int(charge_attempt), int(charge_attempt), _normalise_time(request_started_at), delivery_id, lease_id),
        )

    def set_segment_manifest(
        self,
        delivery_id: str,
        lease_id: str,
        manifest: TelegramDeliverySegmentManifest,
        prepared_at: str,
    ) -> TelegramDeliveryRecord:
        canonical = _segment_manifest_json(manifest)
        with self._get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT * FROM telegram_delivery_queue WHERE id=?", (delivery_id,)
            ).fetchone()
            if row is None:
                conn.rollback()
                raise DeliveryNotFound(delivery_id)
            if str(row["lease_id"] or "") != lease_id or str(row["status"]) != "preparing":
                conn.rollback()
                raise DeliveryStateConflict("segment manifest lease or state mismatch")
            if (
                int(row["file_size"] or 0) != manifest.source_file_size
                or int(str(row["file_mtime_ns"] or "0")) != manifest.source_file_mtime_ns
            ):
                conn.rollback()
                raise DeliveryStateConflict("segment source snapshot changed")
            existing = row["segment_manifest_json"]
            if existing is not None:
                if str(existing) != canonical:
                    conn.rollback()
                    raise DeliveryStateConflict("segment manifest already differs")
                result = self._row_to_record(row)
                conn.commit()
                return result
            if int(row["segment_next_index"] or 0) != 0 or _parse_message_ids(
                row["segment_message_ids_json"]
            ):
                conn.rollback()
                raise DeliveryStateConflict("segment progress exists without manifest")
            cursor = conn.execute(
                "UPDATE telegram_delivery_queue SET segment_manifest_json=?, updated_at=? WHERE id=? AND lease_id=? AND status='preparing' AND segment_manifest_json IS NULL",
                (canonical, _normalise_time(prepared_at), delivery_id, lease_id),
            )
            if cursor.rowcount != 1:
                conn.rollback()
                raise DeliveryStateConflict("segment manifest CAS failed")
            result = self._fetch_record(conn, delivery_id)
            conn.commit()
            return result

    def mark_segment_sent(
        self,
        delivery_id: str,
        lease_id: str,
        segment_index: int,
        message_id: str,
        sent_at: str,
    ) -> TelegramDeliveryRecord:
        safe_message_id = str(message_id).strip()
        if not safe_message_id or len(safe_message_id) > 128:
            raise DeliveryStateConflict("segment message ID is invalid")
        with self._get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT * FROM telegram_delivery_queue WHERE id=?", (delivery_id,)
            ).fetchone()
            if row is None:
                conn.rollback()
                raise DeliveryNotFound(delivery_id)
            if str(row["lease_id"] or "") != lease_id or str(row["status"]) != "sending":
                conn.rollback()
                raise DeliveryStateConflict("segment result lease or state mismatch")
            manifest = _parse_segment_manifest(row["segment_manifest_json"])
            if manifest is None:
                conn.rollback()
                raise DeliveryStateConflict("segment manifest is missing")
            next_index = int(row["segment_next_index"] or 0)
            message_ids = _parse_message_ids(row["segment_message_ids_json"])
            if segment_index != next_index or len(message_ids) != next_index:
                conn.rollback()
                raise DeliveryStateConflict("segment result index mismatch")
            if segment_index >= len(manifest.parts):
                conn.rollback()
                raise DeliveryStateConflict("segment result is out of range")
            updated_ids = (*message_ids, safe_message_id)
            completed = len(updated_ids) == len(manifest.parts)
            status = "sent" if completed else "preparing"
            cursor = conn.execute(
                """
                UPDATE telegram_delivery_queue
                   SET status=?,
                       segment_next_index=?,
                       segment_message_ids_json=?,
                       telegram_message_id=?,
                       sent_at=?,
                       lease_id=?,
                       lease_expires_at=?,
                       request_started_at=NULL,
                       request_attempt_charged=0,
                       last_error_code='',
                       last_error_message='',
                       updated_at=?
                 WHERE id=? AND lease_id=? AND status='sending' AND segment_next_index=?
                """,
                (
                    status,
                    len(updated_ids),
                    json.dumps(list(updated_ids), separators=(",", ":")),
                    safe_message_id,
                    _normalise_time(sent_at) if completed else None,
                    None if completed else lease_id,
                    None if completed else row["lease_expires_at"],
                    _normalise_time(sent_at),
                    delivery_id,
                    lease_id,
                    segment_index,
                ),
            )
            if cursor.rowcount != 1:
                conn.rollback()
                raise DeliveryStateConflict("segment result CAS failed")
            result = self._fetch_record(conn, delivery_id)
            conn.commit()
            return result

    def mark_fallback_used(self, delivery_id: str, lease_id: str) -> TelegramDeliveryRecord:
        return self._lease_update(
            delivery_id,
            lease_id,
            "UPDATE telegram_delivery_queue SET fallback_used=1, media_kind='document', updated_at=? WHERE id=? AND lease_id=? AND status='sending'",
            (_normalise_time(utc_now()), delivery_id, lease_id),
        )

    def mark_sent(self, delivery_id: str, lease_id: str, message_id: str, sent_at: str) -> TelegramDeliveryRecord:
        return self._lease_update(
            delivery_id,
            lease_id,
            "UPDATE telegram_delivery_queue SET status='sent', telegram_message_id=?, sent_at=?, lease_id=NULL, lease_expires_at=NULL, request_started_at=NULL, request_attempt_charged=0, last_error_code='', last_error_message='', updated_at=? WHERE id=? AND lease_id=? AND status='sending'",
            (str(message_id), _normalise_time(sent_at), _normalise_time(sent_at), delivery_id, lease_id),
        )

    def mark_skipped_oversize(self, delivery_id: str, lease_id: str, message_id: str, sent_at: str) -> TelegramDeliveryRecord:
        return self._lease_update(
            delivery_id,
            lease_id,
            "UPDATE telegram_delivery_queue SET status='skipped_oversize', telegram_message_id=?, sent_at=?, lease_id=NULL, lease_expires_at=NULL, request_started_at=NULL, request_attempt_charged=0, updated_at=? WHERE id=? AND lease_id=? AND status='sending'",
            (str(message_id), _normalise_time(sent_at), _normalise_time(sent_at), delivery_id, lease_id),
        )

    def _mark_error(self, delivery_id: str, lease_id: str, status: str, code: str, message: str, when: str, *, next_attempt_at: Optional[str] = None) -> TelegramDeliveryRecord:
        return self._lease_update(
            delivery_id,
            lease_id,
            "UPDATE telegram_delivery_queue SET status=?, last_error_code=?, last_error_message=?, next_attempt_at=?, lease_id=NULL, lease_expires_at=NULL, request_started_at=NULL, request_attempt_charged=0, retry_sequence_count=retry_sequence_count+1, updated_at=? WHERE id=? AND lease_id=? AND status IN ('preparing','sending')",
            (status, code, message[:1000], next_attempt_at, _normalise_time(when), delivery_id, lease_id),
        )

    def mark_retry(self, delivery_id: str, lease_id: str, code: str, message: str, next_attempt_at: str) -> TelegramDeliveryRecord:
        return self._mark_error(delivery_id, lease_id, TelegramDeliveryStatus.RETRY_WAIT.value, code, message, next_attempt_at, next_attempt_at=_normalise_time(next_attempt_at))

    def mark_retry_not_submitted(self, delivery_id: str, lease_id: str, code: str, message: str, next_attempt_at: str) -> TelegramDeliveryRecord:
        return self._mark_error(delivery_id, lease_id, TelegramDeliveryStatus.RETRY_WAIT.value, code, message, next_attempt_at, next_attempt_at=_normalise_time(next_attempt_at))

    def mark_failed(self, delivery_id: str, lease_id: str, code: str, message: str, failed_at: str) -> TelegramDeliveryRecord:
        return self._mark_error(delivery_id, lease_id, TelegramDeliveryStatus.FAILED.value, code, message, failed_at)

    def mark_uncertain(self, delivery_id: str, lease_id: str, code: str, message: str, failed_at: str) -> TelegramDeliveryRecord:
        return self._mark_error(delivery_id, lease_id, TelegramDeliveryStatus.UNCERTAIN.value, code, message, failed_at)

    def get_for_retry(self, delivery_id: str) -> TelegramDeliveryRecord:
        with self._get_connection() as conn:
            return self._fetch_record(conn, delivery_id)

    def retry(
        self,
        *,
        delivery_id: str,
        now: str,
        confirm_possible_duplicate: bool,
        confirm_interrupted_output: bool,
        expected_account_id: str,
        expected_status: str,
        expected_error_code: str,
        expected_updated_at: str,
        expected_file_path: str,
        refreshed_file_size: Optional[int] = None,
        refreshed_file_mtime_ns: Optional[int] = None,
        refreshed_media_kind: Optional[str] = None,
    ) -> TelegramDeliveryRecord:
        refreshed = (refreshed_file_size, refreshed_file_mtime_ns, refreshed_media_kind)
        if any(value is None for value in refreshed) and any(value is not None for value in refreshed):
            raise DeliveryStateConflict("refreshed file snapshot must be complete")
        if expected_status == TelegramDeliveryStatus.UNCERTAIN.value and not confirm_possible_duplicate:
            raise DeliveryStateConflict("possible duplicate confirmation required")
        if expected_error_code == "POSTPROCESS_INTERRUPTED" and not confirm_interrupted_output:
            raise DeliveryStateConflict("interrupted output confirmation required")
        if expected_status not in {
            TelegramDeliveryStatus.FAILED.value,
            TelegramDeliveryStatus.UNCERTAIN.value,
        }:
            raise DeliveryStateConflict("only failed or uncertain deliveries can be retried")
        with self._get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT * FROM telegram_delivery_queue WHERE id=?", (delivery_id,)).fetchone()
            if row is None:
                raise DeliveryNotFound(delivery_id)
            if (str(row["account_id"]), str(row["status"]), str(row["last_error_code"] or ""), str(row["updated_at"]), str(row["file_path"])) != (expected_account_id, expected_status, expected_error_code, expected_updated_at, expected_file_path):
                conn.rollback()
                raise DeliveryStateConflict("delivery changed while retrying")
            blocked = conn.execute("SELECT 1 FROM telegram_delivery_target_blocks WHERE account_id=? AND target_chat_id=?", (row["account_id"], row["target_chat_id"])).fetchone()
            if blocked:
                conn.rollback()
                raise TargetStillBlocked("target is blocked")
            if refreshed_file_size is None:
                cur = conn.execute(
                    "UPDATE telegram_delivery_queue SET status='pending', last_error_code='', last_error_message='', next_attempt_at=NULL, retry_sequence_count=0, updated_at=? WHERE id=?",
                    (_normalise_time(now), delivery_id),
                )
            else:
                cur = conn.execute(
                    "UPDATE telegram_delivery_queue SET status='pending', file_size=?, file_mtime_ns=?, media_kind=?, last_error_code='', last_error_message='', next_attempt_at=NULL, retry_sequence_count=0, updated_at=? WHERE id=?",
                    (int(refreshed_file_size), str(int(refreshed_file_mtime_ns)), str(refreshed_media_kind), _normalise_time(now), delivery_id),
                )
            if cur.rowcount != 1:
                conn.rollback()
                raise DeliveryStateConflict("retry CAS failed")
            result = self._fetch_record(conn, delivery_id)
            conn.commit()
            return result

    def cancel_pending(self, *, account_id: Optional[str], now: str) -> tuple[TelegramDeliveryRecord, ...]:
        with self._get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            where = "status IN ('pending','preparing','retry_wait')"
            params: list[object] = [_normalise_time(now)]
            if account_id is not None:
                where += " AND account_id=?"
                params.append(account_id)
            ids = [row["id"] for row in conn.execute(f"SELECT id FROM telegram_delivery_queue WHERE {where} ORDER BY id", tuple(params[1:])).fetchall()]
            if ids:
                placeholders = ",".join("?" for _ in ids)
                conn.execute(f"UPDATE telegram_delivery_queue SET status='cancelled', lease_id=NULL, lease_expires_at=NULL, request_started_at=NULL, updated_at=? WHERE id IN ({placeholders})", (_normalise_time(now), *ids))
            records = tuple(self._fetch_record(conn, str(identifier)) for identifier in ids)
            conn.commit()
            return records

    def block_target_and_fail_pending(self, *, delivery_id: str, lease_id: str, account_id: str, target_chat_id: str, code: str, safe_message: str, failed_at: str) -> tuple[TelegramDeliveryRecord, ...]:
        with self._get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute("INSERT INTO telegram_delivery_target_blocks(account_id,target_chat_id,error_code,error_message,blocked_at) VALUES(?,?,?,?,?) ON CONFLICT(account_id,target_chat_id) DO UPDATE SET error_code=excluded.error_code,error_message=excluded.error_message,blocked_at=excluded.blocked_at", (account_id, target_chat_id, code, safe_message[:1000], _normalise_time(failed_at)))
            rows = conn.execute("SELECT id FROM telegram_delivery_queue WHERE account_id=? AND target_chat_id=? AND status IN ('pending','preparing','retry_wait','sending') ORDER BY id", (account_id, target_chat_id)).fetchall()
            ids = [row["id"] for row in rows]
            if ids:
                placeholders = ",".join("?" for _ in ids)
                conn.execute(f"UPDATE telegram_delivery_queue SET status='failed',last_error_code=?,last_error_message=?,next_attempt_at=NULL,lease_id=NULL,lease_expires_at=NULL,request_started_at=NULL,request_attempt_charged=0,updated_at=? WHERE id IN ({placeholders})", (code, safe_message[:1000], _normalise_time(failed_at), *ids))
            records = tuple(self._fetch_record(conn, str(identifier)) for identifier in ids)
            conn.commit()
            return records

    def get_target_block(self, account_id: str, target_chat_id: str) -> Optional[TelegramTargetBlock]:
        with self._get_connection() as conn:
            row = conn.execute("SELECT * FROM telegram_delivery_target_blocks WHERE account_id=? AND target_chat_id=?", (account_id, target_chat_id)).fetchone()
        if not row:
            return None
        return TelegramTargetBlock(str(row["account_id"]), str(row["target_chat_id"]), str(row["error_code"]), str(row["error_message"] or ""), str(row["blocked_at"]))

    def clear_target_block(self, account_id: str, target_chat_id: str) -> bool:
        with self._get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            cur = conn.execute("DELETE FROM telegram_delivery_target_blocks WHERE account_id=? AND target_chat_id=?", (account_id, target_chat_id))
            conn.commit()
            return cur.rowcount == 1

    def list_deliveries(self, *, offset: int = 0, limit: int = 50, status: Optional[str] = None) -> TelegramDeliveryPage:
        offset = max(0, int(offset)); limit = max(1, min(200, int(limit)))
        with self._get_connection() as conn:
            where = ""; params: list[object] = []
            if status:
                where = "WHERE status=?"; params.append(status)
            total = int(conn.execute(f"SELECT COUNT(*) AS count FROM telegram_delivery_queue {where}", tuple(params)).fetchone()["count"])
            rows = conn.execute(f"SELECT * FROM telegram_delivery_queue {where} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?", (*params, limit, offset)).fetchall()
        return TelegramDeliveryPage(tuple(self._row_to_record(row) for row in rows), total, offset, limit)

    def recover_delivery_leases(self, now: str) -> RecoveryResult:
        now = _normalise_time(now)
        requeued = uncertain = 0
        with self._get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            requeued = int(conn.execute("UPDATE telegram_delivery_queue SET status='pending', lease_id=NULL, lease_expires_at=NULL, request_started_at=NULL, request_attempt_charged=0, updated_at=? WHERE status='preparing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?", (now, now)).rowcount)
            uncertain = int(conn.execute("UPDATE telegram_delivery_queue SET status='uncertain', lease_id=NULL, lease_expires_at=NULL, request_started_at=NULL, request_attempt_charged=0, last_error_code='APP_RESTART_RESULT_UNKNOWN', last_error_message='The app stopped while Telegram may have accepted this request.', updated_at=? WHERE status='sending'", (now,)).rowcount)
            conn.commit()
        return RecoveryResult(requeued_count=requeued, uncertain_count=uncertain)

    def list_expired_processing_outputs(self, *, recovered_at: str, high_water_history_rowid: int, after: Optional[tuple[str, str]], limit: int = 50) -> tuple[DownloadRecord, ...]:
        clauses = ["rowid <= ?", "output_state='processing'", "output_lease_expires_at IS NOT NULL", "output_lease_expires_at <= ?"]
        params: list[object] = [int(high_water_history_rowid), _normalise_time(recovered_at)]
        if after:
            clauses.append("(COALESCE(completed_at, created_at), id) > (?, ?)"); params.extend(after)
        with self._get_connection() as conn:
            rows = conn.execute(f"SELECT * FROM download_history WHERE {' AND '.join(clauses)} ORDER BY COALESCE(completed_at, created_at), id LIMIT ?", (*params, max(1, int(limit)))).fetchall()
        return tuple(self._history_record(row) for row in rows)

    def recover_unmarked_outputs(self, *, high_water_history_rowid: int, after: Optional[tuple[str, str]], limit: int = 50) -> tuple[DownloadRecord, ...]:
        clauses = ["rowid <= ?", "status='completed'", "output_state='pending'", "output_recovery_safe=1", "output_ready_at IS NULL"]
        params: list[object] = [int(high_water_history_rowid)]
        if after:
            clauses.append("(COALESCE(completed_at, created_at), id) > (?, ?)"); params.extend(after)
        with self._get_connection() as conn:
            rows = conn.execute(f"SELECT * FROM download_history WHERE {' AND '.join(clauses)} ORDER BY COALESCE(completed_at, created_at), id LIMIT ?", (*params, max(1, int(limit)))).fetchall()
        return tuple(self._history_record(row) for row in rows)

    def recover_pending_outputs(self, *, high_water_history_rowid: int, after: Optional[tuple[str, str]], limit: int = 50) -> tuple[DownloadRecord, ...]:
        clauses = ["rowid <= ?", "status='completed'", "output_state='ready'", "output_ready_at IS NOT NULL"]
        params: list[object] = [int(high_water_history_rowid)]
        if after:
            clauses.append("(output_ready_at, id) > (?, ?)"); params.extend(after)
        with self._get_connection() as conn:
            rows = conn.execute(f"SELECT * FROM download_history WHERE {' AND '.join(clauses)} ORDER BY output_ready_at, id LIMIT ?", (*params, max(1, int(limit)))).fetchall()
        return tuple(self._history_record(row) for row in rows)
