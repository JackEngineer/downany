from __future__ import annotations

import json
import zipfile
from pathlib import Path

from src.core.download_manager import DownloadManager
from src.core.download_task import DownloadTask, Platform, TaskStatus, VideoInfo
from src.sidecar import diagnostics
from src.sidecar.diagnostics import export_diagnostics
from src.sidecar.paths import AppPaths


def _manager_with(*tasks: DownloadTask) -> DownloadManager:
    manager = DownloadManager.__new__(DownloadManager)
    manager._tasks = {task.id: task for task in tasks}  # noqa: SLF001
    manager.get_all_tasks = lambda: manager._tasks  # type: ignore[method-assign]
    return manager


def test_collect_environment_reports_capabilities_without_local_paths(
    tmp_path: Path,
    monkeypatch,
) -> None:
    paths = AppPaths(data_dir=tmp_path / "data", log_dir=tmp_path / "logs")
    ytdlp_path = r"C:\Users\private-user\Downany\yt-dlp.exe"
    ffmpeg_path = Path("/Users/private-user/Downany/ffmpeg")
    ffprobe_path = Path("/Users/private-user/Downany/ffprobe")
    calls: list[list[str]] = []

    monkeypatch.setattr(diagnostics, "resolve_ytdlp_executable", lambda _paths: ytdlp_path)
    monkeypatch.setattr(diagnostics, "resolve_ffmpeg_path", lambda: ffmpeg_path)
    monkeypatch.setattr(diagnostics, "resolve_ffprobe_path", lambda: ffprobe_path)

    def fake_version(command: list[str]) -> str:
        calls.append(command)
        if command[-1] == "-version":
            if "ffprobe" in command[0]:
                return "ffprobe version 7.1.2 Copyright (c) FFmpeg developers"
            return "ffmpeg version 7.1 Copyright (c) FFmpeg developers"
        return "2026.07.04"

    monkeypatch.setattr(diagnostics, "_run_version", fake_version)

    result = diagnostics.collect_environment(paths)

    assert result["ytdlp_source"] == "bundled"
    assert result["ytdlp_version"] == "2026.07.04"
    assert result["ffmpeg_available"] is True
    assert result["ffmpeg_version"] == "7.1"
    assert result["ffprobe_available"] is True
    assert result["ffprobe_version"] == "7.1.2"
    assert calls == [
        [ytdlp_path, "--version"],
        [str(ffmpeg_path), "-version"],
        [str(ffprobe_path), "-version"],
    ]
    serialized = json.dumps(result, ensure_ascii=False)
    assert ytdlp_path not in serialized
    assert str(ffmpeg_path) not in serialized
    assert str(ffprobe_path) not in serialized
    assert not any(key.endswith("_path") or key.endswith("_executable") for key in result)

    exported = export_diagnostics(paths, _manager_with(), output_dir=tmp_path / "out")
    with zipfile.ZipFile(exported["path"]) as archive:
        environment_text = archive.read("environment.json").decode("utf-8")
    assert str(ffmpeg_path) not in environment_text
    assert str(ffprobe_path) not in environment_text


def test_collect_environment_rejects_unstructured_version_output(
    tmp_path: Path,
    monkeypatch,
) -> None:
    paths = AppPaths(data_dir=tmp_path / "data", log_dir=tmp_path / "logs")
    sentinel = r"PRIVATE_RESPONSE_BODY C:\Users\private-user\tool.exe"

    monkeypatch.setattr(
        diagnostics,
        "resolve_ytdlp_executable",
        lambda _paths: r"C:\trusted-package\yt-dlp.exe",
    )
    monkeypatch.setattr(
        diagnostics,
        "resolve_ffmpeg_path",
        lambda: Path(r"C:\trusted-package\ffmpeg.exe"),
    )
    monkeypatch.setattr(
        diagnostics,
        "resolve_ffprobe_path",
        lambda: Path(r"C:\trusted-package\ffprobe.exe"),
    )
    monkeypatch.setattr(diagnostics, "_run_version", lambda _command: sentinel)

    result = diagnostics.collect_environment(paths)

    assert result["ytdlp_version"] == "unavailable"
    assert result["ffmpeg_version"] == "unavailable"
    assert result["ffprobe_version"] == "unavailable"
    assert sentinel not in json.dumps(result, ensure_ascii=False)


