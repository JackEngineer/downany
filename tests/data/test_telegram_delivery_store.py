from datetime import datetime

from src.data.database import HistoryDB
from src.data.models import (
    DownloadRecord,
    TelegramDeliveryDraft,
    TelegramDeliverySegmentManifest,
    TelegramDeliverySegmentPart,
)
from src.data.telegram_delivery_store import DeliveryStateConflict, TelegramDeliveryStore


def test_output_ready_claim_and_sent_roundtrip(tmp_path):
    HistoryDB._instance = None


def test_segment_progress_survives_restart_without_resending_completed_parts(tmp_path):
    HistoryDB._instance = None
    db_path = tmp_path / "history.db"
    db = HistoryDB(db_path=str(db_path))
    output = tmp_path / "large.mp4"
    output.write_bytes(b"original-video")
    created = datetime.now()
    db.add_download_record(
        DownloadRecord(
            id="task-segmented",
            url="https://example.com/large",
            title="Large video",
            platform="youtube",
            duration=300,
            thumbnail_url="",
            uploader="tester",
            status="completed",
            file_path=str(output),
            file_size=output.stat().st_size,
            created_at=created,
            started_at=None,
            completed_at=created,
            error_message="",
            output_recovery_safe=True,
        )
    )
    store = TelegramDeliveryStore(str(db_path))
    draft = TelegramDeliveryDraft(
        task_id="task-segmented",
        account_id="42",
        target_chat_id="-100123",
        target_chat_type="supergroup",
        target_chat_title="Test",
        source_url="https://example.com/large",
        title="Large video",
        file_path=str(output),
        file_size=output.stat().st_size,
        file_mtime_ns=output.stat().st_mtime_ns,
        media_kind="video",
    )
    queued = store.record_output_ready_and_enqueue(
        "task-segmented", draft, "2026-01-01T00:00:00Z", None
    )
    assert queued.record is not None
    claimed = store.claim_next(
        account_id="42",
        now="2026-01-01T00:00:01Z",
        lease_id="lease-segment-1",
        lease_expires_at="2026-01-01T00:00:10Z",
    )
    assert claimed is not None

    segment_dir = tmp_path / "telegram" / "segments" / claimed.id / "ready"
    segment_dir.mkdir(parents=True)
    parts = []
    for index, content in enumerate((b"part-one", b"part-two", b"part-three")):
        part_path = segment_dir / f"part-{index + 1:04d}.mp4"
        part_path.write_bytes(content)
        parts.append(
            TelegramDeliverySegmentPart(
                index=index,
                file_name=part_path.name,
                file_size=len(content),
                sha256=("a", "b", "c")[index] * 64,
                video_width=1920,
                video_height=1080,
                duration_seconds=135 - index,
            )
        )
    manifest = TelegramDeliverySegmentManifest(
        source_file_size=output.stat().st_size,
        source_file_mtime_ns=output.stat().st_mtime_ns,
        segment_dir=str(segment_dir),
        parts=tuple(parts),
    )
    prepared = store.set_segment_manifest(
        claimed.id,
        "lease-segment-1",
        manifest,
        "2026-01-01T00:00:02Z",
    )
    assert prepared.segment_manifest == manifest
    assert prepared.segment_next_index == 0
    assert prepared.segment_message_ids == ()

    store.mark_sending(
        claimed.id,
        "lease-segment-1",
        "2026-01-01T00:00:03Z",
        "video",
        False,
        True,
    )
    first = store.mark_segment_sent(
        claimed.id,
        "lease-segment-1",
        0,
        "101",
        "2026-01-01T00:00:04Z",
    )
    assert first.status == "preparing"
    assert first.segment_next_index == 1
    assert first.segment_message_ids == ("101",)

    recovery = store.recover_delivery_leases("2026-01-01T00:00:11Z")
    assert recovery.requeued_count == 1
    resumed = store.claim_next(
        account_id="42",
        now="2026-01-01T00:00:12Z",
        lease_id="lease-segment-2",
        lease_expires_at="2026-01-01T00:01:00Z",
    )
    assert resumed is not None
    assert resumed.segment_next_index == 1
    assert resumed.segment_message_ids == ("101",)
    assert resumed.segment_manifest == manifest

    for index, message_id in ((1, "102"), (2, "103")):
        store.mark_sending(
            resumed.id,
            "lease-segment-2",
            f"2026-01-01T00:00:{13 + index:02d}Z",
            "video",
            False,
            index == 1,
        )
        resumed = store.mark_segment_sent(
            resumed.id,
            "lease-segment-2",
            index,
            message_id,
            f"2026-01-01T00:00:{15 + index:02d}Z",
        )

    assert resumed.status == "sent"
    assert resumed.segment_next_index == 3
    assert resumed.segment_message_ids == ("101", "102", "103")
    assert resumed.telegram_message_id == "103"
    assert resumed.lease_id is None
    assert output.read_bytes() == b"original-video"
    HistoryDB._instance = None
    db_path = tmp_path / "history.db"
    db = HistoryDB(db_path=str(db_path))
    output = tmp_path / "clip.mp4"
    output.write_bytes(b"clip")
    db.add_download_record(
        DownloadRecord(
            id="task-1",
            url="https://example.com/video",
            title="Clip",
            platform="youtube",
            duration=1,
            thumbnail_url="",
            uploader="tester",
            status="completed",
            file_path=str(output),
            file_size=4,
            created_at=datetime.now(),
            started_at=None,
            completed_at=datetime.now(),
            error_message="",
            output_recovery_safe=True,
        )
    )
    store = TelegramDeliveryStore(str(db_path))
    draft = TelegramDeliveryDraft(
        task_id="task-1",
        account_id="42",
        target_chat_id="-100123",
        target_chat_type="supergroup",
        target_chat_title="Test",
        source_url="https://example.com/video",
        title="Clip",
        file_path=str(output),
        file_size=4,
        file_mtime_ns=output.stat().st_mtime_ns,
        media_kind="video",
    )
    queued = store.record_output_ready_and_enqueue("task-1", draft, "2026-01-01T00:00:00Z", None)
    assert queued.created is True
    assert queued.record is not None
    assert queued.record.status == "pending"

    claim = store.claim_next(
        account_id="42",
        now="2026-01-01T00:00:01Z",
        lease_id="lease-1",
        lease_expires_at="2026-01-01T00:01:00Z",
    )
    assert claim is not None
    assert claim.status == "preparing"
    # Use the real generated id so the test does not depend on UUID formatting.
    delivery_id = claim.id
    sending = store.mark_sending(delivery_id, "lease-1", "2026-01-01T00:00:02Z", "video", False, True)
    assert sending.status == "sending"
    sent = store.mark_sent(delivery_id, "lease-1", "99", "2026-01-01T00:00:03Z")
    assert sent.status == "sent"
    assert sent.telegram_message_id == "99"
    try:
        store.retry(
            delivery_id=delivery_id,
            now="2026-01-01T00:00:04Z",
            confirm_possible_duplicate=False,
            confirm_interrupted_output=False,
            expected_account_id=sent.account_id,
            expected_status=sent.status,
            expected_error_code=sent.last_error_code,
            expected_updated_at=sent.updated_at,
            expected_file_path=sent.file_path,
        )
    except DeliveryStateConflict as exc:
        assert "failed or uncertain" in str(exc)
    else:
        raise AssertionError("sent delivery must not be retried")

    output2 = tmp_path / "clip-2.mp4"
    output2.write_bytes(b"clip2")
    db.add_download_record(
        DownloadRecord(
            id="task-2",
            url="https://example.com/video-2",
            title="Clip 2",
            platform="youtube",
            duration=1,
            thumbnail_url="",
            uploader="tester",
            status="completed",
            file_path=str(output2),
            file_size=5,
            created_at=datetime.now(),
            started_at=None,
            completed_at=datetime.now(),
            error_message="",
            output_recovery_safe=True,
        )
    )
    draft2 = TelegramDeliveryDraft(
        task_id="task-2", account_id="42", target_chat_id="-100123",
        target_chat_type="supergroup", target_chat_title="Test",
        source_url="https://example.com/video-2", title="Clip 2",
        file_path=str(output2), file_size=5, file_mtime_ns=output2.stat().st_mtime_ns,
        media_kind="video",
    )
    store.record_output_ready_and_enqueue("task-2", draft2, "2026-01-01T00:00:04Z", None)
    claim2 = store.claim_next(account_id="42", now="2026-01-01T00:00:05Z", lease_id="lease-2", lease_expires_at="2099-01-01T00:00:00Z")
    assert claim2 is not None
    store.mark_sending(claim2.id, "lease-2", "2026-01-01T00:00:06Z", "video", False, True)
    recovery = store.recover_delivery_leases("2026-01-01T00:00:07Z")
    assert recovery.uncertain_count == 1
    assert store.get_for_retry(claim2.id).last_error_code == "APP_RESTART_RESULT_UNKNOWN"
    HistoryDB._instance = None
