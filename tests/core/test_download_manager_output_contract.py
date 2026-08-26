"""DownloadManager output-contract orchestration tests."""
from __future__ import annotations

from contextlib import ExitStack
from dataclasses import replace
from pathlib import Path
from types import MappingProxyType
from unittest.mock import patch

import pytest

from src.core import download_manager as manager_module
from src.core.download_manager import DownloadManager
from src.core.download_task import DownloadOptions, DownloadTask, TaskStatus, VideoInfo
from src.core.downloader import DownloadResult, SourceFacts, SubtitleArtifact
from src.core.error_codes import (
    MEDIA_TOOLS_MISSING,
    OUTPUT_PATH_INVALID,
    OUTPUT_VERIFICATION_FAILED,
    OutputPathInvalid,
    OutputVerificationFailed,
)
from src.core.media_verifier import MediaVerification
from src.core.output_commit import CommittedOutput
from src.core.output_contract import MediaKind, OutputPlan, SubtitleMode
from src.sidecar.bin_paths import MediaToolchain


class _Config:
    def get_concurrent_downloads(self) -> int:
        return 1

    def get_proxy_for_download(self) -> None:
        return None


class _History:
    def __init__(self, calls: list[str]) -> None:
        self.calls = calls
        self.records = []

    def add_download_record(self, record, **_kwargs) -> None:
        self.records.append(record)
        if record.status == TaskStatus.COMPLETED.value:
            self.calls.append("history:completed")


class _Queue:
    def __init__(self, calls: list[str]) -> None:
        self.calls = calls
        self.snapshots = []

    def upsert_task(self, task: DownloadTask) -> None:
        self.snapshots.append((task.status, task.file_path, task.completion_note))
        if task.status is TaskStatus.COMPLETED:
            self.calls.append("queue:completed")

    def update_progress(self, *_args) -> None:
        return None


class _ReadySink:
    def __init__(self, calls: list[str], *, fail: bool = False) -> None:
        self.calls = calls
        self.fail = fail

    def mark_ready(self, *_args, **_kwargs):
        self.calls.append("telegram:ready")
        if self.fail:
            raise RuntimeError("downstream unavailable")
        return None


class _FakeDownloader:
    def __init__(self, pipeline: "_Pipeline") -> None:
        self.pipeline = pipeline
        self.last_info = None
        self.last_ydl_info = dict(pipeline.result.info)
        self.progress = None

    def set_callbacks(self, *, progress=None, **_kwargs) -> None:
        self.progress = progress

    def download(self, *_args, **_kwargs) -> DownloadResult:
        self.pipeline.calls.append("download")
        return self.pipeline.result


