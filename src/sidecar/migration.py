"""旧 Trae / VideoDownloader 数据 → Downany 迁移（幂等、复制不移动）。"""
from __future__ import annotations

import plistlib
import shutil
import sqlite3
import sys
from pathlib import Path
from typing import Any, Dict, Optional

from src.data.json_config import JsonConfig
from src.sidecar.paths import AppPaths
from src.utils.logger import setup_logger

logger = setup_logger("Migration")

MIGRATION_MARKER = ".migration_v1_done"
MIGRATION_VD_MARKER = ".migration_videodownloader_done"
OLD_PLIST_NAME = "com.Trae.Downloader.plist"
OLD_HISTORY_DIR = ".trae_downloader"
OLD_VIDEODL_APP_SUPPORT = "VideoDownloader"


def default_old_plist_path(home: Optional[Path] = None) -> Path:
    root = home or Path.home()
    return root / "Library" / "Preferences" / OLD_PLIST_NAME


def default_old_history_path(home: Optional[Path] = None) -> Path:
    root = home or Path.home()
    return root / OLD_HISTORY_DIR / "history.db"


def default_old_videodownloader_data_dir(home: Optional[Path] = None) -> Path:
    root = home or Path.home()
    return root / "Library" / "Application Support" / OLD_VIDEODL_APP_SUPPORT


def _read_plist(path: Path) -> Dict[str, Any]:
    if not path.is_file():
        return {}
    with path.open("rb") as fh:
        data = plistlib.load(fh)
    return data if isinstance(data, dict) else {}


def _normalize_download_dir(path: str) -> str:
    text = str(path or "")
    for old in ("TraeDownloader", "VideoDownloader"):
        if old in text:
            text = text.replace(old, "Downany")
    return text


def _map_plist_to_config(plist: Dict[str, Any]) -> Dict[str, Any]:
    """把旧 QSettings/plist 键映射到 JsonConfig 字段。"""
    mapped: Dict[str, Any] = {}
    key_map = {
        "download_dir": "download_dir",
        "concurrent_downloads": "concurrent_downloads",
        "speed_limit": "speed_limit",
        "proxy_enabled": "proxy_enabled",
        "proxy_url": "proxy_url",
        "default_quality": "default_quality",
        "download_subtitles": "download_subtitles",
        "theme_mode": "theme_mode",
    }
    for old_key, new_key in key_map.items():
        if old_key in plist:
            mapped[new_key] = plist[old_key]
    download_dir = mapped.get("download_dir")
    if isinstance(download_dir, str):
        mapped["download_dir"] = _normalize_download_dir(download_dir)
    return mapped


def _copy_history(src: Path, dest: Path) -> int:
    """复制 download_history 行到目标库；返回复制条数。"""
    if not src.is_file():
        return 0
    dest.parent.mkdir(parents=True, exist_ok=True)
    if not dest.is_file():
        shutil.copy2(src, dest)
        with sqlite3.connect(dest) as conn:
            row = conn.execute(
                "SELECT COUNT(*) FROM download_history"
            ).fetchone()
            return int(row[0]) if row else 0

    copied = 0
    with sqlite3.connect(src) as src_conn, sqlite3.connect(dest) as dest_conn:
        src_conn.row_factory = sqlite3.Row
        try:
            rows = src_conn.execute("SELECT * FROM download_history").fetchall()
        except sqlite3.Error:
            return 0
        dest_conn.execute(
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
                error_message TEXT
            )
            """
        )
        for row in rows:
            try:
                cursor = dest_conn.execute(
                    """
                    INSERT OR IGNORE INTO download_history
                    (id, url, title, platform, duration, thumbnail_url, uploader,
                     status, file_path, file_size, created_at, started_at,
                     completed_at, error_message)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        row["id"],
                        row["url"],
                        row["title"],
                        row["platform"],
                        row["duration"],
                        row["thumbnail_url"],
                        row["uploader"],
                        row["status"],
                        row["file_path"],
                        row["file_size"],
                        row["created_at"],
                        row["started_at"],
                        row["completed_at"],
                        row["error_message"],
                    ),
                )
                if cursor.rowcount and cursor.rowcount > 0:
                    copied += 1
            except (sqlite3.Error, KeyError) as exc:
                logger.error(
                    "跳过历史行 %s: %s",
                    row["id"] if "id" in row.keys() else "?",
                    exc,
                )
        dest_conn.commit()
    return copied


