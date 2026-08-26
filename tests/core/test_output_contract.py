from __future__ import annotations

import dataclasses
import hashlib

import pytest
import yt_dlp
from yt_dlp.postprocessor.ffmpeg import resolve_mapping

from src.core.download_task import DownloadOptions, DownloadTask, Platform, VideoInfo
from src.core.output_contract import (
    MediaKind,
    SubtitleMode,
    compile_output_plan,
)
from src.core.output_paths import stable_source_key


def make_task(
    *,
    url: str = "https://www.youtube.com/watch?v=abc123",
    title: str = "示例视频",
    platform: Platform = Platform.YOUTUBE,
    group_id: str = "",
    group_title: str = "",
    playlist_index: int = 0,
    **option_overrides,
) -> DownloadTask:
    options = DownloadOptions(**option_overrides)
    return DownloadTask(
        video_info=VideoInfo(url=url, title=title, platform=platform),
        options=options,
        group_id=group_id,
        group_title=group_title,
        playlist_index=playlist_index,
    )


def postprocessor_keys(plan) -> list[str]:
    return [str(item["key"]) for item in plan.postprocessors]


@pytest.mark.parametrize(
    ("download_subtitles", "embed_subs", "expected"),
    [
        (False, False, SubtitleMode.NONE),
        (True, False, SubtitleMode.EXTERNAL),
        (False, True, SubtitleMode.EMBEDDED),
        (True, True, SubtitleMode.BOTH),
    ],
)
def test_subtitle_modes(download_subtitles, embed_subs, expected):
    task = make_task(
        download_subtitles=download_subtitles,
        embed_subs=embed_subs,
    )

    plan = compile_output_plan(task)

    assert plan.subtitle_mode is expected


def test_postprocessors_have_product_order_and_exact_options():
    default_video = compile_output_plan(make_task())
    mp4_with_subs = compile_output_plan(
        make_task(postprocessing="mp4", download_subtitles=True, embed_subs=True)
    )
    mp3 = compile_output_plan(make_task(postprocessing="mp3"))

    assert postprocessor_keys(default_video) == [
        "FFmpegVideoRemuxer",
        "FFmpegMetadata",
        "EmbedThumbnail",
    ]
    assert dict(default_video.postprocessors[0]) == {
        "key": "FFmpegVideoRemuxer",
        "preferedformat": "mp4>mp4/mkv>mkv/webm>mkv/mov>mp4/m4v>mp4/mkv",
    }
    assert dict(default_video.postprocessors[1]) == {
        "key": "FFmpegMetadata",
        "add_metadata": True,
        "add_chapters": True,
        "add_infojson": False,
    }
    assert dict(default_video.postprocessors[2]) == {
        "key": "EmbedThumbnail",
        "already_have_thumbnail": False,
    }
    assert postprocessor_keys(mp4_with_subs) == [
        "FFmpegVideoConvertor",
        "FFmpegEmbedSubtitle",
        "FFmpegMetadata",
        "EmbedThumbnail",
    ]
    assert dict(mp4_with_subs.postprocessors[1]) == {
        "key": "FFmpegEmbedSubtitle",
        "already_have_subtitle": True,
    }
    assert postprocessor_keys(mp3) == [
        "FFmpegExtractAudio",
        "FFmpegMetadata",
        "EmbedThumbnail",
    ]
    assert dict(mp3.postprocessors[0]) == {
        "key": "FFmpegExtractAudio",
        "preferredcodec": "mp3",
        "preferredquality": "192",
    }


def test_media_kind_containers_and_required_tools_follow_requested_output():
    default_video = compile_output_plan(make_task())
    mp4 = compile_output_plan(make_task(postprocessing="mp4"))
    mp3 = compile_output_plan(make_task(audio_only=True))

    assert default_video.media_kind is MediaKind.VIDEO
    assert default_video.allowed_containers == frozenset({"mp4", "mkv"})
    assert mp4.allowed_containers == frozenset({"mp4"})
    assert mp3.media_kind is MediaKind.AUDIO
    assert mp3.allowed_containers == frozenset({"mp3"})
    assert all(
        plan.requires_ffmpeg and plan.requires_ffprobe
        for plan in (default_video, mp4, mp3)
    )


