"""旧数据迁移测试。"""
import plistlib
import sqlite3
from pathlib import Path

from src.data.json_config import JsonConfig
from src.sidecar.migration import run_migration
from src.sidecar.paths import AppPaths


def _write_plist(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as fh:
        plistlib.dump(data, fh)


def _write_old_history(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as conn:
        conn.execute(
            """
            CREATE TABLE download_history (
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
        conn.execute(
            """
            INSERT INTO download_history
            VALUES ('r1', 'https://example.com/a', '旧视频', 'youtube', 10, '', 'u',
                    'completed', '/tmp/a.mp4', 1, '2026-01-01T00:00:00', NULL, NULL, '')
            """
        )
        conn.commit()


def test_migration_copies_config_and_history(tmp_path):
    home = tmp_path / "home"
    plist = home / "Library" / "Preferences" / "com.Trae.Downloader.plist"
    history = home / ".trae_downloader" / "history.db"
    _write_plist(
        plist,
        {
            "download_dir": str(tmp_path / "Downloads"),
            "concurrent_downloads": 5,
            "theme_mode": "dark",
            "proxy_enabled": False,
            "proxy_url": "",
            "default_quality": "720p",
            "download_subtitles": True,
            "speed_limit": 0,
        },
    )
    _write_old_history(history)

    paths = AppPaths(data_dir=tmp_path / "VideoDownloader", log_dir=tmp_path / "logs")
    result = run_migration(paths, home=home, old_plist=plist, old_history=history)
    assert result["status"] == "migrated"

    cfg = JsonConfig(str(paths.config_path))
    assert cfg.get_concurrent_downloads() == 5
    assert cfg.get_theme_mode() == "dark"
    assert cfg.is_download_subtitles() is True

    with sqlite3.connect(paths.history_db_path) as conn:
        row = conn.execute("SELECT title FROM download_history WHERE id='r1'").fetchone()
        assert row[0] == "旧视频"

    # 旧文件仍在
    assert plist.is_file()
    assert history.is_file()

    # 幂等
    again = run_migration(paths, home=home, old_plist=plist, old_history=history)
    assert again["status"] == "skipped"


def test_migration_no_old_data(tmp_path):
    paths = AppPaths(data_dir=tmp_path / "data", log_dir=tmp_path / "logs")
    missing_plist = tmp_path / "no.plist"
    missing_hist = tmp_path / "no.db"
    result = run_migration(
        paths,
        old_plist=missing_plist,
        old_history=missing_hist,
    )
    assert result["status"] == "skipped"
    assert (paths.data_dir / ".migration_v1_done").is_file()
