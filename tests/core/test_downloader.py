"""Downloader staging-contract tests with an injected yt-dlp factory."""
from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from src.core import ytdlp_opts
from src.core.download_task import DownloadOptions, DownloadTask, Platform, VideoInfo
from src.core.downloader import DownloadCancelled, DownloadError, Downloader
from src.core.error_codes import OutputVerificationFailed
from src.core.output_contract import SubtitleMode, compile_output_plan
from src.sidecar.bin_paths import MediaToolchain


def _snapshot_options(options: dict) -> dict:
    snapshot = dict(options)
    if isinstance(options.get("paths"), dict):
        snapshot["paths"] = dict(options["paths"])
    if isinstance(options.get("http_headers"), dict):
        snapshot["http_headers"] = dict(options["http_headers"])
    if isinstance(options.get("postprocessors"), list):
        snapshot["postprocessors"] = [dict(item) for item in options["postprocessors"]]
    return snapshot


class FakeYDL:
    def __init__(self, factory: "FakeYDLFactory", options: dict, effect):
        self.factory = factory
        self.options = options
        self.effect = effect
        self.evaluate_calls: list[tuple[str, dict, bool]] = []
        self.prepare_filename_calls = 0

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def extract_info(self, url: str, *, download: bool):
        assert download is True
        self.factory.urls.append(url)
        if self.factory.emit_progress:
            for hook in self.options["progress_hooks"]:
                hook(
                    {
                        "status": "finished",
                        "filename": self.factory.progress_filename,
                    }
                )
        if self.factory.mutate_options:
            self.options["postprocessors"][0]["key"] = "mutated-by-ydl"
            self.options.setdefault("http_headers", {})["Referer"] = "mutated-by-ydl"
        if isinstance(self.effect, BaseException):
            raise self.effect
        if callable(self.effect):
            return self.effect(self)
        return self.effect

    def evaluate_outtmpl(self, template: str, info: dict, *, sanitize: bool):
        self.evaluate_calls.append((template, info, sanitize))
        filepath = Path(str(info.get("filepath") or "media.bin"))
        values = {
            "%(title)s": str(info.get("title") or "unknown"),
            "%(extractor)s": str(info.get("extractor") or "unknown"),
            "%(id)s": str(info.get("id") or "unknown"),
            "%(ext)s": filepath.suffix.lstrip(".") or "bin",
            "%(uploader)s": str(info.get("uploader") or "unknown"),
        }
        rendered = template
        for placeholder, value in values.items():
            rendered = rendered.replace(placeholder, value)
        return rendered

    def prepare_filename(self, _info):
        self.prepare_filename_calls += 1
        raise AssertionError("prepare_filename must not choose a final output")


class FakeYDLFactory:
    def __init__(
        self,
        *effects,
        emit_progress: bool = False,
        progress_filename: str = "",
        mutate_options: bool = False,
    ):
        self.effects = list(effects)
        self.emit_progress = emit_progress
        self.progress_filename = progress_filename
        self.mutate_options = mutate_options
        self.instances: list[FakeYDL] = []
        self.option_snapshots: list[dict] = []
        self.urls: list[str] = []

    def __call__(self, options: dict):
        index = len(self.instances)
        effect = self.effects[index]
        self.option_snapshots.append(_snapshot_options(options))
        instance = FakeYDL(self, options, effect)
        self.instances.append(instance)
        return instance


def _toolchain(tmp_path: Path, *, location: bool = True) -> MediaToolchain:
    bin_dir = tmp_path / "bin"
    return MediaToolchain(
        ffmpeg=bin_dir / "ffmpeg.exe",
        ffprobe=bin_dir / "ffprobe.exe",
        ffmpeg_location=bin_dir if location else None,
        source="fixture",
    )


def _video_plan(
    *,
    url: str = "https://www.youtube.com/watch?v=abc",
    title: str = "A title",
    **option_overrides,
):
    return compile_output_plan(
        DownloadTask(
            video_info=VideoInfo(
                url=url,
                title=title,
                platform=Platform.YOUTUBE,
            ),
            options=DownloadOptions(**option_overrides),
        )
    )


