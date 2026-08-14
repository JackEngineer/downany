"""Sidecar-owned Telegram delivery orchestration.

This module never receives or persists a Bot Token.  Electron owns the
credential and calls the delivery queue through the narrow methods exposed by
``handlers.py``.  Keeping the queue and output lifecycle here means a
download can finish even when Telegram is disconnected or disabled.
"""
from __future__ import annotations

import asyncio
import os
import stat
import threading
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

from src.core.download_task import DownloadTask, TaskStatus
from src.data.json_config import JsonConfig
from src.data.models import (
    DownloadRecord,
    OutputRecoveryConfigSnapshot,
    OutputRecoveryScan,
    OutputState,
    RecoveryResult,
    TelegramDeliveryDraft,
    TelegramDeliveryRecord,
    TelegramDeliverySegmentManifest,
    TelegramDeliverySegmentPart,
    TelegramDeliveryStatus,
)
from src.data.telegram_delivery_store import (
    DeliveryNotFound,
    DeliveryStateConflict,
    TargetStillBlocked,
    TelegramDeliveryStore,
)
from src.utils.logger import setup_logger

logger = setup_logger("TelegramDelivery")

MAX_UPLOAD_BYTES = 2_000_000_000


def _segment_manifest_from_payload(payload: dict[str, Any]) -> TelegramDeliverySegmentManifest:
    if set(payload) != {
        "parts",
        "segmentDir",
        "sourceFileMtimeNs",
        "sourceFileSize",
    }:
        raise ValueError("分段清单字段无效")
    raw_parts = payload.get("parts")
    if not isinstance(raw_parts, list):
        raise ValueError("分段文件列表无效")
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
            raise ValueError("分段文件字段无效")
        if not isinstance(raw["index"], int) or isinstance(raw["index"], bool):
            raise ValueError("分段索引无效")
        if not isinstance(raw["fileSize"], int) or isinstance(raw["fileSize"], bool):
            raise ValueError("分段大小无效")
        if set(raw) == video_fields and any(
            not isinstance(raw[field], int)
            or isinstance(raw[field], bool)
            or raw[field] < 1
            for field in ("videoWidth", "videoHeight", "durationSeconds")
        ):
            raise ValueError("分段视频元数据无效")
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
    source_file_size = payload["sourceFileSize"]
    source_file_mtime_ns = payload["sourceFileMtimeNs"]
    if not isinstance(source_file_size, int) or isinstance(source_file_size, bool):
        raise ValueError("源文件大小无效")
    if (
        isinstance(source_file_mtime_ns, bool)
        or not str(source_file_mtime_ns).isdigit()
    ):
        raise ValueError("源文件时间无效")
    return TelegramDeliverySegmentManifest(
        source_file_size=source_file_size,
        source_file_mtime_ns=int(str(source_file_mtime_ns)),
        segment_dir=str(payload["segmentDir"]),
        parts=tuple(parts),
    )


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def utc_after(seconds: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _iso_datetime(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def _media_kind(path: str) -> str:
    ext = Path(path).suffix.lower()
    if ext in {".mp4", ".mkv", ".webm", ".mov", ".m4v", ".avi"}:
        return "video"
    if ext in {".mp3", ".m4a", ".aac", ".flac", ".ogg", ".wav"}:
        return "audio"
    return "document"


def probe_readable_file(path: str) -> dict[str, Any]:
    """Open the final file and inspect the descriptor, not a path-only stat."""
    with open(path, "rb") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise OSError("download output is not a regular file")
        return {"isFile": True, "size": int(info.st_size), "mtimeNs": int(info.st_mtime_ns)}


async def probe_readable_file_async(path: str, *, timeout_seconds: float = 2.0) -> dict[str, Any]:
    return await asyncio.wait_for(
        asyncio.to_thread(probe_readable_file, path), timeout=max(0.1, timeout_seconds)
    )


class TelegramDeliveryService:
    def __init__(
        self,
        config: JsonConfig,
        store: TelegramDeliveryStore,
        *,
        now: Callable[[], str] = utc_now,
        new_id: Optional[Callable[[], str]] = None,
        probe: Callable[[str], dict[str, Any]] = probe_readable_file,
        async_probe: Callable[[str], Awaitable[dict[str, Any]]] = probe_readable_file_async,
    ) -> None:
        self.config = config
        self.store = store
        self._now = now
        self._probe = probe
        self._async_probe = async_probe
        self._lock = threading.RLock()
        self._emit: Callable[[str, dict[str, Any]], None] = lambda _event, _payload: None

    def set_event_emitter(self, emitter: Callable[[str, dict[str, Any]], None]) -> None:
        self._emit = emitter

    @staticmethod
    def _to_summary(record: TelegramDeliveryRecord) -> dict[str, Any]:
        return {
            "id": record.id,
            "taskId": record.task_id,
            "accountId": record.account_id,
            "targetChatId": record.target_chat_id,
            "targetChatType": record.target_chat_type,
            "targetChatTitle": record.target_chat_title,
            "sourceUrl": record.source_url,
            "title": record.title,
            "status": record.status,
            "attemptCount": record.attempt_count,
            "fallbackUsed": record.fallback_used,
            "nextAttemptAt": record.next_attempt_at,
            "lastErrorCode": record.last_error_code,
            "lastErrorMessage": record.last_error_message,
            "telegramMessageId": record.telegram_message_id,
            "createdAt": record.created_at,
            "updatedAt": record.updated_at,
            "sentAt": record.sent_at,
        }

    @classmethod
    def _to_claim(cls, record: TelegramDeliveryRecord, lease_id: str) -> dict[str, Any]:
        return {
            "delivery": {
                "id": record.id,
                "taskId": record.task_id,
                "accountId": record.account_id,
                "targetChatId": record.target_chat_id,
                "targetChatType": record.target_chat_type,
                "targetChatTitle": record.target_chat_title,
                "sourceUrl": record.source_url,
                "title": record.title,
                "filePath": record.file_path,
                "fileSize": record.file_size,
                "fileMtimeNs": str(record.file_mtime_ns),
                "mediaKind": record.media_kind,
                "attemptCount": record.attempt_count,
                "retrySequenceCount": record.retry_sequence_count,
                "fallbackUsed": record.fallback_used,
                "segmentManifest": (
                    {
                        "sourceFileSize": record.segment_manifest.source_file_size,
                        "sourceFileMtimeNs": str(record.segment_manifest.source_file_mtime_ns),
                        "segmentDir": record.segment_manifest.segment_dir,
                        "parts": [
                            {
                                "index": part.index,
                                "fileName": part.file_name,
                                "fileSize": part.file_size,
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
                            for part in record.segment_manifest.parts
                        ],
                    }
                    if record.segment_manifest is not None
                    else None
                ),
                "segmentNextIndex": record.segment_next_index,
                "segmentMessageIds": list(record.segment_message_ids),
            },
            "leaseId": lease_id,
        }

    def _emit_record(self, event: str, record: TelegramDeliveryRecord) -> None:
        try:
            self._emit(event, self._to_summary(record))
        except Exception as exc:
            logger.warning("delivery event emit failed: %s", exc)

    def _config(self) -> dict[str, Any]:
        return self.config.telegram_config()

    def get_config(self) -> dict[str, Any]:
        return self._config()

    def lease_deadline(self, seconds: int = 45) -> str:
        return utc_after(seconds)

    def configure(self, patch: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            return self.config.configure_telegram(patch, now=self._now())

    def _draft_for_task(self, task: DownloadTask, snapshot: Optional[dict[str, Any]] = None) -> Optional[TelegramDeliveryDraft]:
        cfg = snapshot or self._config()
        if not cfg.get("autoSendEnabled") or cfg.get("deliveryRecoveryHold") is not None:
            return None
        account = str(cfg.get("accountId") or "").strip()
        target = str(cfg.get("targetChatId") or "").strip()
        verified = str(cfg.get("targetVerifiedAt") or "").strip()
        if not account or not target or not verified:
            return None
        completed_at = task.completed_at
        enabled_at = _iso_datetime(cfg.get("enabledAt"))
        if completed_at is not None and enabled_at is not None:
            if completed_at.tzinfo is None:
                completed_at = completed_at.replace(tzinfo=timezone.utc)
            if completed_at < enabled_at:
                return None
        if not task.file_path:
            return None
        try:
            snapshot_file = self._probe(task.file_path)
        except (OSError, ValueError):
            return None
        return TelegramDeliveryDraft(
            task_id=task.id,
            account_id=account,
            target_chat_id=target,
            target_chat_type=str(cfg.get("targetChatType") or "private"),
            target_chat_title=str(cfg.get("targetChatTitle") or ""),
            source_url=task.video_info.url,
            title=task.video_info.title,
            file_path=os.path.abspath(task.file_path),
            file_size=int(snapshot_file["size"]),
            file_mtime_ns=int(snapshot_file["mtimeNs"]),
            media_kind=_media_kind(task.file_path),
        )

    def mark_processing(self, task: DownloadTask, owner_id: str, lease_expires_at: str) -> None:
        self.store.mark_processing(task.id, owner_id, lease_expires_at)

    def mark_processing_failed(
        self,
        task: DownloadTask,
        owner_id: str,
        error_message: str,
    ) -> Optional[dict[str, Any]]:
        with self._lock:
            draft = self._draft_for_task(task, self._config())
            result = self.store.mark_processing_failed(
                task_id=task.id,
                owner_id=owner_id,
                draft=draft,
                failed_at=self._now(),
                error_message=error_message,
            )
        if result is None or result.delivery_record is None:
            return None
        self._emit_record("telegramDelivery.failed", result.delivery_record)
        return self._to_summary(result.delivery_record)

    def renew_processing(self, task_id: str, owner_id: str, lease_expires_at: str) -> None:
        self.store.renew_processing(task_id, owner_id, lease_expires_at)

    def mark_ready(self, task: DownloadTask, owner_id: Optional[str] = None, *, refresh_config: bool = False) -> Optional[dict[str, Any]]:
        # Configuration changes arrive through the Sidecar request thread while
        # a download completion is delivered from a worker thread.  Hold the
        # same service lock used by configure/claim so a disable, target switch,
        # or account replacement cannot be interleaved between taking the
        # routing snapshot and committing the delivery row.
        with self._lock:
            try:
                # The probe happens before acquiring the SQLite writer fence.
                if not task.file_path:
                    draft = None
                else:
                    snap = self._probe(task.file_path)
                    cfg = self._config()
                    if refresh_config:
                        self.config.reload_from_disk()
                        cfg = self._config()
                    draft = self._draft_for_task(task, cfg)
                    if draft is not None:
                        draft = replace(draft, file_size=int(snap["size"]), file_mtime_ns=int(snap["mtimeNs"]))
                result = self.store.record_output_ready_and_enqueue(task.id, draft, self._now(), owner_id)
            except (OSError, DeliveryStateConflict, DeliveryNotFound) as exc:
                logger.warning("mark output ready deferred for %s: %s", task.id, exc)
                return None
        if result.record is not None:
            event = "telegramDelivery.failed" if result.record.status == TelegramDeliveryStatus.FAILED.value else "telegramDelivery.queued" if result.created else "telegramDelivery.updated"
            self._emit_record(event, result.record)
        return self._to_summary(result.record) if result.record else None

    def list_summaries(self, *, offset: int, limit: int, status: Optional[str]) -> dict[str, Any]:
        page = self.store.list_deliveries(offset=offset, limit=limit, status=status)
        return {
            "items": [self._to_summary(record) for record in page.items],
            "total": page.total,
            "offset": page.offset,
            "limit": page.limit,
        }

    def claim_next(self, *, account_id: str, now: str, lease_id: str, lease_expires_at: str) -> Optional[dict[str, Any]]:
        with self._lock:
            cfg = self._config()
            hold = cfg.get("deliveryRecoveryHold")
            if not cfg.get("autoSendEnabled") or hold is not None or str(cfg.get("accountId") or "") != str(account_id):
                return None
            record = self.store.claim_next(account_id=account_id, now=now, lease_id=lease_id, lease_expires_at=lease_expires_at)
        if record is not None:
            self._emit_record("telegramDelivery.updated", record)
            return self._to_claim(record, lease_id)
        return None

    def renew_lease(self, delivery_id: str, lease_id: str, lease_expires_at: str) -> None:
        record = self.store.renew_lease(delivery_id, lease_id, lease_expires_at)
        self._emit_record("telegramDelivery.updated", record)

    def release_claim(self, delivery_id: str, lease_id: str, released_at: str) -> dict[str, Any]:
        record = self.store.release_claim(delivery_id, lease_id, released_at)
        self._emit_record("telegramDelivery.updated", record)
        return self._to_summary(record)

    def mark_sending(self, delivery_id: str, lease_id: str, request_started_at: str, media_kind: str, fallback_used: bool, charge_attempt: bool) -> dict[str, Any]:
        record = self.store.mark_sending(delivery_id, lease_id, request_started_at, media_kind, fallback_used, charge_attempt)
        self._emit_record("telegramDelivery.updated", record)
        return self._to_summary(record)

    def set_segment_manifest(
        self,
        delivery_id: str,
        lease_id: str,
        manifest_payload: dict[str, Any],
        prepared_at: str,
    ) -> dict[str, Any]:
        manifest = _segment_manifest_from_payload(manifest_payload)
        record = self.store.set_segment_manifest(
            delivery_id, lease_id, manifest, prepared_at
        )
        self._emit_record("telegramDelivery.updated", record)
        return self._to_claim(record, lease_id)["delivery"]

    def mark_segment_sent(
        self,
        delivery_id: str,
        lease_id: str,
        segment_index: int,
        message_id: str,
        sent_at: str,
    ) -> dict[str, Any]:
        record = self.store.mark_segment_sent(
            delivery_id, lease_id, segment_index, message_id, sent_at
        )
        self._emit_record(
            "telegramDelivery.sent"
            if record.status == TelegramDeliveryStatus.SENT.value
            else "telegramDelivery.updated",
            record,
        )
        return self._to_summary(record)

    def mark_fallback_used(self, delivery_id: str, lease_id: str) -> dict[str, Any]:
        record = self.store.mark_fallback_used(delivery_id, lease_id)
        self._emit_record("telegramDelivery.updated", record)
        return self._to_summary(record)

    def mark_sent(self, delivery_id: str, lease_id: str, message_id: str, sent_at: str) -> dict[str, Any]:
        record = self.store.mark_sent(delivery_id, lease_id, message_id, sent_at)
        self._emit_record("telegramDelivery.sent", record)
        return self._to_summary(record)

    def mark_skipped_oversize(self, delivery_id: str, lease_id: str, message_id: str, sent_at: str) -> dict[str, Any]:
        record = self.store.mark_skipped_oversize(delivery_id, lease_id, message_id, sent_at)
        self._emit_record("telegramDelivery.sent", record)
        return self._to_summary(record)

    def mark_retry(self, delivery_id: str, lease_id: str, code: str, message: str, next_attempt_at: str) -> dict[str, Any]:
        record = self.store.mark_retry(delivery_id, lease_id, code, message, next_attempt_at)
        self._emit_record("telegramDelivery.updated", record)
        return self._to_summary(record)

    def mark_retry_not_submitted(self, delivery_id: str, lease_id: str, code: str, message: str, next_attempt_at: str) -> dict[str, Any]:
        record = self.store.mark_retry_not_submitted(delivery_id, lease_id, code, message, next_attempt_at)
        self._emit_record("telegramDelivery.updated", record)
        return self._to_summary(record)

    def mark_failed(self, delivery_id: str, lease_id: str, code: str, message: str, failed_at: str) -> dict[str, Any]:
        record = self.store.mark_failed(delivery_id, lease_id, code, message, failed_at)
        self._emit_record("telegramDelivery.failed", record)
        return self._to_summary(record)

    def mark_uncertain(self, delivery_id: str, lease_id: str, code: str, message: str, failed_at: str) -> dict[str, Any]:
        record = self.store.mark_uncertain(delivery_id, lease_id, code, message, failed_at)
        self._emit_record("telegramDelivery.uncertain", record)
        return self._to_summary(record)

    def mark_target_failed(self, delivery_id: str, lease_id: str, account_id: str, target_chat_id: str, code: str, message: str, failed_at: str) -> list[dict[str, Any]]:
        records = self.store.block_target_and_fail_pending(delivery_id=delivery_id, lease_id=lease_id, account_id=account_id, target_chat_id=target_chat_id, code=code, safe_message=message, failed_at=failed_at)
        for record in records:
            self._emit_record("telegramDelivery.failed", record)
        return [self._to_summary(record) for record in records]

    def get_target_block(self, account_id: str, target_chat_id: str) -> Optional[dict[str, Any]]:
        block = self.store.get_target_block(account_id, target_chat_id)
        if block is None:
            return None
        return {"accountId": block.account_id, "targetChatId": block.target_chat_id, "errorCode": block.error_code, "errorMessage": block.error_message, "blockedAt": block.blocked_at}

    def clear_target_block(self, account_id: str, target_chat_id: str) -> bool:
        return self.store.clear_target_block(account_id, target_chat_id)

    async def retry(self, delivery_id: str, *, confirm_possible_duplicate: bool, confirm_interrupted_output: bool) -> dict[str, Any]:
        with self._lock:
            current = self.store.get_for_retry(delivery_id)
            cfg = self._config()
            if cfg.get("deliveryRecoveryHold") is not None or str(cfg.get("accountId") or "") != current.account_id:
                raise DeliveryStateConflict("delivery belongs to another account or recovery is active")
        refreshed: Optional[tuple[int, int, str]] = None
        if current.last_error_code in {"FILE_CHANGED", "FILE_MISSING", "FILE_UNREADABLE", "POSTPROCESS_INTERRUPTED"}:
            first = await self._async_probe(current.file_path)
            await asyncio.sleep(0.25)
            second = await self._async_probe(current.file_path)
            if first["size"] != second["size"] or first["mtimeNs"] != second["mtimeNs"]:
                raise DeliveryStateConflict("文件仍在变化，请稍后重试")
            refreshed = (int(second["size"]), int(second["mtimeNs"]), _media_kind(current.file_path))
        with self._lock:
            cfg = self._config()
            if cfg.get("deliveryRecoveryHold") is not None or str(cfg.get("accountId") or "") != current.account_id:
                raise DeliveryStateConflict("delivery changed while probing")
            record = self.store.retry(
                delivery_id=delivery_id,
                now=self._now(),
                confirm_possible_duplicate=confirm_possible_duplicate,
                confirm_interrupted_output=confirm_interrupted_output,
                expected_account_id=current.account_id,
                expected_status=current.status,
                expected_error_code=current.last_error_code,
                expected_updated_at=current.updated_at,
                expected_file_path=current.file_path,
                refreshed_file_size=refreshed[0] if refreshed else None,
                refreshed_file_mtime_ns=refreshed[1] if refreshed else None,
                refreshed_media_kind=refreshed[2] if refreshed else None,
            )
        self._emit_record("telegramDelivery.updated", record)
        return self._to_summary(record)

    def cancel_pending(self, account_id: Optional[str]) -> int:
        # Keep cancellation linear with mark_ready: a download completion must
        # not enqueue an old-account/old-target row after disconnect or account
        # replacement has begun cancelling that account.
        with self._lock:
            records = self.store.cancel_pending(account_id=account_id, now=self._now())
        for record in records:
            self._emit_record("telegramDelivery.updated", record)
        return len(records)

    def recover_delivery_leases(self) -> RecoveryResult:
        return self.store.recover_delivery_leases(self._now())

    def _draft_for_record(self, record: DownloadRecord) -> Optional[TelegramDeliveryDraft]:
        cfg = self._config()
        if not cfg.get("autoSendEnabled") or cfg.get("deliveryRecoveryHold") is not None:
            return None
        account = str(cfg.get("accountId") or "").strip()
        target = str(cfg.get("targetChatId") or "").strip()
        verified = str(cfg.get("targetVerifiedAt") or "").strip()
        if not account or not target or not verified or not record.file_path:
            return None
        enabled_at = _iso_datetime(cfg.get("enabledAt"))
        completed_at = record.completed_at
        if enabled_at is not None and completed_at is not None:
            if completed_at.tzinfo is None:
                completed_at = completed_at.replace(tzinfo=timezone.utc)
            if completed_at < enabled_at:
                return None
        try:
            snap = self._probe(record.file_path)
        except (OSError, ValueError):
            return None
        return TelegramDeliveryDraft(
            task_id=record.id,
            account_id=account,
            target_chat_id=target,
            target_chat_type=str(cfg.get("targetChatType") or "private"),
            target_chat_title=str(cfg.get("targetChatTitle") or ""),
            source_url=record.url,
            title=record.title,
            file_path=os.path.abspath(record.file_path),
            file_size=int(snap["size"]),
            file_mtime_ns=int(snap["mtimeNs"]),
            media_kind=_media_kind(record.file_path),
        )

    def recover_output_records(self) -> RecoveryResult:
        """Reconcile output handoffs left by a killed Sidecar before accepting work."""
        scan = self.open_output_recovery_scan()
        if scan is None:
            return RecoveryResult()
        interrupted = 0
        recovered_ready = 0
        expired_records = self.store.list_expired_processing_outputs(
            recovered_at=scan.recovered_at,
            high_water_history_rowid=scan.high_water_history_rowid,
            after=None,
            limit=500,
        )
        for record in expired_records:
            result = self.store.resolve_expired_processing_output(
                task_id=record.id,
                expected_owner_id=record.output_owner_id,
                expected_lease_expires_at=record.output_lease_expires_at,
                draft=self._draft_for_record(record),
                recovered_at=scan.recovered_at,
            )
            if result is not None:
                interrupted += 1
                if result.delivery_record is not None:
                    self._emit_record("telegramDelivery.failed", result.delivery_record)
        for record in self.store.recover_unmarked_outputs(
            high_water_history_rowid=scan.high_water_history_rowid,
            after=None,
            limit=500,
        ):
            if self.store.record_output_ready_and_enqueue(
                record.id,
                self._draft_for_record(record),
                scan.recovered_at,
                None,
            ).record is not None:
                recovered_ready += 1
        return RecoveryResult(
            recovered_ready_count=recovered_ready,
            interrupted_task_ids=tuple(record.id for record in expired_records),
        )

    def summaries_by_task(self) -> dict[str, dict[str, Any]]:
        page = self.store.list_deliveries(offset=0, limit=200)
        return {item.task_id: self._to_summary(item) for item in page.items}

    def open_output_recovery_scan(self) -> Optional[OutputRecoveryScan]:
        cfg = self._config()
        return OutputRecoveryScan(
            high_water_history_rowid=self.store.max_download_history_rowid(),
            recovered_at=self._now(),
            config=OutputRecoveryConfigSnapshot(
                revision=str(cfg.get("revision") or self.config.telegram_revision()),
                account_id=str(cfg.get("accountId") or "") or None,
                target_chat_id=str(cfg.get("targetChatId") or "") or None,
                target_chat_type=str(cfg.get("targetChatType") or "") or None,
                target_chat_title=str(cfg.get("targetChatTitle") or "") or None,
                target_verified_at=cfg.get("targetVerifiedAt"),
                auto_send_enabled=bool(cfg.get("autoSendEnabled")),
                enabled_at=cfg.get("enabledAt"),
                delivery_recovery_hold=cfg.get("deliveryRecoveryHold"),
            ),
        )