class _Pipeline:
    def __init__(
        self,
        tmp_path: Path,
        *,
        source_facts: SourceFacts | None = None,
        plan: OutputPlan | None = None,
        sink_failure: bool = False,
    ) -> None:
        self.calls: list[str] = []
        self.temp_root = tmp_path / "staging"
        self.download_root = tmp_path / "downloads"
        self.staging_dir = self.temp_root / "task-output-contract"
        self.staging_dir.mkdir(parents=True)
        self.download_root.mkdir()
        self.staging_main = self.staging_dir / "media.mp4"
        self.staging_main.write_bytes(b"staged-media")
        self.final_main = self.download_root / "finished.mp4"
        self.final_main.write_bytes(b"published-media")
        self.task = DownloadTask(
            id="task-output-contract",
            video_info=VideoInfo(url="https://example.com/watch?v=secret", title="视频"),
            options=DownloadOptions(output_path=str(self.download_root), embed_metadata=False),
        )
        self.plan = plan or OutputPlan(
            media_kind=MediaKind.VIDEO,
            allowed_containers=frozenset({"mp4", "mkv"}),
            subtitle_mode=SubtitleMode.NONE,
            requested_subtitle_languages=(),
            ydl_options={},
            postprocessors=(),
            final_leaf_template="%(title)s [%(id)s].%(ext)s",
            source_key_template="%(id)s",
            playlist_folder="",
            requires_ffmpeg=True,
            requires_ffprobe=True,
        )
        facts = source_facts or SourceFacts(
            selected_subtitle_languages=(),
            missing_requested_subtitles=False,
            thumbnail_available=False,
            chapters_available=False,
            title_available=True,
        )
        self.result = DownloadResult(
            main_file=self.staging_main,
            subtitles=(),
            info=MappingProxyType({"title": "真实标题", "filepath": str(self.staging_main)}),
            rendered_leaf="真实标题 [source].mp4",
            source_key="source",
            downloaded_this_run=True,
            source_facts=facts,
        )
        self.toolchain = MediaToolchain(
            ffmpeg=tmp_path / "ffmpeg",
            ffprobe=tmp_path / "ffprobe",
            ffmpeg_location=tmp_path,
            source="test",
        )
        self.committed = CommittedOutput(
            main_file=self.final_main,
            subtitle_files=(),
            created_fingerprints=(),
        )
        self.history = _History(self.calls)
        self.queue = _Queue(self.calls)
        self.ready = _ReadySink(self.calls, fail=sink_failure)
        self.manager = DownloadManager(
            config=_Config(),
            db=self.history,
            queue_store=self.queue,
            temp_dir=str(self.temp_root),
            output_ready_sink=self.ready,
        )
        self.manager.tasks[self.task.id] = self.task
        self.events: list[tuple[str, dict]] = []

        def record_event(event: str, payload: dict) -> None:
            self.events.append((event, payload))
            if event == "task_completed":
                self.calls.append("event:task_completed")

        self.manager.events.subscribe(record_event)

    def run(
        self,
        *,
        compile_error: Exception | None = None,
        missing_toolchain: bool = False,
        verifier_failure_at: str = "",
        commit_error: Exception | None = None,
    ) -> None:
        verify_count = 0

        def compile_plan(_task: DownloadTask) -> OutputPlan:
            self.calls.append("compile")
            if compile_error is not None:
                raise compile_error
            return self.plan

        def resolve_tools(**_kwargs):
            self.calls.append("toolchain")
            return None if missing_toolchain else self.toolchain

        def verify(path: Path, *_args, **_kwargs):
            nonlocal verify_count
            verify_count += 1
            phase = "staging" if verify_count == 1 else "final"
            self.calls.append(f"verify:{phase}")
            if verifier_failure_at == phase:
                raise OutputVerificationFailed(
                    f"ffprobe leaked {path} https://secret.invalid raw-output"
                )
            return MediaVerification("mp4", ("video",), (), False, False, 0)

        def commit(**_kwargs):
            self.calls.append("commit")
            if commit_error is not None:
                raise commit_error
            return self.committed

        def rollback(_committed: CommittedOutput) -> None:
            self.calls.append("rollback")

        with ExitStack() as stack:
            stack.enter_context(
                patch.object(manager_module, "compile_output_plan", side_effect=compile_plan, create=True)
            )
            stack.enter_context(
                patch.object(manager_module, "resolve_media_toolchain", side_effect=resolve_tools, create=True)
            )
            stack.enter_context(
                patch.object(manager_module, "verify_media", side_effect=verify, create=True)
            )
            stack.enter_context(
                patch.object(manager_module, "commit_output_bundle", side_effect=commit, create=True)
            )
            stack.enter_context(
                patch.object(manager_module, "rollback_committed_output", side_effect=rollback, create=True)
            )
            stack.enter_context(
                patch.object(
                    manager_module,
                    "Downloader",
                    side_effect=lambda *_args, **_kwargs: _FakeDownloader(self),
                )
            )
            stack.enter_context(
                patch.object(manager_module.VideoInfoExtractor, "extract", return_value=None)
            )
            self.manager._download_task(self.task)


def _completed_rows(pipeline: _Pipeline):
    return [
        record
        for record in pipeline.history.records
        if record.status == TaskStatus.COMPLETED.value
    ]


def _completed_snapshots(pipeline: _Pipeline):
    return [item for item in pipeline.queue.snapshots if item[0] is TaskStatus.COMPLETED]


def test_completed_is_persisted_only_after_final_verification(tmp_path):
    pipeline = _Pipeline(tmp_path)

    pipeline.run()

    assert pipeline.calls == [
        "compile",
        "toolchain",
        "download",
        "verify:staging",
        "commit",
        "verify:final",
        "history:completed",
        "queue:completed",
        "telegram:ready",
        "event:task_completed",
    ]
    assert pipeline.task.file_path == str(pipeline.committed.main_file)
    assert pipeline.task.status is TaskStatus.COMPLETED