def _info(main_file: Path, **updates) -> dict:
    info = {
        "id": "abc",
        "extractor": "youtube",
        "title": "A title",
        "filepath": str(main_file),
    }
    info.update(updates)
    return info


def _download(
    tmp_path: Path,
    factory: FakeYDLFactory,
    *,
    plan=None,
    url: str = "https://www.youtube.com/watch?v=abc",
    location: bool = True,
    downloader: Downloader | None = None,
):
    staging = tmp_path / "task-1"
    active_plan = plan or _video_plan(url=url)
    active_downloader = downloader or Downloader(ydl_factory=factory)
    result = active_downloader.download(
        url,
        active_plan,
        toolchain=_toolchain(tmp_path, location=location),
        staging_dir=staging,
    )
    return result, active_downloader, staging


def test_download_accepts_only_postprocessed_info_filepath_and_fixed_options(tmp_path):
    staging = tmp_path / "task-1"
    final = staging / "media.mp4"
    final.parent.mkdir()
    final.write_bytes(b"verified later")
    plan = _video_plan(http_headers={"Referer": "https://example.test/page"})
    factory = FakeYDLFactory(
        _info(
            final,
            requested_downloads=[{"filepath": str(staging / "media.f137.mp4")}],
        ),
        emit_progress=True,
        progress_filename=str(staging / "media.f137.mp4"),
        mutate_options=True,
    )

    result, downloader, _ = _download(tmp_path, factory, plan=plan)

    assert result.main_file == final.resolve()
    assert result.rendered_leaf == "A title [youtube-abc].mp4"
    assert result.source_key == "youtube-abc"
    assert result.downloaded_this_run is True
    assert downloader.last_ydl_info["title"] == "A title"

    options = factory.option_snapshots[0]
    assert options["outtmpl"] == str(staging.resolve() / "media.%(ext)s")
    assert options["paths"] == {
        "home": str(staging.resolve()),
        "temp": str(staging.resolve()),
    }
    assert options["noplaylist"] is True
    assert [item["key"] for item in options["postprocessors"]] == [
        "FFmpegVideoRemuxer",
        "FFmpegMetadata",
        "EmbedThumbnail",
    ]
    assert options["ffmpeg_location"] == str((tmp_path / "bin").resolve())
    assert options["quiet"] is True
    assert options["noprogress"] is True
    assert options["no_warnings"] is True
    assert 0 < options["socket_timeout"] <= 20
    assert options["retries"] <= 2
    assert options["extractor_retries"] <= 2

    assert plan.postprocessors[0]["key"] == "FFmpegVideoRemuxer"
    assert plan.ydl_options["http_headers"]["Referer"] == "https://example.test/page"
    instance = factory.instances[0]
    assert sum(
        1
        for template, info, sanitize in instance.evaluate_calls
        if template == plan.final_leaf_template
        and info is downloader.last_ydl_info
        and sanitize is True
    ) == 1
    assert instance.prepare_filename_calls == 0


def test_path_toolchain_does_not_set_ffmpeg_location(tmp_path):
    staging = tmp_path / "task-1"
    final = staging / "media.mp4"
    final.parent.mkdir()
    final.write_bytes(b"media")
    factory = FakeYDLFactory(_info(final))

    _download(tmp_path, factory, location=False)

    assert "ffmpeg_location" not in factory.option_snapshots[0]


@pytest.mark.parametrize(
    "identity",
    [
        pytest.param("requested_downloads", id="requested-downloads"),
        pytest.param("_filename", id="legacy-filename"),
        pytest.param("progress", id="progress-hook"),
    ],
)
def test_nonfinal_path_identities_never_become_main_output(tmp_path, identity):
    staging = tmp_path / "task-1"
    fragment = staging / "media.f137.mp4"
    fragment.parent.mkdir()
    fragment.write_bytes(b"fragment")
    info = {"id": "abc", "extractor": "youtube", "title": "A title"}
    if identity == "requested_downloads":
        info["requested_downloads"] = [{"filepath": str(fragment)}]
    elif identity == "_filename":
        info["_filename"] = str(fragment)
    factory = FakeYDLFactory(
        info,
        emit_progress=identity == "progress",
        progress_filename=str(fragment),
    )

    with pytest.raises(OutputVerificationFailed, match="成品无法验证"):
        _download(tmp_path, factory)


