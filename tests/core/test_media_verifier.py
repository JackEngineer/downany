from __future__ import annotations

import dataclasses
import json
import subprocess
from pathlib import Path
from unittest.mock import Mock

import pytest

from src.core.error_codes import OUTPUT_VERIFICATION_FAILED, OutputVerificationFailed
from src.core.media_verifier import (
    MAX_CAPTURE_BYTES,
    MediaVerification,
    VerificationExpectation,
    verify_media,
)
from src.core.output_contract import MediaKind

SAFE_MESSAGE = "成品无法验证，请导出诊断后重试"


def _payload(
    *,
    format_name: str = "mov,mp4,m4a,3gp,3g2,mj2",
    streams: list[dict] | None = None,
    format_tags: dict | None = None,
    chapters: list[dict] | None = None,
) -> bytes:
    return json.dumps(
        {
            "format": {
                "format_name": format_name,
                "tags": format_tags or {},
            },
            "streams": streams if streams is not None else [{"codec_type": "video"}],
            "chapters": chapters or [],
        }
    ).encode("utf-8")


def _completed(
    stdout: bytes,
    *,
    stderr: bytes = b"",
    returncode: int = 0,
) -> subprocess.CompletedProcess[bytes]:
    return subprocess.CompletedProcess([], returncode, stdout, stderr)


def _media_file(tmp_path: Path, name: str = "ready.mp4") -> Path:
    media = tmp_path / name
    media.write_bytes(b"media")
    return media


def _video_expectation(**overrides) -> VerificationExpectation:
    values = {
        "media_kind": MediaKind.VIDEO,
        "allowed_containers": frozenset({"mp4"}),
    }
    values.update(overrides)
    return VerificationExpectation(**values)


def _assert_safe_failure(exc: OutputVerificationFailed, media: Path, *secrets: str) -> None:
    assert str(exc) == SAFE_MESSAGE
    assert exc.error_code == OUTPUT_VERIFICATION_FAILED
    assert str(media.resolve()) not in str(exc)
    for secret in secrets:
        assert secret not in str(exc)


def test_verify_media_uses_fixed_ffprobe_contract(tmp_path):
    media = _media_file(tmp_path)
    run = Mock(return_value=_completed(_payload()))

    report = verify_media(
        media,
        Path("ffprobe"),
        _video_expectation(),
        run=run,
    )

    assert report.container == "mp4"
    assert run.call_args.args[0] == [
        "ffprobe",
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        "-show_chapters",
        str(media),
    ]
    assert run.call_args.kwargs == {
        "stdout": subprocess.PIPE,
        "stderr": subprocess.PIPE,
        "timeout": 15.0,
        "check": False,
        "shell": False,
    }


def test_verify_media_reports_optional_features_and_language_aliases(tmp_path):
    media = _media_file(tmp_path)
    run = Mock(
        return_value=_completed(
            _payload(
                streams=[
                    {"codec_type": "video", "tags": {}},
                    {"codec_type": "audio", "tags": {"title": "Main audio"}},
                    {"codec_type": "subtitle", "tags": {"language": "eng"}},
                    {"codec_type": "subtitle", "tags": {"language": "ZHO"}},
                    {
                        "codec_type": "video",
                        "disposition": {"attached_pic": 1},
                    },
                ],
                chapters=[{"id": 0}, {"id": 1}],
            )
        )
    )

    report = verify_media(
        media,
        Path("ffprobe"),
        _video_expectation(
            require_title=True,
            require_cover=True,
            require_chapters=True,
            embedded_subtitle_languages=("en-US", "zh-Hans"),
        ),
        run=run,
    )

    assert report == MediaVerification(
        container="mp4",
        stream_types=("video", "audio", "subtitle", "subtitle", "video"),
        subtitle_languages=("eng", "zho"),
        has_cover=True,
        has_title=True,
        chapter_count=2,
    )
    with pytest.raises(dataclasses.FrozenInstanceError):
        report.container = "mkv"


@pytest.mark.parametrize(
    ("name", "format_name", "kind", "streams", "allowed", "container"),
    [
        (
            "ready.mkv",
            "matroska,webm",
            MediaKind.VIDEO,
            [{"codec_type": "video"}],
            frozenset({"mkv"}),
            "mkv",
        ),
        (
            "ready.webm",
            "matroska,webm",
            MediaKind.VIDEO,
            [{"codec_type": "video"}],
            frozenset({"mkv"}),
            "mkv",
        ),
        (
            "ready.mp3",
            "mp3",
            MediaKind.AUDIO,
            [
                {"codec_type": "audio"},
                {"codec_type": "video", "disposition": {"attached_pic": 1}},
            ],
            frozenset({"mp3"}),
            "mp3",
        ),
    ],
)
def test_container_aliases_are_normalized(
    tmp_path,
    name,
    format_name,
    kind,
    streams,
    allowed,
    container,
):
    media = _media_file(tmp_path, name)

    report = verify_media(
        media,
        Path("ffprobe"),
        VerificationExpectation(kind, allowed),
        run=Mock(return_value=_completed(_payload(format_name=format_name, streams=streams))),
    )

    assert report.container == container


