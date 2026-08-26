"""Real-media integration contracts for the staged output pipeline."""
from __future__ import annotations

import os
import subprocess
import threading
from dataclasses import dataclass
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest
import yt_dlp
from yt_dlp.extractor.common import InfoExtractor

from src.core.download_manager import (
    _verification_expectation,
    _verify_external_subtitles,
)
from src.core.download_task import DownloadOptions, DownloadTask, Platform, VideoInfo
from src.core.downloader import Downloader
from src.core.media_verifier import MediaVerification, verify_media
from src.core.output_commit import commit_output_bundle
from src.core.output_contract import OutputPlan, compile_output_plan
from src.sidecar.bin_paths import MediaToolchain, resolve_media_toolchain


PROJECT_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_TITLE = "Downany Fixture"
FIXTURE_LANGUAGE = "zh-Hans"


class _SilentAssetHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        return


class _DownanyFixtureIE(InfoExtractor):
    IE_NAME = "downanyfixture"
    _VALID_URL = r"downanyfixture:(?P<id>mp4|mkv)$"

    def __init__(self, base_url: str, downloader: yt_dlp.YoutubeDL):
        super().__init__(downloader)
        self._base_url = base_url.rstrip("/")

    def _real_extract(self, url: str) -> dict[str, object]:
        source = self._match_id(url)
        return {
            "id": source,
            "title": FIXTURE_TITLE,
            "url": f"{self._base_url}/fixture.{source}",
            "ext": source,
            "duration": 1,
            "thumbnail": f"{self._base_url}/cover.png",
            "thumbnails": [{"id": "cover", "url": f"{self._base_url}/cover.png"}],
            "subtitles": {
                FIXTURE_LANGUAGE: [
                    {
                        "url": f"{self._base_url}/subtitle.{FIXTURE_LANGUAGE}.srt",
                        "ext": "srt",
                    }
                ]
            },
            "chapters": [
                {"start_time": 0.0, "end_time": 0.5, "title": "Intro"},
                {"start_time": 0.5, "end_time": 1.0, "title": "End"},
            ],
        }


def _run_checked(argv: list[str], *, timeout_seconds: float = 30.0) -> None:
    completed = subprocess.run(
        argv,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout_seconds,
        check=False,
        shell=False,
    )
    if completed.returncode == 0:
        return
    stderr = completed.stderr.decode("utf-8", errors="replace")[-4000:]
    pytest.fail(f"fixture command failed ({completed.returncode}): {stderr}")


def _generate_assets(asset_dir: Path, toolchain: MediaToolchain) -> None:
    asset_dir.mkdir(parents=True, exist_ok=True)
    common_inputs = [
        "-f",
        "lavfi",
        "-i",
        "color=c=0x2457d6:s=320x180:r=24:d=1",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=880:sample_rate=44100:duration=1",
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:v",
        "mpeg4",
        "-q:v",
        "5",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-shortest",
    ]
    for extension in ("mp4", "mkv"):
        _run_checked(
            [
                str(toolchain.ffmpeg),
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                *common_inputs,
                str(asset_dir / f"fixture.{extension}"),
            ]
        )
    _run_checked(
        [
            str(toolchain.ffmpeg),
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=0xf2b134:s=96x96:d=0.1",
            "-frames:v",
            "1",
            "-update",
            "1",
            str(asset_dir / "cover.png"),
        ]
    )
    (asset_dir / f"subtitle.{FIXTURE_LANGUAGE}.srt").write_text(
        "1\n00:00:00,000 --> 00:00:00,800\nDownany fixture subtitle\n",
        encoding="utf-8",
    )


def _language_is_zh(language: str) -> bool:
    return language.casefold().replace("_", "-").split("-", 1)[0] in {
        "zh",
        "zho",
        "chi",
    }


@dataclass(frozen=True)
class _VerifiedOutput:
    main_file: Path
    subtitle_files: tuple[Path, ...]
    verification: MediaVerification


@dataclass(frozen=True)
class _PipelineResult:
    plan: OutputPlan
    staged: _VerifiedOutput
    committed: _VerifiedOutput