@pytest.mark.parametrize(
    ("run_kwargs", "expected_code", "expected_message"),
    [
        (
            {"compile_error": OutputPathInvalid("D:/secret/output/template")},
            OUTPUT_PATH_INVALID,
            "下载位置或文件名不可用",
        ),
        (
            {"missing_toolchain": True},
            MEDIA_TOOLS_MISSING,
            "媒体工具不完整，请重新安装",
        ),
        (
            {"verifier_failure_at": "staging"},
            OUTPUT_VERIFICATION_FAILED,
            "成品无法验证，请导出诊断后重试",
        ),
        (
            {
                "commit_error": OutputVerificationFailed(
                    "commit D:/secret/output https://secret.invalid"
                )
            },
            OUTPUT_VERIFICATION_FAILED,
            "成品无法验证，请导出诊断后重试",
        ),
    ],
)
def test_contract_failures_use_stable_safe_product_errors(
    tmp_path,
    run_kwargs,
    expected_code,
    expected_message,
):
    pipeline = _Pipeline(tmp_path)

    pipeline.run(**run_kwargs)

    assert pipeline.task.status is TaskStatus.FAILED
    assert pipeline.task.error_code == expected_code
    assert pipeline.task.error_message == expected_message
    assert pipeline.task.completion_note == ""
    failed_payloads = [payload for event, payload in pipeline.events if event == "task_failed"]
    assert failed_payloads == [{"task_id": pipeline.task.id, "error": expected_message}]
    public_text = " ".join(
        [pipeline.task.error_message, pipeline.task.completion_note, str(failed_payloads)]
    )
    assert str(pipeline.staging_dir) not in public_text
    assert str(pipeline.final_main) not in public_text
    assert pipeline.task.video_info.url not in public_text
    assert "raw-output" not in public_text
    assert not _completed_rows(pipeline)
    assert not _completed_snapshots(pipeline)
    assert "telegram:ready" not in pipeline.calls
    assert "event:task_completed" not in pipeline.calls


def test_final_verification_failure_rolls_back_before_failed_persistence(tmp_path):
    pipeline = _Pipeline(tmp_path)

    pipeline.run(verifier_failure_at="final")

    assert pipeline.task.status is TaskStatus.FAILED
    assert pipeline.calls[:7] == [
        "compile",
        "toolchain",
        "download",
        "verify:staging",
        "commit",
        "verify:final",
        "rollback",
    ]
    assert not _completed_rows(pipeline)
    assert not _completed_snapshots(pipeline)
    assert "telegram:ready" not in pipeline.calls
    assert "event:task_completed" not in pipeline.calls


def test_final_subtitle_failure_rolls_back_the_published_bundle(tmp_path):
    pipeline = _Pipeline(tmp_path)
    staged_subtitle = pipeline.staging_dir / "media.en.vtt"
    staged_subtitle.write_text("WEBVTT\n", encoding="utf-8")
    final_subtitle = pipeline.download_root / "finished.en.vtt"
    final_subtitle.touch()
    pipeline.result = replace(
        pipeline.result,
        subtitles=(SubtitleArtifact(staged_subtitle, "en", "vtt"),),
    )
    pipeline.committed = replace(
        pipeline.committed,
        subtitle_files=(final_subtitle,),
    )

    pipeline.run()

    assert pipeline.task.status is TaskStatus.FAILED
    assert pipeline.task.error_code == OUTPUT_VERIFICATION_FAILED
    assert "rollback" in pipeline.calls
    assert not _completed_rows(pipeline)
    assert "event:task_completed" not in pipeline.calls


def test_outside_committed_path_is_rejected_and_rolled_back(tmp_path):
    pipeline = _Pipeline(tmp_path)
    outside = tmp_path / "outside.mp4"
    outside.write_bytes(b"outside")
    pipeline.committed = replace(pipeline.committed, main_file=outside)

    pipeline.run()

    assert pipeline.task.status is TaskStatus.FAILED
    assert pipeline.task.error_code == OUTPUT_VERIFICATION_FAILED
    assert pipeline.task.error_message == "成品无法验证，请导出诊断后重试"
    assert pipeline.calls[-1] == "rollback"
    assert "verify:final" not in pipeline.calls