def test_default_video_plan_stream_copies_single_file_webm_into_mkv():
    plan = compile_output_plan(make_task())
    remuxer = dict(plan.postprocessors[0])

    assert remuxer["key"] == "FFmpegVideoRemuxer"
    assert resolve_mapping("webm", str(remuxer["preferedformat"])) == ("mkv", None)
    assert "FFmpegVideoConvertor" not in postprocessor_keys(plan)


def test_subtitle_languages_are_normalized_and_blank_omits_selector():
    blank = compile_output_plan(make_task(download_subtitles=True, subtitle_langs=""))
    explicit = compile_output_plan(
        make_task(
            download_subtitles=True,
            subtitle_langs=" zh-Hans, en, zh-Hans ",
        )
    )

    assert blank.requested_subtitle_languages == ()
    assert blank.ydl_options["writesubtitles"] is True
    assert blank.ydl_options["writeautomaticsub"] is True
    assert "subtitleslangs" not in blank.ydl_options
    assert explicit.requested_subtitle_languages == ("zh-Hans", "en")
    assert explicit.ydl_options["subtitleslangs"] == ("zh-Hans", "en")


def test_embedded_only_downloads_subtitles_without_retaining_external_files():
    plan = compile_output_plan(make_task(embed_subs=True, subtitle_langs="en"))

    assert plan.subtitle_mode is SubtitleMode.EMBEDDED
    assert plan.ydl_options["writesubtitles"] is True
    assert plan.ydl_options["writeautomaticsub"] is True
    assert dict(plan.postprocessors[1]) == {
        "key": "FFmpegEmbedSubtitle",
        "already_have_subtitle": False,
    }


@pytest.mark.parametrize(
    ("download_subtitles", "embed_subs"),
    [(False, True), (True, True)],
)
def test_mp3_downgrades_embedded_subtitles_to_external(
    download_subtitles,
    embed_subs,
):
    plan = compile_output_plan(
        make_task(
            postprocessing="mp3",
            download_subtitles=download_subtitles,
            embed_subs=embed_subs,
        )
    )

    assert plan.subtitle_mode is SubtitleMode.EXTERNAL
    assert "FFmpegEmbedSubtitle" not in postprocessor_keys(plan)
    assert plan.completion_note == "音频已下载，字幕已保存为独立文件"


def test_hidden_nonfunctional_options_are_not_compiled():
    task = make_task(
        download_sections="*10:00-12:00",
        sponsorblock_remove="sponsor,intro",
    )

    options = compile_output_plan(task).to_ydl_options()

    assert "download_sections" not in options
    assert "sponsorblock_remove" not in options


def test_video_selectors_are_mp4_first_and_direct_media_stays_permissive():
    best = compile_output_plan(make_task())
    limited = compile_output_plan(make_task(quality="720p"))
    direct = compile_output_plan(
        make_task(url="https://cdn.example.com/master.m3u8", platform=Platform.UNKNOWN)
    )
    selected_direct = compile_output_plan(
        make_task(
            url="https://cdn.example.com/master.m3u8",
            platform=Platform.UNKNOWN,
            format_id="hls-720",
        )
    )

    assert best.ydl_options["format"] == (
        "bestvideo[ext=mp4]+bestaudio[ext=m4a]/"
        "bestvideo+bestaudio/best[ext=mp4]/best"
    )
    assert best.ydl_options["merge_output_format"] == "mp4/mkv"
    assert all("height<=720" in branch for branch in limited.ydl_options["format"].split("/"))
    assert direct.ydl_options["format"] == "bestvideo+bestaudio/best"
    assert selected_direct.ydl_options["format"] == "hls-720"