def _migrate_videodownloader_tree(
    paths: AppPaths,
    *,
    home: Optional[Path] = None,
) -> Dict[str, Any]:
    """把 Application Support/VideoDownloader 复制到 Downany（若目标尚空）。"""
    marker = paths.data_dir / MIGRATION_VD_MARKER
    if marker.is_file():
        return {"status": "skipped", "message": "VideoDownloader 迁移已完成"}

    old_data = default_old_videodownloader_data_dir(home)
    details: Dict[str, Any] = {"old_data": str(old_data)}
    if not old_data.is_dir():
        marker.write_text("ok\n", encoding="utf-8")
        return {
            "status": "skipped",
            "message": "未发现 VideoDownloader 数据目录",
            "details": details,
        }

    copied_files: list[str] = []
    for name in ("config.json", "history.db", "history.db-wal", "history.db-shm"):
        src = old_data / name
        dest = paths.data_dir / name
        if src.is_file() and not dest.exists():
            shutil.copy2(src, dest)
            copied_files.append(name)
            if name == "config.json":
                cfg = JsonConfig(str(dest))
                download_dir = cfg.get_download_dir()
                normalized = _normalize_download_dir(download_dir)
                if normalized != download_dir:
                    cfg.set_download_dir(normalized)

    # queue 表可能在 history.db；另拷贝 queue 相关若有独立文件则无

    marker.write_text("ok\n", encoding="utf-8")
    details["copied"] = copied_files
    if not copied_files:
        return {
            "status": "skipped",
            "message": "VideoDownloader 目录存在但无可复制文件（目标已有数据）",
            "details": details,
        }
    return {
        "status": "migrated",
        "message": "已从 VideoDownloader 复制应用数据",
        "details": details,
    }


def run_migration(
    paths: AppPaths,
    *,
    home: Optional[Path] = None,
    old_plist: Optional[Path] = None,
    old_history: Optional[Path] = None,
) -> Dict[str, Any]:
    """
    执行迁移。返回:
      status: skipped | migrated | failed
      message, details
    """
    if sys.platform != "darwin":
        return {
            "status": "skipped",
            "message": "非 macOS，跳过旧版迁移",
            "details": {"platform": sys.platform},
        }

    paths.ensure()
    details: Dict[str, Any] = {}

    try:
        vd = _migrate_videodownloader_tree(paths, home=home)
        details["videodownloader"] = vd

        marker = paths.data_dir / MIGRATION_MARKER
        if marker.is_file():
            # Trae 已迁过；若 VideoDownloader 迁入则整体算 migrated
            if vd.get("status") == "migrated":
                return {
                    "status": "migrated",
                    "message": vd.get("message") or "已迁移",
                    "details": details,
                }
            return {
                "status": "skipped",
                "message": "迁移已完成，跳过",
                "details": {**details, "marker": str(marker)},
            }

        plist_path = old_plist or default_old_plist_path(home)
        history_path = old_history or default_old_history_path(home)
        details["plist"] = str(plist_path)
        details["history"] = str(history_path)

        backup_dir = paths.data_dir / "migration_backup"
        backup_dir.mkdir(parents=True, exist_ok=True)

        plist = _read_plist(plist_path)
        mapped = _map_plist_to_config(plist)
        details["config_keys"] = sorted(mapped.keys())
        if mapped:
            if paths.config_path.is_file():
                shutil.copy2(paths.config_path, backup_dir / "config.json.bak")
            cfg = JsonConfig(str(paths.config_path))
            cfg.update_from_dict(mapped)

        history_copied = 0
        if history_path.is_file():
            shutil.copy2(history_path, backup_dir / "old_history.db")
            if paths.history_db_path.is_file():
                shutil.copy2(paths.history_db_path, backup_dir / "history.db.bak")
            history_copied = _copy_history(history_path, paths.history_db_path)
        details["history_copied"] = history_copied

        marker.write_text("ok\n", encoding="utf-8")
        if (
            not mapped
            and history_copied == 0
            and not plist_path.is_file()
            and not history_path.is_file()
            and vd.get("status") != "migrated"
        ):
            return {
                "status": "skipped",
                "message": "未发现旧 Trae / VideoDownloader 数据",
                "details": details,
            }
        return {
            "status": "migrated",
            "message": "旧数据已迁移",
            "details": details,
        }
    except Exception as exc:
        logger.exception("迁移失败")
        return {
            "status": "failed",
            "message": str(exc),
            "details": details,
        }