@pytest.mark.parametrize("state", ["missing", "directory", "empty"])
def test_invalid_input_file_fails_before_spawning_ffprobe(tmp_path, state):
    media = tmp_path / "ready.mp4"
    if state == "directory":
        media.mkdir()
    elif state == "empty":
        media.touch()
    run = Mock()

    with pytest.raises(OutputVerificationFailed) as caught:
        verify_media(media, Path("ffprobe"), _video_expectation(), run=run)

    _assert_safe_failure(caught.value, media)
    run.assert_not_called()


def test_nonzero_ffprobe_exit_hides_stderr_and_path(tmp_path):
    media = _media_file(tmp_path)
    secret = "PRIVATE_FFPROBE_OUTPUT"
    run = Mock(return_value=_completed(b"", stderr=secret.encode(), returncode=1))

    with pytest.raises(OutputVerificationFailed) as caught:
        verify_media(media, Path("ffprobe"), _video_expectation(), run=run)

    _assert_safe_failure(caught.value, media, secret)


def test_ffprobe_timeout_is_sanitized(tmp_path):
    media = _media_file(tmp_path)
    secret = "PRIVATE_TIMEOUT_OUTPUT"
    run = Mock(
        side_effect=subprocess.TimeoutExpired(
            ["ffprobe", str(media)],
            15,
            output=secret.encode(),
        )
    )

    with pytest.raises(OutputVerificationFailed) as caught:
        verify_media(media, Path("ffprobe"), _video_expectation(), run=run)

    _assert_safe_failure(caught.value, media, secret)


@pytest.mark.parametrize(
    ("stdout", "stderr"),
    [
        pytest.param(b"not-json PRIVATE_JSON_BODY", b"", id="malformed-json"),
        pytest.param(
            b"{" + b" " * MAX_CAPTURE_BYTES,
            b"",
            id="oversized-stdout",
        ),
        pytest.param(
            _payload(),
            b"x" * (MAX_CAPTURE_BYTES + 1),
            id="oversized-stderr",
        ),
    ],
)
def test_malformed_or_oversized_ffprobe_output_is_sanitized(tmp_path, stdout, stderr):
    media = _media_file(tmp_path)

    with pytest.raises(OutputVerificationFailed) as caught:
        verify_media(
            media,
            Path("ffprobe"),
            _video_expectation(),
            run=Mock(return_value=_completed(stdout, stderr=stderr)),
        )

    _assert_safe_failure(caught.value, media, "PRIVATE_JSON_BODY")


@pytest.mark.parametrize(
    ("name", "format_name", "expectation", "streams"),
    [
        (
            "ready.mp4",
            "mov,mp4,m4a,3gp,3g2,mj2",
            VerificationExpectation(MediaKind.VIDEO, frozenset({"mp4"})),
            [{"codec_type": "audio"}],
        ),
        (
            "ready.mp3",
            "mp3",
            VerificationExpectation(MediaKind.AUDIO, frozenset({"mp3"})),
            [{"codec_type": "video"}],
        ),
        (
            "ready.mp4",
            "mov,mp4,m4a,3gp,3g2,mj2",
            VerificationExpectation(MediaKind.VIDEO, frozenset({"mkv"})),
            [{"codec_type": "video"}],
        ),
        (
            "ready.mp4",
            "matroska,webm",
            VerificationExpectation(MediaKind.VIDEO, frozenset({"mp4"})),
            [{"codec_type": "video"}],
        ),
    ],
)
def test_stream_container_and_suffix_contract_failures_are_sanitized(
    tmp_path,
    name,
    format_name,
    expectation,
    streams,
):
    media = _media_file(tmp_path, name)

    with pytest.raises(OutputVerificationFailed) as caught:
        verify_media(
            media,
            Path("ffprobe"),
            expectation,
            run=Mock(
                return_value=_completed(
                    _payload(format_name=format_name, streams=streams)
                )
            ),
        )

    _assert_safe_failure(caught.value, media)


@pytest.mark.parametrize(
    "expectation",
    [
        pytest.param(_video_expectation(require_title=True), id="title"),
        pytest.param(_video_expectation(require_cover=True), id="cover"),
        pytest.param(_video_expectation(require_chapters=True), id="chapters"),
        pytest.param(
            _video_expectation(embedded_subtitle_languages=("en",)),
            id="subtitle-language",
        ),
    ],
)
def test_missing_requested_features_fail_verification(tmp_path, expectation):
    media = _media_file(tmp_path)

    with pytest.raises(OutputVerificationFailed) as caught:
        verify_media(
            media,
            Path("ffprobe"),
            expectation,
            run=Mock(return_value=_completed(_payload())),
        )

    _assert_safe_failure(caught.value, media)


@pytest.mark.parametrize("language", [None, "", "und"])
def test_untagged_or_undefined_subtitles_never_match_requested_language(
    tmp_path,
    language,
):
    media = _media_file(tmp_path)
    tags = {} if language is None else {"language": language}
    payload = _payload(
        streams=[
            {"codec_type": "video"},
            {"codec_type": "subtitle", "tags": tags},
        ]
    )

    with pytest.raises(OutputVerificationFailed) as caught:
        verify_media(
            media,
            Path("ffprobe"),
            _video_expectation(embedded_subtitle_languages=("en",)),
            run=Mock(return_value=_completed(payload)),
        )

    _assert_safe_failure(caught.value, media)