class _MediaFixture:
    def __init__(
        self,
        root: Path,
        base_url: str,
        toolchain: MediaToolchain,
    ) -> None:
        self.root = root
        self.base_url = base_url
        self.toolchain = toolchain
        self._run_index = 0

    def _ydl_factory(self, options: dict[str, Any]) -> yt_dlp.YoutubeDL:
        ydl = yt_dlp.YoutubeDL(options, auto_init=False)
        ydl.add_info_extractor(_DownanyFixtureIE(self.base_url, ydl))
        return ydl

    def run(self, *, source: str, **option_overrides: object) -> _PipelineResult:
        self._run_index += 1
        case_root = self.root / f"case-{self._run_index:02d}"
        staging = case_root / "staging"
        output_root = case_root / "requested-output"
        options = DownloadOptions(output_path=str(output_root), **option_overrides)
        task = DownloadTask(
            video_info=VideoInfo(
                url=f"downanyfixture:{source}",
                title=FIXTURE_TITLE,
                platform=Platform.UNKNOWN,
            ),
            options=options,
        )
        plan = compile_output_plan(task)
        result = Downloader(ydl_factory=self._ydl_factory).download(
            task.video_info.url,
            plan,
            toolchain=self.toolchain,
            staging_dir=staging,
        )
        expectation = _verification_expectation(plan, result.source_facts)
        staged_verification = verify_media(
            result.main_file,
            self.toolchain.ffprobe,
            expectation,
        )
        staged_subtitles = tuple(artifact.path for artifact in result.subtitles)
        _verify_external_subtitles(staged_subtitles, staging)

        assert not output_root.exists()
        committed = commit_output_bundle(
            download_root=output_root,
            playlist_folder=plan.playlist_folder,
            result=result,
        )
        final_root = output_root.resolve(strict=True)
        final_main = committed.main_file.resolve(strict=True)
        final_main.relative_to(final_root)
        for subtitle in committed.subtitle_files:
            subtitle.resolve(strict=True).relative_to(final_root)
        committed_verification = verify_media(
            final_main,
            self.toolchain.ffprobe,
            expectation,
        )
        _verify_external_subtitles(committed.subtitle_files, final_root)
        return _PipelineResult(
            plan=plan,
            staged=_VerifiedOutput(
                main_file=result.main_file,
                subtitle_files=staged_subtitles,
                verification=staged_verification,
            ),
            committed=_VerifiedOutput(
                main_file=committed.main_file,
                subtitle_files=committed.subtitle_files,
                verification=committed_verification,
            ),
        )


@pytest.fixture(scope="module")
def media_fixture(tmp_path_factory: pytest.TempPathFactory):
    toolchain = resolve_media_toolchain(project_root=PROJECT_ROOT)
    if toolchain is None:
        message = "real media integration requires a paired ffmpeg and ffprobe toolchain"
        if os.environ.get("DOWNANY_REQUIRE_MEDIA_INTEGRATION") == "1":
            pytest.fail(message)
        pytest.skip(message)

    root = tmp_path_factory.mktemp("media-pipeline")
    asset_dir = root / "served-assets"
    _generate_assets(asset_dir, toolchain)
    handler = partial(_SilentAssetHandler, directory=str(asset_dir))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address[:2]
    try:
        yield _MediaFixture(root, f"http://{host}:{port}", toolchain)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def test_default_mp4_keeps_video_and_audio(media_fixture):
    result = media_fixture.run(source="mp4")

    assert result.staged.main_file.suffix == ".mp4"
    assert {"video", "audio"} <= set(result.staged.verification.stream_types)
    assert result.committed.main_file.suffix == ".mp4"
    assert {"video", "audio"} <= set(result.committed.verification.stream_types)


def test_mp4_embeds_requested_metadata_cover_chapters_and_subtitle(media_fixture):
    result = media_fixture.run(
        source="mp4",
        postprocessing="mp4",
        embed_metadata=True,
        embed_subs=True,
        subtitle_langs="zh-Hans",
    )

    for output in (result.staged, result.committed):
        assert output.main_file.suffix == ".mp4"
        assert output.verification.has_title is True
        assert output.verification.has_cover is True
        assert output.verification.chapter_count == 2
        assert any(_language_is_zh(item) for item in output.verification.subtitle_languages)


def test_default_mkv_fallback_stays_in_the_allowed_container(media_fixture):
    result = media_fixture.run(source="mkv")

    assert result.plan.allowed_containers == frozenset({"mp4", "mkv"})
    assert result.staged.main_file.suffix == ".mkv"
    assert result.staged.verification.container == "mkv"
    assert result.committed.main_file.suffix == ".mkv"
    assert result.committed.verification.container == "mkv"


def test_mp3_contains_audio_metadata_and_cover_but_no_playable_video_or_subtitle(
    media_fixture,
):
    result = media_fixture.run(
        source="mp4",
        postprocessing="mp3",
        embed_metadata=True,
    )

    for output in (result.staged, result.committed):
        assert output.main_file.suffix == ".mp3"
        assert "audio" in output.verification.stream_types
        assert "subtitle" not in output.verification.stream_types
        assert output.verification.has_title is True
        assert output.verification.has_cover is True
        assert output.verification.stream_types.count("video") == 1


def test_external_and_both_modes_retain_nonempty_language_named_subtitles(media_fixture):
    external = media_fixture.run(
        source="mp4",
        download_subtitles=True,
        embed_subs=False,
        subtitle_langs="zh-Hans",
    )
    both = media_fixture.run(
        source="mp4",
        download_subtitles=True,
        embed_subs=True,
        subtitle_langs="zh-Hans",
    )

    for result in (external, both):
        assert [path.name for path in result.committed.subtitle_files] == [
            result.committed.main_file.with_suffix(".zh-Hans.srt").name
        ]
        assert all(path.stat().st_size > 0 for path in result.committed.subtitle_files)
    assert not any(
        _language_is_zh(item)
        for item in external.committed.verification.subtitle_languages
    )
    assert any(
        _language_is_zh(item) for item in both.committed.verification.subtitle_languages
    )