def test_page_direct_custom_and_playlist_names_keep_stable_keys():
    page = compile_output_plan(make_task())
    direct_task = make_task(
        url="https://cdn.example.com/video.mp4?token=short-lived",
        title="捕获标题",
        platform=Platform.UNKNOWN,
    )
    direct = compile_output_plan(direct_task)
    custom = compile_output_plan(
        make_task(filename_template="%(uploader)s-%(title)s.%(ext)s")
    )
    keyed_custom = compile_output_plan(
        make_task(filename_template="%(extractor)s-%(id)s-%(title)s.%(ext)s")
    )
    group_id = "batch-not-hex"
    group_key = hashlib.sha256(group_id.encode("utf-8")).hexdigest()[:8]
    playlist = compile_output_plan(
        make_task(
            group_id=group_id,
            group_title=r"我的/列表",
            playlist_index=5,
        )
    )
    hex_playlist = compile_output_plan(
        make_task(
            group_id="ABCDEF0123456789",
            group_title="十六进制批次",
            playlist_index=1,
        )
    )

    assert page.source_key_template == "%(extractor)s-%(id)s"
    assert page.final_leaf_template == "%(title)s [%(extractor)s-%(id)s].%(ext)s"
    direct_key = stable_source_key(direct_task.video_info.url)
    assert direct.source_key_template == direct_key
    assert direct.final_leaf_template == f"%(title)s [{direct_key}].%(ext)s"
    assert custom.final_leaf_template == (
        "%(uploader)s-%(title)s [%(extractor)s-%(id)s].%(ext)s"
    )
    assert keyed_custom.final_leaf_template == (
        "%(extractor)s-%(id)s-%(title)s.%(ext)s"
    )
    assert playlist.final_leaf_template.startswith("005 - ")
    assert playlist.playlist_folder.endswith(f" [{group_key}]")
    assert "/" not in playlist.playlist_folder
    assert "\\" not in playlist.playlist_folder
    assert hex_playlist.playlist_folder.endswith(" [abcdef01]")


def test_network_and_download_settings_are_compiled_without_io(tmp_path):
    cookiefile = tmp_path / "not-created-yet.txt"
    task = make_task(
        speed_limit=4096,
        proxy="http://127.0.0.1:7890",
        http_headers={"Referer": "https://example.com/page"},
        cookies_from_browser="chrome",
        cookiefile=str(cookiefile),
        concurrent_fragments=8,
    )

    options = compile_output_plan(task).ydl_options

    assert options["ratelimit"] == 4096
    assert options["proxy"] == "http://127.0.0.1:7890"
    assert options["http_headers"]["Referer"] == "https://example.com/page"
    assert "User-Agent" in options["http_headers"]
    assert options["cookiesfrombrowser"] == ("chrome",)
    assert options["cookiefile"] == str(cookiefile)
    assert options["concurrent_fragment_downloads"] == 8


def test_output_plan_and_nested_values_are_immutable_but_copies_are_fresh():
    plan = compile_output_plan(
        make_task(http_headers={"Referer": "https://example.com/page"})
    )

    with pytest.raises(dataclasses.FrozenInstanceError):
        plan.media_kind = MediaKind.AUDIO
    with pytest.raises(TypeError):
        plan.ydl_options["format"] = "best"
    with pytest.raises(TypeError):
        plan.ydl_options["http_headers"]["Referer"] = "changed"
    with pytest.raises(TypeError):
        plan.postprocessors[0]["key"] = "changed"

    first = plan.to_ydl_options()
    second = plan.to_ydl_options()
    first["format"] = "worst"
    first["http_headers"]["Referer"] = "changed"
    first["postprocessors"][0]["key"] = "changed"

    assert second["format"] != "worst"
    assert second["http_headers"]["Referer"] == "https://example.com/page"
    assert second["postprocessors"][0]["key"] == "FFmpegVideoRemuxer"


def _subtitle_format(language: str) -> list[dict[str, str]]:
    return [{"ext": "vtt", "url": f"https://example.com/{language}.vtt"}]


@pytest.mark.parametrize(
    ("author", "automatic", "expected"),
    [
        (
            {"fr": _subtitle_format("fr"), "en": _subtitle_format("en-author")},
            {"en": _subtitle_format("en-auto")},
            "en",
        ),
        (
            {"fr": _subtitle_format("fr")},
            {"en": _subtitle_format("en-auto")},
            "en",
        ),
        (
            {"zh-Hans": _subtitle_format("zh"), "fr": _subtitle_format("fr")},
            {"ja": _subtitle_format("ja")},
            "zh-Hans",
        ),
        ({}, {"ja": _subtitle_format("ja"), "de": _subtitle_format("de")}, "ja"),
    ],
)
def test_pinned_ytdlp_blank_language_selects_one_subtitle_in_product_order(
    author,
    automatic,
    expected,
):
    assert yt_dlp.version.__version__ == "2026.07.04"
    ydl = yt_dlp.YoutubeDL(
        {
            "writesubtitles": True,
            "writeautomaticsub": True,
            "quiet": True,
            "no_warnings": True,
        }
    )

    selected = ydl.process_subtitles("fixture", author, automatic)

    assert selected is not None
    assert tuple(selected) == (expected,)