def test_manager_accepts_only_the_new_collision_path_for_this_task(tmp_path):
    pipeline = _Pipeline(tmp_path)
    preexisting = pipeline.final_main
    preexisting.write_bytes(b"pre-existing")
    collision_copy = pipeline.download_root / "finished (2).mp4"
    collision_copy.write_bytes(b"new-output")
    pipeline.committed = replace(pipeline.committed, main_file=collision_copy)

    pipeline.run()

    assert pipeline.task.status is TaskStatus.COMPLETED
    assert pipeline.task.file_path == str(collision_copy)
    assert preexisting.read_bytes() == b"pre-existing"


def test_downstream_ready_failure_does_not_invalidate_verified_local_output(tmp_path):
    pipeline = _Pipeline(tmp_path, sink_failure=True)

    pipeline.run()

    assert pipeline.task.status is TaskStatus.COMPLETED
    assert pipeline.task.file_path == str(pipeline.final_main)
    assert len(_completed_rows(pipeline)) == 1
    assert len(_completed_snapshots(pipeline)) == 1
    assert pipeline.calls[-2:] == ["telegram:ready", "event:task_completed"]


@pytest.mark.parametrize(
    ("requested_languages", "expected_note"),
    [(("en",), "未找到所选语言字幕"), ((), "未找到可用字幕")],
)
def test_missing_subtitle_completion_note_is_persisted(
    tmp_path,
    requested_languages,
    expected_note,
):
    plan = OutputPlan(
        media_kind=MediaKind.VIDEO,
        allowed_containers=frozenset({"mp4"}),
        subtitle_mode=SubtitleMode.EXTERNAL,
        requested_subtitle_languages=requested_languages,
        ydl_options={},
        postprocessors=(),
        final_leaf_template="%(title)s.%(ext)s",
        source_key_template="%(id)s",
        playlist_folder="",
        requires_ffmpeg=True,
        requires_ffprobe=True,
        completion_note="基础提示",
    )
    facts = SourceFacts((), True, False, False, True)
    pipeline = _Pipeline(tmp_path, source_facts=facts, plan=plan)

    pipeline.run()

    assert pipeline.task.completion_note == f"基础提示；{expected_note}"
    assert pipeline.history.records[-1].completion_note == pipeline.task.completion_note
    assert pipeline.queue.snapshots[-1][2] == pipeline.task.completion_note


def test_verification_expectation_uses_only_requested_available_features():
    plan = OutputPlan(
        media_kind=MediaKind.VIDEO,
        allowed_containers=frozenset({"mp4"}),
        subtitle_mode=SubtitleMode.BOTH,
        requested_subtitle_languages=("en", "zh-Hans"),
        ydl_options={"writethumbnail": True},
        postprocessors=(
            {"key": "FFmpegMetadata"},
            {"key": "EmbedThumbnail"},
            {"key": "FFmpegEmbedSubtitle"},
        ),
        final_leaf_template="%(title)s.%(ext)s",
        source_key_template="%(id)s",
        playlist_folder="",
        requires_ffmpeg=True,
        requires_ffprobe=True,
    )
    facts = SourceFacts(("en",), False, True, False, True)

    expectation = manager_module._verification_expectation(plan, facts)

    assert expectation.require_title is True
    assert expectation.require_cover is True
    assert expectation.require_chapters is False
    assert expectation.embedded_subtitle_languages == ("en",)


def test_external_subtitle_validation_rejects_empty_or_escaped_files(tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    valid = root / "video.en.vtt"
    valid.write_text("WEBVTT\n", encoding="utf-8")
    empty = root / "video.zh.vtt"
    empty.touch()
    escaped = tmp_path / "outside.vtt"
    escaped.write_text("WEBVTT\n", encoding="utf-8")

    manager_module._verify_external_subtitles((valid,), root)
    with pytest.raises(OutputVerificationFailed):
        manager_module._verify_external_subtitles((empty,), root)
    with pytest.raises(OutputVerificationFailed):
        manager_module._verify_external_subtitles((escaped,), root)
