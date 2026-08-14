from datetime import datetime

from src.core.download_task import DownloadTask, Platform, TaskStatus, VideoInfo
from src.data.database import HistoryDB
from src.data.json_config import JsonConfig
from src.data.models import DownloadRecord
from src.data.telegram_delivery_store import TelegramDeliveryStore
from src.sidecar.telegram_delivery_service import TelegramDeliveryService


def test_mark_ready_uses_non_secret_config_and_enqueues(tmp_path):
    HistoryDB._instance = None
    db_path = tmp_path / "history.db"
    db = HistoryDB(db_path=str(db_path))
    output = tmp_path / "clip.mp4"
    output.write_bytes(b"clip")
    created = datetime.now()
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
            created_at=created,
            started_at=None,
            completed_at=created,
            error_message="",
            output_recovery_safe=True,
        )
    )
    config = JsonConfig(str(tmp_path / "config.json"))
    config.configure_telegram(
        {
            "accountId": "42",
            "botUsername": "downany_bot",
            "targetChatId": "-100123",
            "targetChatType": "supergroup",
            "targetChatTitle": "Test",
            "targetVerifiedAt": "2026-01-01T00:00:00Z",
            "autoSendEnabled": True,
        },
        now="2026-01-01T00:00:00Z",
    )
    service = TelegramDeliveryService(config, TelegramDeliveryStore(str(db_path)))
    task = DownloadTask(
        id="task-1",
        video_info=VideoInfo(
            url="https://example.com/video",
            title="Clip",
            platform=Platform.YOUTUBE,
        ),
        status=TaskStatus.COMPLETED,
        file_path=str(output),
        completed_at=created,
    )
    result = service.mark_ready(task, refresh_config=True)
    assert result is not None
    assert result["status"] == "pending"
    assert "token" not in str(config.to_dict()).lower()

    claim = service.claim_next(
        account_id="42",
        now="2026-01-01T00:00:01Z",
        lease_id="lease-service-segments",
        lease_expires_at="2026-01-01T00:02:00Z",
    )
    assert claim is not None
    assert claim["delivery"]["segmentManifest"] is None
    assert claim["delivery"]["segmentNextIndex"] == 0
    assert claim["delivery"]["segmentMessageIds"] == []

    segment_dir = tmp_path / "telegram" / "segments" / claim["delivery"]["id"] / "ready"
    segment_dir.mkdir(parents=True)
    prepared = service.set_segment_manifest(
        claim["delivery"]["id"],
        "lease-service-segments",
        {
            "sourceFileSize": output.stat().st_size,
            "sourceFileMtimeNs": output.stat().st_mtime_ns,
            "segmentDir": str(segment_dir),
            "parts": [
                {
                    "index": 0,
                    "fileName": "part-0001.mp4",
                    "fileSize": 4,
                    "sha256": "a" * 64,
                    "videoWidth": 1920,
                    "videoHeight": 1080,
                    "durationSeconds": 135,
                },
                {
                    "index": 1,
                    "fileName": "part-0002.mp4",
                    "fileSize": 4,
                    "sha256": "b" * 64,
                    "videoWidth": 1920,
                    "videoHeight": 1080,
                    "durationSeconds": 134,
                },
            ],
        },
        "2026-01-01T00:00:02Z",
    )
    assert prepared["segmentNextIndex"] == 0
    assert prepared["segmentMessageIds"] == []
    assert prepared["segmentManifest"]["parts"][1]["fileName"] == "part-0002.mp4"
    assert prepared["segmentManifest"]["parts"][1]["videoWidth"] == 1920
    assert prepared["segmentManifest"]["parts"][1]["videoHeight"] == 1080
    assert prepared["segmentManifest"]["parts"][1]["durationSeconds"] == 134
    HistoryDB._instance = None


def test_failed_postprocess_is_immediately_retryable(tmp_path):
    HistoryDB._instance = None
    db_path = tmp_path / "history.db"
    db = HistoryDB(db_path=str(db_path))
    output = tmp_path / "clip.mp4"
    output.write_bytes(b"clip")
    created = datetime.now()
    db.add_download_record(
        DownloadRecord(
            id="task-postprocess",
            url="https://example.com/video",
            title="Clip",
            platform="youtube",
            duration=1,
            thumbnail_url="",
            uploader="tester",
            status="completed",
            file_path=str(output),
            file_size=4,
            created_at=created,
            started_at=None,
            completed_at=created,
            error_message="",
            output_recovery_safe=True,
        )
    )
    config = JsonConfig(str(tmp_path / "config.json"))
    config.configure_telegram(
        {
            "accountId": "42",
            "botUsername": "downany_bot",
            "targetChatId": "-100123",
            "targetChatType": "supergroup",
            "targetChatTitle": "Test",
            "targetVerifiedAt": "2026-01-01T00:00:00Z",
            "autoSendEnabled": True,
        },
        now="2026-01-01T00:00:00Z",
    )
    service = TelegramDeliveryService(config, TelegramDeliveryStore(str(db_path)))
    task = DownloadTask(
        id="task-postprocess",
        video_info=VideoInfo(
            url="https://example.com/video",
            title="Clip",
            platform=Platform.YOUTUBE,
        ),
        status=TaskStatus.COMPLETED,
        file_path=str(output),
        completed_at=created,
    )

    service.mark_processing(task, "postprocess:task-postprocess", "2026-01-01T00:20:00Z")
    result = service.mark_processing_failed(
        task,
        "postprocess:task-postprocess",
        "post-process returned exit code 1",
    )

    assert result is not None
    assert result["status"] == "failed"
    assert result["lastErrorCode"] == "POSTPROCESS_INTERRUPTED"
    assert "exit code 1" in result["lastErrorMessage"]
    assert service.list_summaries(offset=0, limit=10, status="failed")["total"] == 1
    HistoryDB._instance = None