@pytest.mark.parametrize(
    "state",
    [
        pytest.param("outside", id="outside-staging"),
        pytest.param("directory", id="directory"),
        pytest.param("empty", id="empty-file"),
    ],
)
def test_invalid_info_filepath_fails_strict_staging_contract(tmp_path, state):
    staging = tmp_path / "task-1"
    staging.mkdir()
    if state == "outside":
        main = tmp_path / "outside.mp4"
        main.write_bytes(b"media")
    elif state == "directory":
        main = staging / "media.mp4"
        main.mkdir()
    else:
        main = staging / "media.mp4"
        main.touch()
    factory = FakeYDLFactory(_info(main))

    with pytest.raises(OutputVerificationFailed, match="成品无法验证") as caught:
        _download(tmp_path, factory)

    assert str(main.resolve()) not in str(caught.value)


def test_external_subtitles_and_source_facts_are_structured(tmp_path):
    staging = tmp_path / "task-1"
    main = staging / "media.mp4"
    zh = staging / "media.zh-Hans.vtt"
    en = staging / "media.en.srt"
    staging.mkdir()
    for path in (main, zh, en):
        path.write_bytes(b"content")
    info = _info(
        main,
        requested_subtitles={
            "zh-Hans": {"filepath": str(zh), "ext": "vtt"},
            "en": {"filepath": str(en), "name": "English"},
        },
        thumbnails=[{"url": "https://example.test/cover.jpg"}],
        chapters=[{"title": "Intro"}],
    )
    plan = _video_plan(
        download_subtitles=True,
        embed_subs=True,
        subtitle_langs="zh-Hans,en",
    )
    factory = FakeYDLFactory(info)

    result, _, _ = _download(tmp_path, factory, plan=plan)

    assert plan.subtitle_mode is SubtitleMode.BOTH
    assert [(item.path, item.language, item.extension) for item in result.subtitles] == [
        (zh.resolve(), "zh-Hans", "vtt"),
        (en.resolve(), "en", "srt"),
    ]
    assert result.source_facts.selected_subtitle_languages == ("zh-Hans", "en")
    assert result.source_facts.missing_requested_subtitles is False
    assert result.source_facts.thumbnail_available is True
    assert result.source_facts.chapters_available is True
    assert result.source_facts.title_available is True


def test_embedded_subtitles_are_selected_but_not_returned_as_external_files(tmp_path):
    staging = tmp_path / "task-1"
    main = staging / "media.mp4"
    staging.mkdir()
    main.write_bytes(b"content")
    info = _info(
        main,
        requested_subtitles={"en": {"name": "English", "ext": "vtt"}},
    )
    plan = _video_plan(embed_subs=True, subtitle_langs="en")
    factory = FakeYDLFactory(info)

    result, _, _ = _download(tmp_path, factory, plan=plan)

    assert plan.subtitle_mode is SubtitleMode.EMBEDDED
    assert result.subtitles == ()
    assert result.source_facts.selected_subtitle_languages == ("en",)
    assert result.source_facts.missing_requested_subtitles is False


def test_missing_requested_subtitles_and_placeholder_title_are_reported(tmp_path):
    staging = tmp_path / "task-1"
    main = staging / "media.mp4"
    staging.mkdir()
    main.write_bytes(b"content")
    info = _info(
        main,
        title="正在获取信息...",
        requested_subtitles={},
        thumbnail="",
        chapters=[],
    )
    plan = _video_plan(download_subtitles=True, subtitle_langs="en")

    result, _, _ = _download(tmp_path, FakeYDLFactory(info), plan=plan)

    assert result.source_facts.missing_requested_subtitles is True
    assert result.source_facts.selected_subtitle_languages == ()
    assert result.source_facts.thumbnail_available is False
    assert result.source_facts.chapters_available is False
    assert result.source_facts.title_available is False


