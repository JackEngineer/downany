from __future__ import annotations

import hashlib
import os
import subprocess

import pytest

import src.core.output_paths as output_paths
from src.core.error_codes import OutputPathInvalid
from src.core.output_paths import (
    MAX_COMPONENT_UTF16,
    MAX_WINDOWS_PATH_UTF16,
    build_final_path_plan,
    safe_component,
    stable_source_key,
    truncate_utf16,
    utf16_units,
    validate_filename_template,
)
from src.core.url_normalizer import normalize_download_url


@pytest.mark.parametrize(
    "template",
    [
        "../%(title)s.%(ext)s",
        r"..\%(title)s.%(ext)s",
        r"C:\%(title)s.%(ext)s",
        r"C:%(title)s.%(ext)s",
        r"\\server\share\%(title)s.%(ext)s",
        "/tmp/%(title)s.%(ext)s",
        "bad\x00%(title)s.%(ext)s",
        ".",
        "..",
    ],
)
def test_template_is_a_leaf_on_every_host(template):
    with pytest.raises(OutputPathInvalid):
        validate_filename_template(template)


def test_template_requires_ext_and_rejects_unknown_fields():
    with pytest.raises(OutputPathInvalid):
        validate_filename_template("%(title)s")
    with pytest.raises(OutputPathInvalid):
        validate_filename_template("%(channel_id)s.%(ext)s")

    assert validate_filename_template("%(title)s [%(id)s].%(ext)s") == (
        "%(title)s [%(id)s].%(ext)s"
    )
    assert validate_filename_template("") == ""


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("CON.mp4", "_CON.mp4"),
        ("aux ", "_aux"),
        ("title..", "title"),
        (r"a/b\c", "a b c"),
        ("e\u0301", "é"),
        ("...", "video"),
    ],
)
def test_safe_component_is_windows_portable(raw, expected):
    assert safe_component(raw, fallback="video") == expected


def test_safe_component_truncates_by_utf16_without_splitting_surrogate_pairs():
    result = safe_component("😀" * 100 + ".mp4", fallback="video")

    assert utf16_units(result) == MAX_COMPONENT_UTF16
    assert result.endswith(".mp4")
    assert result.encode("utf-16-le").decode("utf-16-le") == result
    assert truncate_utf16("😀a", 2) == "😀"


def test_safe_component_preserves_product_prefixes_and_suffixes_when_truncated():
    filename = safe_component(
        "001 - " + "很长的标题" * 40 + " [youtube-abc123] (2).mp4",
        fallback="video",
    )
    folder = safe_component(
        "播放列表" * 40 + " [deadbeef]",
        fallback="playlist",
    )

    assert utf16_units(filename) <= MAX_COMPONENT_UTF16
    assert filename.startswith("001 - ")
    assert filename.endswith(" [youtube-abc123] (2).mp4")
    assert utf16_units(folder) <= MAX_COMPONENT_UTF16
    assert folder.endswith(" [deadbeef]")


def test_stable_source_key_prefers_extractor_id_and_hashes_normalized_urls():
    assert stable_source_key(
        "https://example.com/watch?v=ignored",
        extractor="youtube",
        media_id="abc123",
    ) == "youtube-abc123"

    malformed = "https://www.youtube.com/https://www.youtube.com/watch?v=abc123/path"
    normalized = normalize_download_url(malformed)
    expected = hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:8]
    assert stable_source_key(malformed) == f"url-{expected}"


def test_final_path_plan_keeps_one_stem_for_main_and_subtitles(tmp_path):
    plan = build_final_path_plan(
        tmp_path,
        "播放列表 [deadbeef]",
        "001 - " + "很长的标题" * 40 + " [youtube-abc123].mp4",
        "youtube-abc123",
        (("zh-Hans", "vtt"), ("en", "srt")),
        copy_index=2,
    )

    assert plan.root == tmp_path.resolve()
    assert plan.directory.name == "播放列表 [deadbeef]"
    assert plan.main_file.name.startswith("001 - ")
    assert plan.main_file.name.endswith(" [youtube-abc123] (2).mp4")
    assert [path.name for path in plan.subtitle_files] == [
        f"{plan.main_file.stem}.zh-Hans.vtt",
        f"{plan.main_file.stem}.en.srt",
    ]
    assert all(
        utf16_units(path.name) <= MAX_COMPONENT_UTF16
        for path in (plan.main_file, *plan.subtitle_files)
    )


def test_final_path_plan_sanitizes_untrusted_leaf_and_folder_into_root(tmp_path):
    plan = build_final_path_plan(
        tmp_path,
        "../outside",
        r"..\outside/clip.mp4",
        "url-deadbeef",
        (),
    )

    assert plan.root in plan.main_file.parents
    assert "/" not in plan.directory.name
    assert "\\" not in plan.directory.name
    assert "/" not in plan.main_file.name
    assert "\\" not in plan.main_file.name
    assert "url-deadbeef" in plan.main_file.stem


def test_final_path_plan_rejects_existing_playlist_symlink_escape(tmp_path):
    root = tmp_path / "root"
    outside = tmp_path / "outside"
    root.mkdir()
    outside.mkdir()
    try:
        (root / "escape").symlink_to(outside, target_is_directory=True)
    except OSError as exc:
        if os.name != "nt":
            pytest.skip(f"directory symlinks unavailable: {exc}")
        created = subprocess.run(
            ["cmd.exe", "/d", "/c", "mklink", "/J", str(root / "escape"), str(outside)],
            check=False,
            capture_output=True,
            text=True,
        )
        if created.returncode != 0:
            pytest.skip(f"directory links unavailable: {created.stderr.strip()}")

    with pytest.raises(OutputPathInvalid, match="超出下载位置"):
        build_final_path_plan(
            root,
            "escape",
            "clip [site-id].mp4",
            "site-id",
            (),
        )


def test_windows_path_budget_rejects_roots_with_less_than_forty_units(
    tmp_path,
    monkeypatch,
):
    monkeypatch.setattr(output_paths, "IS_WINDOWS", True)
    base = tmp_path.resolve()
    target_units = MAX_WINDOWS_PATH_UTF16 - 39
    padding = max(1, target_units - utf16_units(str(base)) - 1)
    long_root = base / ("r" * padding)

    with pytest.raises(OutputPathInvalid, match="下载位置过长"):
        build_final_path_plan(
            long_root,
            "",
            "clip [site-id].mp4",
            "site-id",
            (),
        )


def test_windows_path_budget_truncates_every_bundle_member_to_240_units(
    tmp_path,
    monkeypatch,
):
    monkeypatch.setattr(output_paths, "IS_WINDOWS", True)
    base = tmp_path.resolve()
    target_units = MAX_WINDOWS_PATH_UTF16 - 80
    padding = max(1, target_units - utf16_units(str(base)) - 1)
    long_root = base / ("r" * padding)

    plan = build_final_path_plan(
        long_root,
        "",
        "标题" * 100 + " [site-id].mp4",
        "site-id",
        (("zh-Hans", "vtt"),),
    )

    assert all(
        utf16_units(str(path)) <= MAX_WINDOWS_PATH_UTF16
        for path in (plan.main_file, *plan.subtitle_files)
    )
    assert plan.main_file.stem in plan.subtitle_files[0].name
