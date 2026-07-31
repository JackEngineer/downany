"""python -m src.cli — 轻量入队 CLI（不启动 Sidecar JSON Lines 服务）。"""
from __future__ import annotations

import argparse
import sys
import time

from src.core.download_manager import DownloadManager
from src.core.download_task import DownloadTask, TaskStatus, VideoInfo
from src.core.platform_detector import PlatformDetector
from src.core.quality import normalize_quality
from src.data.database import HistoryDB
from src.data.json_config import JsonConfig
from src.data.queue_store import QueueStore
from src.sidecar.handlers import _normalize_inbound_url
from src.sidecar.paths import AppPaths


def _build_manager(paths: AppPaths) -> tuple[DownloadManager, JsonConfig]:
    HistoryDB._instance = None
    config = JsonConfig(str(paths.config_path))
    db = HistoryDB(db_path=str(paths.history_db_path))
    store = QueueStore(str(paths.history_db_path))
    manager = DownloadManager(config=config, db=db, queue_store=store)
    manager.restore_tasks()
    manager.start()
    return manager, config


def cmd_add(args: argparse.Namespace) -> int:
    paths = AppPaths.default().ensure()
    manager, config = _build_manager(paths)
    try:
        url = _normalize_inbound_url(args.url)
        if not url:
            print("无效 URL", file=sys.stderr)
            return 2
        options = config.build_download_options()
        if args.quality:
            options.quality = normalize_quality(args.quality)
        if args.audio:
            options.audio_only = True
        if args.subs:
            options.download_subtitles = True
        platform = PlatformDetector.detect_with_context(url)
        task = DownloadTask(
            video_info=VideoInfo(url=url, title="未命名视频", platform=platform),
            options=options,
        )
        manager.add_task(task)
        print(task.id)
        if args.detach:
            return 0
        while True:
            current = manager.get_task(task.id)
            if current is None:
                return 1
            if current.status == TaskStatus.COMPLETED:
                return 0
            if current.status in (TaskStatus.FAILED, TaskStatus.CANCELLED):
                print(current.error_message or current.status.value, file=sys.stderr)
                return 1
            time.sleep(0.5)
    finally:
        manager.stop()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="videodl-cli", description="视频下载器 CLI")
    sub = parser.add_subparsers(dest="command", required=True)

    add_parser = sub.add_parser("add", help="添加入队下载任务")
    add_parser.add_argument("url", help="视频 URL")
    add_parser.add_argument("--audio", action="store_true", help="仅音频 (MP3)")
    add_parser.add_argument("--quality", help="画质：best / 1080p / 720p 等")
    add_parser.add_argument("--subs", action="store_true", help="下载字幕")
    add_parser.add_argument(
        "--detach",
        action="store_true",
        help="仅入队并打印 task id，不等待完成",
    )
    add_parser.set_defaults(func=cmd_add)

    ns = parser.parse_args(argv)
    return int(ns.func(ns))


if __name__ == "__main__":
    sys.exit(main())