def test_unrequested_selected_language_does_not_satisfy_explicit_language(tmp_path):
    staging = tmp_path / "task-1"
    main = staging / "media.mp4"
    french = staging / "media.fr.vtt"
    staging.mkdir()
    main.write_bytes(b"content")
    french.write_bytes(b"subtitle")
    info = _info(
        main,
        requested_subtitles={"fr": {"filepath": str(french)}},
    )
    plan = _video_plan(download_subtitles=True, subtitle_langs="en")

    result, _, _ = _download(tmp_path, FakeYDLFactory(info), plan=plan)

    assert result.source_facts.selected_subtitle_languages == ("fr",)
    assert result.source_facts.missing_requested_subtitles is True


def test_external_subtitle_outside_staging_is_rejected(tmp_path):
    staging = tmp_path / "task-1"
    main = staging / "media.mp4"
    outside = tmp_path / "outside.vtt"
    staging.mkdir()
    main.write_bytes(b"content")
    outside.write_bytes(b"subtitle")
    info = _info(
        main,
        requested_subtitles={"en": {"filepath": str(outside)}},
    )
    plan = _video_plan(download_subtitles=True)

    with pytest.raises(OutputVerificationFailed, match="成品无法验证"):
        _download(tmp_path, FakeYDLFactory(info), plan=plan)


def test_downloaded_this_run_uses_progress_or_pre_session_existence(tmp_path):
    staging = tmp_path / "task-1"
    preexisting = staging / "media.mp4"
    staging.mkdir()
    preexisting.write_bytes(b"old")
    existing_result, _, _ = _download(tmp_path, FakeYDLFactory(_info(preexisting)))

    staging2 = tmp_path / "new-task"
    created = staging2 / "media.mp4"

    def create_during_download(_ydl):
        created.write_bytes(b"new")
        return _info(created)

    factory = FakeYDLFactory(create_during_download)
    downloader = Downloader(ydl_factory=factory)
    new_result = downloader.download(
        "https://www.youtube.com/watch?v=abc",
        _video_plan(),
        toolchain=_toolchain(tmp_path),
        staging_dir=staging2,
    )

    assert existing_result.downloaded_this_run is False
    assert new_result.downloaded_this_run is True


def test_download_explicitly_enables_available_node_runtime(tmp_path, monkeypatch):
    staging = tmp_path / "task-1"
    main = staging / "media.mp4"
    staging.mkdir()
    main.write_bytes(b"media")
    monkeypatch.setattr(
        ytdlp_opts.shutil,
        "which",
        lambda name: r"C:\Program Files\nodejs\node.exe"
        if name in {"node", "node.exe"}
        else None,
    )
    factory = FakeYDLFactory(_info(main))

    _download(tmp_path, factory)

    assert factory.option_snapshots[0]["js_runtimes"] == {
        "node": {"path": r"C:\Program Files\nodejs\node.exe"},
    }


def test_cookie_materialization_and_cleanup_wrap_the_whole_download(tmp_path):
    staging = tmp_path / "task-1"
    main = staging / "media.mp4"
    staging.mkdir()
    main.write_bytes(b"media")
    plan = _video_plan(http_headers={"Cookie": "session=secret"})
    factory = FakeYDLFactory(_info(main))

    with patch(
        "src.core.downloader.apply_cookiefile_from_headers",
        return_value=str(tmp_path / "temporary-cookie.txt"),
    ) as materialize, patch("src.core.downloader.cleanup_cookiefile") as cleanup:
        _download(tmp_path, factory, plan=plan)

    materialize.assert_called_once()
    cleanup.assert_called_once_with(str(tmp_path / "temporary-cookie.txt"))


