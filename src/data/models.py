"""
数据库模型定义。
"""
from dataclasses import dataclass
from enum import Enum
from typing import Literal, Optional, Protocol, TypeVar
from datetime import datetime


class OutputState(str, Enum):
    PENDING = "pending"
    PROCESSING = "processing"
    READY = "ready"
    INTERRUPTED = "interrupted"


class TelegramDeliveryStatus(str, Enum):
    PENDING = "pending"
    PREPARING = "preparing"
    SENDING = "sending"
    RETRY_WAIT = "retry_wait"
    SENT = "sent"
    FAILED = "failed"
    UNCERTAIN = "uncertain"
    CANCELLED = "cancelled"
    SKIPPED_OVERSIZE = "skipped_oversize"


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
    output_state: str = OutputState.PENDING.value
    output_ready_at: Optional[str] = None
    output_recovery_safe: bool = False
    output_owner_id: Optional[str] = None
    output_lease_expires_at: Optional[str] = None


@dataclass(frozen=True)
class TelegramDeliveryDraft:
    task_id: str
    account_id: str
    target_chat_id: str
    target_chat_type: str
    target_chat_title: str
    source_url: str
    title: str
    file_path: str
    file_size: int
    file_mtime_ns: int
    media_kind: str


@dataclass(frozen=True)
class TelegramDeliverySegmentPart:
    index: int
    file_name: str
    file_size: int
    sha256: str
    video_width: Optional[int] = None
    video_height: Optional[int] = None
    duration_seconds: Optional[int] = None


@dataclass(frozen=True)
class TelegramDeliverySegmentManifest:
    source_file_size: int
    source_file_mtime_ns: int
    segment_dir: str
    parts: tuple[TelegramDeliverySegmentPart, ...]


@dataclass(frozen=True)
class TelegramDeliveryRecord:
    id: str
    task_id: str
    account_id: str
    target_chat_id: str
    target_chat_type: str
    target_chat_title: str
    source_url: str
    title: str
    file_path: str
    file_size: int
    file_mtime_ns: int
    media_kind: str
    status: str
    attempt_count: int
    retry_sequence_count: int
    request_attempt_charged: bool
    fallback_used: bool
    next_attempt_at: Optional[str]
    lease_id: Optional[str]
    lease_expires_at: Optional[str]
    request_started_at: Optional[str]
    last_error_code: str
    last_error_message: str
    telegram_message_id: Optional[str]
    created_at: str
    updated_at: str
    sent_at: Optional[str]
    segment_manifest: Optional[TelegramDeliverySegmentManifest] = None
    segment_next_index: int = 0
    segment_message_ids: tuple[str, ...] = ()


@dataclass(frozen=True)
class OutputReadyEnqueueResult:
    record: Optional[TelegramDeliveryRecord]
    created: bool


@dataclass(frozen=True)
class TelegramDeliveryPage:
    items: tuple[TelegramDeliveryRecord, ...]
    total: int
    offset: int
    limit: int


@dataclass(frozen=True)
class TelegramTargetBlock:
    account_id: str
    target_chat_id: str
    error_code: str
    error_message: str
    blocked_at: str


@dataclass(frozen=True)
class RecoveryResult:
    requeued_count: int = 0
    uncertain_count: int = 0
    recovered_ready_count: int = 0
    recovered_unmarked_count: int = 0
    interrupted_task_ids: tuple[str, ...] = ()


WriterFenceResult = TypeVar("WriterFenceResult")


@dataclass(frozen=True)
class ExpiredProcessingResolution:
    history_record: "DownloadRecord"
    delivery_record: Optional[TelegramDeliveryRecord]
    delivery_created: bool


class TelegramDeliveryWriterFence(Protocol):
    def record_output_ready_and_enqueue(
        self,
        task_id: str,
        draft: Optional[TelegramDeliveryDraft],
        ready_at: str,
        owner_id: Optional[str],
    ) -> OutputReadyEnqueueResult: ...

    def resolve_expired_processing_output(
        self,
        *,
        task_id: str,
        expected_owner_id: Optional[str],
        expected_lease_expires_at: Optional[str],
        draft: Optional[TelegramDeliveryDraft],
        recovered_at: str,
    ) -> Optional[ExpiredProcessingResolution]: ...


@dataclass(frozen=True)
class OutputRecoveryHoldSnapshot:
    account_id: str
    intent: str
    created_at: str


@dataclass(frozen=True)
class OutputRecoveryConfigSnapshot:
    revision: str
    account_id: Optional[str]
    target_chat_id: Optional[str]
    target_chat_type: Optional[str]
    target_chat_title: Optional[str]
    target_verified_at: Optional[str]
    auto_send_enabled: bool
    enabled_at: Optional[str]
    delivery_recovery_hold: object


@dataclass(frozen=True)
class OutputRecoveryScan:
    high_water_history_rowid: int
    recovered_at: str
    config: OutputRecoveryConfigSnapshot


@dataclass
class SearchRecord:
    """搜索历史记录"""
    id: int
    platform: str
    query: str
    searched_at: datetime