def test_export_diagnostics_contains_only_minimized_structured_summaries(
    tmp_path: Path,
    monkeypatch,
) -> None:
    paths = AppPaths(data_dir=tmp_path / "data", log_dir=tmp_path / "logs")
    paths.ensure()

    sentinels = [
        "DOWNLOAD_QUERY_SECRET",
        "COOKIE_VALUE_SECRET",
        "BEARER_VALUE_SECRET",
        "123456789:BOT_TOKEN_SECRET_abcdefghijklmnopqrstuvwxyz",
        "PRIVATE_VIDEO_TITLE",
        "PRIVATE_RESPONSE_BODY",
        r"C:\Users\private-user\Downloads\private.mp4",
        "/Users/private-user/Downloads/private.mp4",
    ]
    (paths.log_dir / "sidecar.log").write_text(
        "\n".join(
            [
                "2026-08-26 10:00:00 - Downloader - INFO - normal startup",
                "2026-08-26 10:00:01 - Downloader - WARNING - "
                "Cookie: session=COOKIE_VALUE_SECRET",
                "2026-08-26 10:00:02 - Downloader - ERROR - "
                "Authorization: Bearer BEARER_VALUE_SECRET "
                "bot=123456789:BOT_TOKEN_SECRET_abcdefghijklmnopqrstuvwxyz "
                "response=PRIVATE_RESPONSE_BODY "
                r"path=C:\Users\private-user\Downloads\private.mp4 "
                "other=/Users/private-user/Downloads/private.mp4",
                "unstructured DOWNLOAD_QUERY_SECRET",
            ]
        ),
        encoding="utf-8",
    )

    failed_network = DownloadTask(
        video_info=VideoInfo(
            url="https://media.example/video?token=DOWNLOAD_QUERY_SECRET",
            title="PRIVATE_VIDEO_TITLE",
            platform=Platform.YOUTUBE,
        ),
        status=TaskStatus.FAILED,
        error_code="network",
        error_message="PRIVATE_RESPONSE_BODY at C:\\Users\\private-user\\Downloads\\private.mp4",
    )
    failed_unknown = DownloadTask(
        video_info=VideoInfo(
            url="https://other.example/private",
            title="another private title",
            platform=Platform.UNKNOWN,
        ),
        status=TaskStatus.FAILED,
        error_code="PRIVATE_RESPONSE_BODY",
    )
    pending = DownloadTask(
        video_info=VideoInfo(url="https://pending.example", title="pending"),
        status=TaskStatus.PENDING,
    )
    manager = _manager_with(failed_network, failed_unknown, pending)
    monkeypatch.setattr(
        diagnostics,
        "collect_environment",
        lambda _paths: {
            "app": "Downany",
            "app_version": "0.2.1",
            "ytdlp_source": "bundled",
            "ffmpeg_available": True,
        },
    )

    result = export_diagnostics(paths, manager, output_dir=tmp_path / "out")

    assert result["ok"] is True
    assert result["failed_task_count"] == 2
    assert result["log_files"] == []
    assert result["log_summary"] == {
        "files_seen": 1,
        "files_read": 1,
        "lines": 4,
        "levels": {"error": 1, "info": 1, "other": 1, "warning": 1},
    }

    zip_path = Path(result["path"])
    assert zip_path.is_file()
    with zipfile.ZipFile(zip_path) as zf:
        names = set(zf.namelist())
        archive_text = "\n".join(
            zf.read(name).decode("utf-8", errors="replace") for name in sorted(names)
        )
        environment = json.loads(zf.read("environment.json"))
        failed_tasks = json.loads(zf.read("failed_tasks.json"))
        log_summary = json.loads(zf.read("logs/summary.json"))
        privacy = json.loads(zf.read("privacy.json"))

    for sentinel in sentinels:
        assert sentinel not in archive_text

    assert names == {
        "environment.json",
        "failed_tasks.json",
        "logs/summary.json",
        "privacy.json",
    }
    assert environment["app"] == "Downany"
    assert failed_tasks == {
        "total": 2,
        "by_error_code": {"network": 1, "unknown": 1},
        "by_platform": {"unknown": 1, "youtube": 1},
    }
    assert log_summary == result["log_summary"]
    assert privacy["schema_version"] == 1
    assert privacy["raw_content_included"] is False
    assert "下载链接" in privacy["excluded"]
    assert "日志正文" in privacy["excluded"]
