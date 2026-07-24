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


def _record(record_id: str, title: str, status: str = "completed") -> DownloadRecord:
    return DownloadRecord(
        id=record_id,
        url=f"https://example.com/{record_id}",
        title=title,
        platform="youtube",
        duration=10,
        thumbnail_url="",
        uploader="u",
        status=status,
        file_path=f"/tmp/{record_id}.mp4",
        file_size=1,
        created_at=datetime.now(),
        started_at=None,
        completed_at=None,
        error_message="",
    )


def test_list_download_records_pagination_and_filters(tmp_path):
    HistoryDB._instance = None
    db = HistoryDB(db_path=str(tmp_path / "p.db"))
    db.add_download_record(_record("a", "alpha", "completed"))
    db.add_download_record(_record("b", "beta", "failed"))
    db.add_download_record(_record("c", "gamma", "completed"))

    page = db.list_download_records(offset=0, limit=2)
    assert len(page) == 2
    filtered = db.list_download_records(offset=0, limit=10, status="failed")
    assert [r.id for r in filtered] == ["b"]
    searched = db.list_download_records(offset=0, limit=10, query="gam")
    assert [r.id for r in searched] == ["c"]
    HistoryDB._instance = None


def test_clear_and_delete_many(tmp_path):
    HistoryDB._instance = None
    db = HistoryDB(db_path=str(tmp_path / "c.db"))
    db.add_download_record(_record("1", "one"))
    db.add_download_record(_record("2", "two"))
    db.add_download_record(_record("3", "three"))
    db.delete_download_records(["1", "3"])
    assert [r.id for r in db.get_all_download_records()] == ["2"]
    db.clear_download_history()
    assert db.get_all_download_records() == []
    HistoryDB._instance = None