def test_download_error_callback_and_finished_callback_keep_their_roles(tmp_path):
    errors: list[str] = []
    finished = MagicMock()
    failing = Downloader(ydl_factory=FakeYDLFactory(RuntimeError("network down")))
    failing.set_callbacks(error=errors.append, finished=finished)

    with pytest.raises(DownloadError, match="network down"):
        failing.download(
            "https://example.com/v",
            _video_plan(url="https://example.com/v"),
            toolchain=_toolchain(tmp_path),
            staging_dir=tmp_path / "failed-task",
        )

    assert errors == ["network down"]
    finished.assert_not_called()

    staging = tmp_path / "successful-task"
    main = staging / "media.mp4"
    staging.mkdir()
    main.write_bytes(b"media")
    successful = Downloader(ydl_factory=FakeYDLFactory(_info(main)))
    successful.set_callbacks(finished=finished)
    successful.download(
        "https://example.com/v",
        _video_plan(url="https://example.com/v"),
        toolchain=_toolchain(tmp_path),
        staging_dir=staging,
    )

    finished.assert_called_once_with()


@pytest.mark.parametrize(
    "error",
    [
        pytest.param(DownloadCancelled("任务已取消"), id="typed"),
        pytest.param(RuntimeError("任务已暂停"), id="wrapped-text"),
    ],
)
def test_download_cancelled_propagates(tmp_path, error):
    downloader = Downloader(ydl_factory=FakeYDLFactory(error))

    with pytest.raises(DownloadCancelled):
        downloader.download(
            "https://example.com/v",
            _video_plan(url="https://example.com/v"),
            toolchain=_toolchain(tmp_path),
            staging_dir=tmp_path / "task-1",
        )


@pytest.mark.parametrize(
    "message",
    [
        "ERROR: [youtube] abc: Unable to download API page: timed out",
        "ERROR: unable to download video data: HTTP Error 403: Forbidden",
    ],
)
def test_download_retries_transient_youtube_failure_once(tmp_path, message):
    staging = tmp_path / "task-1"
    main = staging / "media.mp4"
    staging.mkdir()
    main.write_bytes(b"media")
    factory = FakeYDLFactory(RuntimeError(message), _info(main))

    result, _, _ = _download(tmp_path, factory)

    assert result.main_file == main.resolve()
    assert len(factory.instances) == 2


def test_twitter_fallback_reuses_plan_toolchain_and_staging(tmp_path):
    url = "https://x.com/user/status/123"
    staging = tmp_path / "task-1"
    main = staging / "media.mp4"
    staging.mkdir()
    main.write_bytes(b"media")
    factory = FakeYDLFactory(
        RuntimeError("extractor failed"),
        _info(main, title="signed-direct.mp4", extractor="generic", id="signed-direct"),
    )
    downloader = Downloader(ydl_factory=factory)
    plan = _video_plan(url=url, title="推文标题")
    fallback_info = VideoInfo(
        url=url,
        title="推文标题",
        thumbnail_url="https://pbs.twimg.com/cover.jpg",
        uploader="推文作者",
        duration=12,
        platform=Platform.TWITTER,
    )

    with patch(
        "src.core.downloader.resolve_twitter_media",
        return_value=(fallback_info, "https://video.twimg.com/direct.mp4"),
    ):
        result = downloader.download(
            url,
            plan,
            toolchain=_toolchain(tmp_path),
            staging_dir=staging,
        )

    assert result.main_file == main.resolve()
    assert result.rendered_leaf == "推文标题 [twitter-123].mp4"
    assert result.source_key == "twitter-123"
    assert result.info["title"] == "推文标题"
    assert result.info["thumbnail"] == "https://pbs.twimg.com/cover.jpg"
    assert result.info["uploader"] == "推文作者"
    assert result.info["duration"] == 12
    assert downloader.last_info is fallback_info
    assert factory.urls == [url, "https://video.twimg.com/direct.mp4"]
    assert factory.option_snapshots[0]["outtmpl"] == factory.option_snapshots[1]["outtmpl"]
    assert factory.option_snapshots[0]["postprocessors"] == (
        factory.option_snapshots[1]["postprocessors"]
    )
