"""HistoryDB 连接与读写测试。"""
from datetime import datetime

from src.data.database import HistoryDB
from src.data.models import DownloadRecord


def test_history_db_roundtrip(tmp_path):
    HistoryDB._instance = None
    db = HistoryDB(db_path=str(tmp_path / "t.db"))
    record = DownloadRecord(
        id="1",
        url="https://example.com",
        title="hello",
        platform="youtube",
        duration=10,
        thumbnail_url="",
        uploader="u",
        status="completed",
        file_path="/tmp/a.mp4",
        file_size=1,
        created_at=datetime.now(),
        started_at=None,
        completed_at=None,
        error_message="",
    )
    db.add_download_record(record)
    rows = db.get_all_download_records()
    assert len(rows) == 1
    assert rows[0].title == "hello"
    assert rows[0].file_path == "/tmp/a.mp4"
    found = db.search_download_records("hello")
    assert len(found) == 1
    db.delete_download_record("1")
    assert db.get_all_download_records() == []
    HistoryDB._instance = None
